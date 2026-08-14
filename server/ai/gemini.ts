import { Type } from "@google/genai";
import { config } from "../config.js";
import { getTextClient, parseJsonResponse, withRetry } from "./client.js";
import { CANONICAL_FIELDS, type CanonicalField, type FieldMappingDetail, isCanonicalField } from "../types.js";
import { SEARCH_COLUMN_IDS, SEARCH_OPERATOR_IDS, type SearchColumnId, type SearchOperatorId } from "../search-schema.js";

/**
 * All three Gemini reasoning steps. Every one of them uses responseSchema
 * (structured output), not prose scraping, and every one of them re-validates
 * the model's output server-side afterwards — the schema constrains shape, but
 * we still treat the values as untrusted input.
 */

const GEN_CONFIG = {
  // Near-deterministic: these are classification/extraction tasks, not creative
  // ones, and a demo that returns different answers each run is not debuggable.
  temperature: 0.1,
};

// ---------------------------------------------------------------------------
// 1. Schema inference
// ---------------------------------------------------------------------------

/**
 * Returned as an ARRAY rather than an object keyed by column name. Gemini's
 * responseSchema follows the OpenAPI subset, which cannot express "object with
 * arbitrary string keys" — the earlier version declared `mappings` as a bare
 * Type.OBJECT with no properties, which constrained nothing at all. An array of
 * records with an enum-constrained canonical_field is genuinely enforced.
 */
const SCHEMA_MAPPING_RESPONSE = {
  type: Type.OBJECT,
  properties: {
    mappings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          source_column: { type: Type.STRING, description: "Tên cột nguồn, sao chép chính xác" },
          canonical_field: { type: Type.STRING, enum: [...CANONICAL_FIELDS] },
          confidence: { type: Type.NUMBER, description: "0.0 đến 1.0" },
          reasoning: { type: Type.STRING, description: "Lý do ngắn gọn bằng tiếng Việt" },
        },
        required: ["source_column", "canonical_field", "confidence", "reasoning"],
      },
    },
  },
  required: ["mappings"],
};

export async function inferSchemaMapping(
  headers: string[],
  sampleRows: unknown[][],
): Promise<Record<string, FieldMappingDetail>> {
  const prompt = `Bạn là chuyên gia chuẩn hóa dữ liệu sự kiện của một trung tâm đổi mới sáng tạo Việt Nam.

Nhiệm vụ: ánh xạ MỖI cột nguồn dưới đây sang đúng MỘT trường chuẩn.

Các trường chuẩn cho phép:
- "full_name": họ và tên cá nhân (người tham dự, diễn giả, chuyên gia)
- "organization": tên công ty, viện, trường, cơ quan, đơn vị công tác
- "role_title": chức danh, vị trí công tác, vai trò trong sự kiện
- "email": địa chỉ thư điện tử
- "phone": số điện thoại
- "event_name": tên sự kiện, hội thảo, lớp tập huấn
- "event_date": ngày/thời gian tổ chức
- "notes": ghi chú, thông tin bổ sung không thuộc các nhóm trên
- "ignore": cột vô nghĩa (số thứ tự, cột trống, cột kỹ thuật)

Quy tắc quan trọng:
1. Dùng CẢ tên cột VÀ dữ liệu mẫu để quyết định. Tên cột tiếng Việt thường viết tắt hoặc không dấu.
2. Cột số thứ tự ("STT", "No.", "#") luôn là "ignore".
3. Nếu nhiều cột cùng ánh xạ vào một trường, vẫn ánh xạ bình thường — người dùng sẽ tự điều chỉnh.
4. confidence phản ánh mức chắc chắn thật: đặt thấp (< 0.6) khi bạn phải đoán.
5. Trả về đúng ${headers.length} phần tử, mỗi cột nguồn một phần tử, theo thứ tự đã cho.

Tên các cột nguồn: ${JSON.stringify(headers)}
Dữ liệu mẫu (mỗi mảng là một dòng, cùng thứ tự cột): ${JSON.stringify(sampleRows.slice(0, 5))}`;

  const client = getTextClient();
  const response = await withRetry("inferSchemaMapping", () =>
    client.models.generateContent({
      model: config.gemini.model,
      contents: prompt,
      config: {
        ...GEN_CONFIG,
        responseMimeType: "application/json",
        responseSchema: SCHEMA_MAPPING_RESPONSE,
      },
    }),
  );

  const parsed = parseJsonResponse<{
    mappings?: { source_column?: string; canonical_field?: string; confidence?: number; reasoning?: string }[];
  }>(response.text, "inferSchemaMapping");

  const byColumn = new Map<string, FieldMappingDetail>();
  for (const m of parsed.mappings ?? []) {
    const col = typeof m.source_column === "string" ? m.source_column : "";
    if (!col) continue;
    byColumn.set(col, {
      canonical_field: isCanonicalField(m.canonical_field) ? m.canonical_field : "notes",
      confidence: clamp01(m.confidence),
      reasoning: typeof m.reasoning === "string" && m.reasoning ? m.reasoning : "Không có giải thích",
    });
  }

  // The model can skip or rename a column. Anchor the result to the real header
  // list so the confirmation UI always shows every column exactly once.
  const result: Record<string, FieldMappingDetail> = {};
  for (const h of headers) {
    result[h] =
      byColumn.get(h) ??
      findLoosely(byColumn, h) ?? {
        canonical_field: "ignore" as CanonicalField,
        confidence: 0,
        reasoning: "Mô hình không đề xuất được ánh xạ cho cột này — vui lòng chọn thủ công.",
      };
  }
  return result;
}

