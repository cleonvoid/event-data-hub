import { Type } from "@google/genai";
import { config } from "../config.js";
import { getTextClient, parseJsonResponse, withRetry, isRateLimitCooldownActive } from "./client.js";
import { CANONICAL_FIELDS, type CanonicalField, type FieldMappingDetail, isCanonicalField } from "../types.js";
import { SEARCH_COLUMN_IDS, SEARCH_OPERATOR_IDS, type SearchColumnId, type SearchOperatorId } from "../search-schema.js";

const GEN_CONFIG = {
  temperature: 0.1,
};

// ---------------------------------------------------------------------------
// 1. Schema inference
// ---------------------------------------------------------------------------

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

function heuristicInferSchemaMapping(headers: string[]): Record<string, FieldMappingDetail> {
  const result: Record<string, FieldMappingDetail> = {};
  for (const h of headers) {
    const norm = h.toLowerCase().trim();
    if (/^(stt|no\.?|#|id|index)$/i.test(norm)) {
      result[h] = { canonical_field: "ignore", confidence: 0.99, reasoning: "Cột số thứ tự / mã định danh kỹ thuật" };
    } else if (/email|mail|thư điện tử/i.test(norm)) {
      result[h] = { canonical_field: "email", confidence: 0.95, reasoning: "Phát hiện địa chỉ email" };
    } else if (/phone|tel|mobile|điện thoại|dien thoai|sđt|sdt/i.test(norm)) {
      result[h] = { canonical_field: "phone", confidence: 0.95, reasoning: "Phát hiện số điện thoại" };
    } else if (/họ và tên|họ tên|ho ten|full name|name|tên/i.test(norm)) {
      result[h] = { canonical_field: "full_name", confidence: 0.95, reasoning: "Phát hiện họ và tên" };
    } else if (/công ty|cong ty|đơn vị|don vi|organization|company|tổ chức|viện|trường/i.test(norm)) {
      result[h] = { canonical_field: "organization", confidence: 0.9, reasoning: "Phát hiện cơ quan / đơn vị công tác" };
    } else if (/chức danh|chuc danh|chức vụ|role|title|job|vị trí/i.test(norm)) {
      result[h] = { canonical_field: "role_title", confidence: 0.9, reasoning: "Phát hiện chức danh / vai trò" };
    } else if (/sự kiện|su kien|event|hội thảo|hoi thao/i.test(norm)) {
      result[h] = { canonical_field: "event_name", confidence: 0.9, reasoning: "Phát hiện tên sự kiện" };
    } else if (/ngày|ngay|date|thời gian|thoi gian|time/i.test(norm)) {
      result[h] = { canonical_field: "event_date", confidence: 0.9, reasoning: "Phát hiện ngày tổ chức sự kiện" };
    } else if (/ghi chú|ghi chu|note|notes|thông tin khác/i.test(norm)) {
      result[h] = { canonical_field: "notes", confidence: 0.85, reasoning: "Phát hiện thông tin ghi chú" };
    } else {
      result[h] = { canonical_field: "ignore", confidence: 0.5, reasoning: "Chưa rõ mục đích cột" };
    }
  }
  return result;
}

export async function inferSchemaMapping(
  headers: string[],
  sampleRows: unknown[][],
): Promise<Record<string, FieldMappingDetail>> {
  if (!process.env.GEMINI_API_KEY || isRateLimitCooldownActive()) {
    return heuristicInferSchemaMapping(headers);
  }

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

Tên các cột nguồn: ${JSON.stringify(headers)}
Dữ liệu mẫu: ${JSON.stringify(sampleRows.slice(0, 5))}`;

  try {
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
      const target = isCanonicalField(m.canonical_field) ? m.canonical_field : "ignore";
      byColumn.set(col, {
        canonical_field: target,
        confidence: clamp01(m.confidence),
        reasoning:
          typeof m.reasoning === "string" && m.reasoning.trim()
            ? m.reasoning.trim()
            : `Ánh xạ sang "${target}".`,
      });
    }

    const out: Record<string, FieldMappingDetail> = {};
    for (const h of headers) {
      const direct = byColumn.get(h);
      if (direct) {
        out[h] = direct;
        continue;
      }
      const fuzzyKey = findFuzzy(byColumn.keys(), h);
      if (fuzzyKey) {
        out[h] = byColumn.get(fuzzyKey)!;
        continue;
      }
      out[h] = {
        canonical_field: "ignore",
        confidence: 0,
        reasoning: "Mô hình không trả về ánh xạ cho cột này; mặc định bỏ qua.",
      };
    }

    return out;
  } catch (err) {
    const reason = (err as Error)?.message || "";
    if (!/rate limit|cooldown|429|quota/i.test(reason)) {
      console.warn(`[gemini] inferSchemaMapping failed (${reason.slice(0, 100)}), using heuristic fallback.`);
    }
    return heuristicInferSchemaMapping(headers);
  }
}

function findFuzzy(keys: Iterable<string>, target: string): string | undefined {
  const norm = target.trim().toLowerCase();
  for (const k of keys) {
    if (k.trim().toLowerCase() === norm) return k;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 2. Merge adjudication (Stage 2)
// ---------------------------------------------------------------------------

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

function heuristicAdjudicate(
  record: MergeRecordInput,
  candidates: MergeEntityInput[],
): Map<string, MergeVerdict> {
  const out = new Map<string, MergeVerdict>();
  const recEmail = record.email.trim().toLowerCase();
  const recPhone = record.phone.replace(/\D/g, "");

  for (const c of candidates) {
    const candEmail = c.email.trim().toLowerCase();
    const candPhone = c.phone.replace(/\D/g, "");

    if (recEmail && candEmail && recEmail === candEmail) {
      out.set(c.id, {
        isSameEntity: true,
        confidence: 0.96,
        reasoning: `Trùng khớp chính xác email (${recEmail}).`,
      });
    } else if (recPhone && candPhone && recPhone.length >= 8 && recPhone === candPhone) {
      out.set(c.id, {
        isSameEntity: true,
        confidence: 0.94,
        reasoning: `Trùng khớp số điện thoại liên hệ (${record.phone}).`,
      });
    } else if (c.vectorSimilarity >= 0.9) {
      out.set(c.id, {
        isSameEntity: true,
        confidence: 0.85,
        reasoning: `Thông tin họ tên, chức danh và đơn vị trùng khớp cao (độ tương đồng vector ${(c.vectorSimilarity * 100).toFixed(0)}%).`,
      });
    } else {
      out.set(c.id, {
        isSameEntity: false,
        confidence: 0.75,
        reasoning: "Chưa đủ thông tin khẳng định là cùng một người.",
      });
    }
  }
  return out;
}

export async function adjudicateMergeBatch(
  record: MergeRecordInput,
  candidates: MergeEntityInput[],
): Promise<Map<string, MergeVerdict>> {
  if (candidates.length === 0) return new Map();

  if (!process.env.GEMINI_API_KEY || isRateLimitCooldownActive()) {
    return heuristicAdjudicate(record, candidates);
  }

  const candidateBlock = candidates
    .map(
      (c, i) => `[${i}]
- Tên: ${q(c.displayName)}
- Đơn vị: ${q(c.organization)}
- Chức danh: ${q(c.role)}
- Email: ${q(c.email)}
- Điện thoại: ${q(c.phone)}
- Độ tương đồng vector: ${c.vectorSimilarity.toFixed(3)}`,
    )
    .join("\n\n");

  const prompt = `Bạn là hệ thống phân giải trùng lặp thực thể (entity resolution) cho dữ liệu sự kiện Việt Nam.
Xác định với TỪNG ứng viên xem có phải CÙNG MỘT NGƯỜI với bản ghi nguồn hay không.

BẢN GHI NGUỒN MỚI:
- Tên: ${q(record.fullName)}
- Đơn vị: ${q(record.organization)}
- Chức danh: ${q(record.role)}
- Email: ${q(record.email)}
- Điện thoại: ${q(record.phone)}
- Sự kiện: ${q(record.eventName)}

CÁC THỰC THỂ CHUẨN ỨNG VIÊN:
${candidateBlock}`;

  try {
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
  } catch (err) {
    const reason = (err as Error)?.message || "";
    if (!/rate limit|cooldown|429|quota/i.test(reason)) {
      console.warn(`[gemini] adjudicateMergeBatch failed (${reason.slice(0, 100)}), using heuristic fallback.`);
    }
    return heuristicAdjudicate(record, candidates);
  }
}

// ---------------------------------------------------------------------------
// 3. Natural language -> structured filters
// ---------------------------------------------------------------------------

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
  const fallbackPlan: NlSearchPlan = {
    filters: [
      { column: "display_name", operator: "contains", value: userQuery.trim() },
      { column: "primary_organization", operator: "contains", value: userQuery.trim() },
      { column: "primary_role", operator: "contains", value: userQuery.trim() },
      { column: "event_name", operator: "contains", value: userQuery.trim() },
    ],
    logic: "OR",
    explanation: `Tìm kiếm từ khóa: "${userQuery.trim()}"`,
  };

  if (!process.env.GEMINI_API_KEY || isRateLimitCooldownActive()) {
    return fallbackPlan;
  }

  const prompt = `Bạn là bộ dịch câu hỏi tự nhiên (tiếng Việt hoặc tiếng Anh) sang bộ lọc dữ liệu có cấu trúc.
Người dùng đang tìm kiếm trong danh bạ thực thể chuẩn (cá nhân/tổ chức) tổng hợp từ các sự kiện.

Câu hỏi người dùng: ${q(userQuery)}`;

  try {
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

    const filters: NlSearchPlan["filters"] = [];
    for (const f of parsed.filters ?? []) {
      if (!isSearchColumn(f.column) || !isSearchOperator(f.operator)) continue;
      const value = f.value === null || f.value === undefined ? "" : String(f.value).trim();
      if (!value) continue;
      filters.push({ column: f.column, operator: f.operator, value });
    }

    if (filters.length === 0) return fallbackPlan;

    return {
      filters,
      logic: parsed.logic === "OR" ? "OR" : "AND",
      explanation:
        typeof parsed.explanation === "string" && parsed.explanation.trim()
          ? parsed.explanation.trim()
          : `Tìm kiếm cho: "${userQuery}"`,
    };
  } catch (err) {
    const reason = (err as Error)?.message || "";
    if (!/rate limit|cooldown|429|quota/i.test(reason)) {
      console.warn(`[gemini] translateNlSearch failed (${reason.slice(0, 100)}), using heuristic plan.`);
    }
    return fallbackPlan;
  }
}

function isSearchColumn(v: unknown): v is SearchColumnId {
  return typeof v === "string" && (SEARCH_COLUMN_IDS as readonly string[]).includes(v);
}

function isSearchOperator(v: unknown): v is SearchOperatorId {
  return typeof v === "string" && (SEARCH_OPERATOR_IDS as readonly string[]).includes(v);
}

function clamp01(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function q(s: string): string {
  return JSON.stringify(String(s ?? "").slice(0, 500));
}

export async function preflightModel(): Promise<{ ok: boolean; detail: string }> {
  if (!process.env.GEMINI_API_KEY) {
    return { ok: false, detail: "GEMINI_API_KEY not configured." };
  }
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