function findLoosely(
  map: Map<string, FieldMappingDetail>,
  header: string,
): FieldMappingDetail | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const target = norm(header);
  for (const [k, v] of map) if (norm(k) === target) return v;
  return undefined;
}

// ---------------------------------------------------------------------------
// 2. Merge adjudication (Stage 2)
// ---------------------------------------------------------------------------

/**
 * Verdicts come back as an array, one per candidate, from a SINGLE call.
 *
 * The earlier design made one Gemini request per (entity, record) pair, so a
 * 4-row file with 5 retrieved candidates each cost ~20 requests — enough to
 * exhaust the free tier's daily quota on one spreadsheet. Adjudicating a
 * record's whole shortlist in one request cuts that by the candidate count and
 * also gives the model useful context: it can see the alternatives and pick
 * between them rather than judging each in isolation.
 */
const MERGE_VERDICT_RESPONSE = {
  type: Type.OBJECT,
  properties: {
    verdicts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          candidate_index: { type: Type.INTEGER, description: "Số thứ tự ứng viên đã cho" },
          is_same_entity: { type: Type.BOOLEAN },
          confidence: { type: Type.NUMBER, description: "0.0 đến 1.0" },
          reasoning: { type: Type.STRING, description: "Một câu tiếng Việt nêu bằng chứng cụ thể" },
        },
        required: ["candidate_index", "is_same_entity", "confidence", "reasoning"],
      },
    },
  },
  required: ["verdicts"],
};

export interface MergeEntityInput {
  id: string;
  displayName: string;
  organization: string;
  role: string;
  email: string;
  phone: string;
  vectorSimilarity: number;
}

export interface MergeRecordInput {
  fullName: string;
  organization: string;
  role: string;
  email: string;
  phone: string;
  eventName: string;
}

export interface MergeVerdict {
  isSameEntity: boolean;
  confidence: number;
  reasoning: string;
}

/** One request per record; returns a verdict per candidate, keyed by entity id. */
export async function adjudicateMergeBatch(
  record: MergeRecordInput,
  candidates: MergeEntityInput[],
): Promise<Map<string, MergeVerdict>> {
  if (candidates.length === 0) return new Map();

  const candidateBlock = candidates
    .map(
      (c, i) => `[${i}]
- Tên: ${q(c.displayName)}
- Đơn vị: ${q(c.organization)}
- Chức danh: ${q(c.role)}
- Email: ${q(c.email)}
- Điện thoại: ${q(c.phone)}
- Độ tương đồng vector giai đoạn 1: ${c.vectorSimilarity.toFixed(3)}`,
    )
    .join("\n\n");

  const prompt = `Bạn là hệ thống phân giải trùng lặp thực thể (entity resolution) cho dữ liệu sự kiện Việt Nam.

Cho MỘT bản ghi nguồn mới và ${candidates.length} thực thể chuẩn ứng viên, hãy xác định với TỪNG ứng viên
xem có phải CÙNG MỘT NGƯỜI ngoài đời thực với bản ghi nguồn hay không.

BẢN GHI NGUỒN MỚI:
- Tên: ${q(record.fullName)}
- Đơn vị: ${q(record.organization)}
- Chức danh: ${q(record.role)}
- Email: ${q(record.email)}
- Điện thoại: ${q(record.phone)}
- Sự kiện: ${q(record.eventName)}

CÁC THỰC THỂ CHUẨN ỨNG VIÊN:
${candidateBlock}

Hướng dẫn đánh giá (theo đặc thù dữ liệu Việt Nam):
- Email trùng khớp hoàn toàn là bằng chứng RẤT MẠNH cho cùng một người.
- Số điện thoại trùng (bỏ qua khoảng trắng, +84 ≡ 0) là bằng chứng RẤT MẠNH.
- Biến thể tên hợp lệ: có/không dấu ("Trần Văn A" ≡ "Tran Van A"), viết tắt
  ("Nguyễn Văn Hoàng" ≡ "N. V. Hoàng"), có/không học hàm học vị ("PGS.TS.").
- Tên đơn vị viết tắt hoặc song ngữ ("Tập đoàn FPT" ≡ "FPT Corp") là bằng chứng vừa phải.
- CẢNH BÁO: tên phổ biến ở Việt Nam (Nguyễn Văn A, Trần Thị B) trùng nhau mà
  KHÔNG có email/điện thoại/đơn vị trùng thì KHÔNG đủ kết luận. Hãy trả về false.
- Cùng họ tên nhưng khác đơn vị VÀ khác email → nhiều khả năng là hai người khác nhau.
- Tối đa MỘT ứng viên được phép là true. Nếu nhiều ứng viên cùng giống, chọn ứng viên
  có bằng chứng mạnh nhất và đặt false cho các ứng viên còn lại.

Trả về đúng ${candidates.length} phần tử, mỗi ứng viên một phần tử, candidate_index khớp số trong ngoặc vuông.
confidence là mức chắc chắn của bạn về kết luận (dù kết luận là true hay false).
reasoning phải nêu bằng chứng cụ thể đã dùng, viết bằng tiếng Việt, tối đa 2 câu.`;

  const client = getTextClient();
  const response = await withRetry("adjudicateMergeBatch", () =>
    client.models.generateContent({
      model: config.gemini.model,
      contents: prompt,
      config: {
        ...GEN_CONFIG,
        responseMimeType: "application/json",
        responseSchema: MERGE_VERDICT_RESPONSE,
      },
    }),
  );

  const parsed = parseJsonResponse<{
    verdicts?: {
      candidate_index?: number;
      is_same_entity?: boolean;
      confidence?: number;
      reasoning?: string;
    }[];
  }>(response.text, "adjudicateMergeBatch");

  const out = new Map<string, MergeVerdict>();
  for (const v of parsed.verdicts ?? []) {
    const idx = typeof v.candidate_index === "number" ? v.candidate_index : NaN;
    const candidate = candidates[idx];
    // A hallucinated or out-of-range index is dropped rather than mapped onto
    // the wrong entity — a mis-keyed verdict would propose a nonsense merge.
    if (!candidate) continue;
    out.set(candidate.id, {
      isSameEntity: v.is_same_entity === true,
      confidence: clamp01(v.confidence),
      reasoning:
        typeof v.reasoning === "string" && v.reasoning.trim()
          ? v.reasoning.trim()
          : "Mô hình không nêu lý do.",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Natural language -> structured filters (NOT raw SQL)
// ---------------------------------------------------------------------------

/**
 * SAFETY MODEL — read before changing.
 *
 * The model never authors SQL. It returns a list of {column, operator, value}
 * triples where column and operator are constrained to enums *in the response
 * schema itself*, so the model cannot even emit an unlisted identifier. The
 * server then:
 *   1. re-validates every column/operator against the whitelist (schema
 *      enforcement is not a guarantee, so this is defence in depth),
 *   2. maps the column id to a fixed SQL expression from a lookup table — the
 *      model's string never reaches the query text,
 *   3. binds every value as a $n parameter.
 * There is no code path anywhere that concatenates model output into SQL.
 */
const NL_SEARCH_RESPONSE = {
  type: Type.OBJECT,
  properties: {
    filters: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          column: { type: Type.STRING, enum: [...SEARCH_COLUMN_IDS] },
          operator: { type: Type.STRING, enum: [...SEARCH_OPERATOR_IDS] },
          value: { type: Type.STRING, description: "Giá trị so sánh, luôn ở dạng chuỗi" },
        },
        required: ["column", "operator", "value"],
      },
    },
    logic: { type: Type.STRING, enum: ["AND", "OR"] },
    explanation: { type: Type.STRING, description: "Một câu tiếng Việt giải thích cách lọc" },
  },
  required: ["filters", "logic", "explanation"],
};

export interface NlSearchPlan {
  filters: { column: SearchColumnId; operator: SearchOperatorId; value: string }[];
  logic: "AND" | "OR";
  explanation: string;
}

export async function translateNlSearch(userQuery: string): Promise<NlSearchPlan> {
  const prompt = `Bạn là bộ dịch câu hỏi tự nhiên (tiếng Việt hoặc tiếng Anh) sang bộ lọc dữ liệu có cấu trúc.

Người dùng đang tìm kiếm trong danh bạ thực thể chuẩn (cá nhân/tổ chức) tổng hợp từ các sự kiện.

Các cột được phép lọc:
- "display_name": tên hiển thị của người/tổ chức
- "primary_organization": đơn vị công tác chính
- "primary_role": chức danh chính
- "primary_email": địa chỉ email
- "event_name": tên sự kiện mà thực thể đã tham gia
- "event_year": năm diễn ra sự kiện đã tham gia (số, ví dụ 2025)
- "event_count": số lượng sự kiện khác nhau đã tham gia (số)

Các toán tử được phép:
- "contains": chứa chuỗi con, không phân biệt hoa thường (dùng cho cột văn bản)
- "equals" / "not_equals": bằng / khác chính xác
- "gt" / "gte" / "lt" / "lte": lớn hơn / lớn hơn bằng / nhỏ hơn / nhỏ hơn bằng (chỉ dùng cho cột số)

Quy tắc:
1. Với cột văn bản hầu như luôn dùng "contains", trừ khi người dùng yêu cầu khớp chính xác.
2. Chỉ dùng gt/gte/lt/lte với "event_year" và "event_count".
3. "chuyên gia AI" → lọc primary_role contains "chuyên gia" và/hoặc contains "AI".
   Hãy tách thành nhiều bộ lọc khi hợp lý.
4. "năm 2025" → event_year equals "2025".
5. Nếu câu hỏi mơ hồ hoặc chỉ là một từ khóa, hãy tạo các bộ lọc "contains" trên
   display_name và primary_organization với logic "OR".
6. logic áp dụng cho TẤT CẢ các bộ lọc. Chọn "AND" khi các điều kiện phải cùng
   đúng, "OR" khi là tìm kiếm từ khóa rộng.
7. Không bao giờ để mảng filters rỗng.

Câu hỏi người dùng: ${q(userQuery)}`;

  const client = getTextClient();
  const response = await withRetry("translateNlSearch", () =>
    client.models.generateContent({
      model: config.gemini.model,
      contents: prompt,
      config: {
        ...GEN_CONFIG,
        responseMimeType: "application/json",
        responseSchema: NL_SEARCH_RESPONSE,
      },
    }),
  );

  const parsed = parseJsonResponse<{
    filters?: { column?: string; operator?: string; value?: unknown }[];
    logic?: string;
    explanation?: string;
  }>(response.text, "translateNlSearch");

  // Defence in depth: drop anything not on the whitelist even though the
  // response schema already constrained it.
  const filters: NlSearchPlan["filters"] = [];
  for (const f of parsed.filters ?? []) {
    if (!isSearchColumn(f.column) || !isSearchOperator(f.operator)) continue;
    const value = f.value === null || f.value === undefined ? "" : String(f.value).trim();
    if (!value) continue;
    filters.push({ column: f.column, operator: f.operator, value });
  }

  return {
    filters,
    logic: parsed.logic === "OR" ? "OR" : "AND",
    explanation:
      typeof parsed.explanation === "string" && parsed.explanation.trim()
        ? parsed.explanation.trim()
        : `Tìm kiếm cho: "${userQuery}"`,
  };
}

function isSearchColumn(v: unknown): v is SearchColumnId {
  return typeof v === "string" && (SEARCH_COLUMN_IDS as readonly string[]).includes(v);
}

function isSearchOperator(v: unknown): v is SearchOperatorId {
  return typeof v === "string" && (SEARCH_OPERATOR_IDS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------

function clamp01(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Quotes a value for prompt interpolation without letting it break the layout. */
function q(s: string): string {
  return JSON.stringify(String(s ?? "").slice(0, 500));
}

/**
 * One cheap call to confirm GEMINI_MODEL actually resolves. Model ids change
 * often; failing here at boot with a clear message beats a 404 mid-demo.
 */
export async function preflightModel(): Promise<{ ok: boolean; detail: string }> {
  try {
    const client = getTextClient();
    const response = await client.models.generateContent({
      model: config.gemini.model,
      contents: "Trả lời đúng một từ: OK",
      config: { temperature: 0, maxOutputTokens: 2000 },
    });
    return { ok: true, detail: (response.text ?? "").trim().slice(0, 40) || "(empty)" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
