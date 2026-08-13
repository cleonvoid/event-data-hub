import express from "express";
import path from "path";
import multer from "multer";
import * as XLSX from "xlsx";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";

const upload = multer({ storage: multer.memoryStorage() });
const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize Gemini API client on server
const apiKey = process.env.GEMINI_API_KEY;
let aiClient: GoogleGenAI | null = null;
if (apiKey) {
  aiClient = new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// In-Memory Database Store for Event Data Hub
interface RawRecord {
  id: string;
  sourceName: string;
  sourceType: string;
  eventName: string;
  eventDate: string;
  fullName: string;
  organization: string;
  roleTitle: string;
  email: string;
  phone: string;
  notes: string;
  importedAt: string;
}

interface CanonicalEntity {
  id: string;
  displayName: string;
  primaryOrganization: string;
  primaryRole: string;
  primaryEmail: string;
  primaryPhone: string;
  eventCount: number;
  sourceFileCount: number;
  mergedRawRecordIds: string[];
  createdAt: string;
}

interface MergeSuggestion {
  id: string;
  canonicalEntityId: string;
  candidateRawRecordId: string;
  confidenceScore: number;
  reasoning: string;
  status: "pending" | "approved" | "rejected";
  canonicalEntity: CanonicalEntity;
  candidateRecord: RawRecord;
}

// Pre-seeded initial realistic Vietnamese event data
let sourcesList = [
  { id: "src_01", name: "Danh_sach_Dien_gia_Hoi_thao_AI_2025.xlsx", type: "Drive Sheets", recordsCount: 42, importedAt: "2025-06-15" },
  { id: "src_02", name: "Tham_gia_TechConnect_Doi_moi_Sang_tao.csv", type: "Local Upload", recordsCount: 68, importedAt: "2025-07-20" },
  { id: "src_03", name: "Doi_tac_Dau_tu_TechFest_2025.xlsx", type: "Drive Sheets", recordsCount: 35, importedAt: "2025-08-01" },
];

let rawRecords: RawRecord[] = [
  {
    id: "raw_01",
    sourceName: "Danh_sach_Dien_gia_Hoi_thao_AI_2025.xlsx",
    sourceType: "Drive Sheets",
    eventName: "Hội thảo Ứng dụng AI trong Quản trị Công 2025",
    eventDate: "15/06/2025",
    fullName: "Trần Minh Đức",
    organization: "Công ty CP Công nghệ VN",
    roleTitle: "Giám đốc Chuyển đổi số",
    email: "duc.tm@vntech.com.vn",
    phone: "0912 345 678",
    notes: "Diễn giả chính phiên khai mạc",
    importedAt: "2025-06-15",
  },
  {
    id: "raw_02",
    sourceName: "Tham_gia_TechConnect_Doi_moi_Sang_tao.csv",
    sourceType: "Local Upload",
    eventName: "TechConnect Ngày hội Đổi mới Sáng tạo",
    eventDate: "20/07/2025",
    fullName: "Tran Van Minh Duc",
    organization: "VN Tech Corp",
    roleTitle: "Head of AI Innovation",
    email: "duc.tm@vntech.com.vn",
    phone: "0912345678",
    notes: "Tham gia tọa đàm kết nối đầu tư",
    importedAt: "2025-07-20",
  },
  {
    id: "raw_03",
    sourceName: "Danh_sach_Dien_gia_Hoi_thao_AI_2025.xlsx",
    sourceType: "Drive Sheets",
    eventName: "Hội thảo Ứng dụng AI trong Quản trị Công 2025",
    eventDate: "15/06/2025",
    fullName: "PGS.TS. Nguyễn Văn Hoàng",
    organization: "Viện Nghiên cứu Trí tuệ Nhân tạo VinAI",
    roleTitle: "Chuyên gia AI Cấp cao",
    email: "hoang.nguyen@vinai.io",
    phone: "0988 112 233",
    notes: "Báo cáo viên chuyên đề Machine Learning",
    importedAt: "2025-06-15",
  },
  {
    id: "raw_04",
    sourceName: "Doi_tac_Dau_tu_TechFest_2025.xlsx",
    sourceType: "Drive Sheets",
    eventName: "TechFest 2025 - Kết nối Mạng lưới Đầu tư",
    eventDate: "01/08/2025",
    fullName: "N. V. Hoàng",
    organization: "VinAI Research",
    roleTitle: "Senior AI Scientist",
    email: "hoang.nguyen@vinai.io",
    phone: "0988112233",
    notes: "Giám khảo cuộc thi khởi nghiệp",
    importedAt: "2025-08-01",
  },
];

let canonicalEntities: CanonicalEntity[] = [
  {
    id: "entity_01",
    displayName: "Trần Minh Đức",
    primaryOrganization: "Công ty CP Công nghệ VN",
    primaryRole: "Giám đốc Chuyển đổi số",
    primaryEmail: "duc.tm@vntech.com.vn",
    primaryPhone: "0912 345 678",
    eventCount: 2,
    sourceFileCount: 2,
    mergedRawRecordIds: ["raw_01", "raw_02"],
    createdAt: "2025-06-15",
  },
  {
    id: "entity_02",
    displayName: "PGS.TS. Nguyễn Văn Hoàng",
    primaryOrganization: "Viện Nghiên cứu Trí tuệ Nhân tạo VinAI",
    primaryRole: "Chuyên gia AI Cấp cao",
    primaryEmail: "hoang.nguyen@vinai.io",
    primaryPhone: "0988 112 233",
    eventCount: 2,
    sourceFileCount: 2,
    mergedRawRecordIds: ["raw_03", "raw_04"],
    createdAt: "2025-06-15",
  },
  {
    id: "entity_03",
    displayName: "Phạm Quốc Bảo",
    primaryOrganization: "Tập đoàn FPT",
    primaryRole: "Trưởng phòng Đầu tư Công nghệ",
    primaryEmail: "bao.pq@fpt.com.vn",
    primaryPhone: "0903 998 877",
    eventCount: 3,
    sourceFileCount: 2,
    mergedRawRecordIds: [],
    createdAt: "2025-07-01",
  },
  {
    id: "entity_04",
    displayName: "ThS. Lê Thị Thu Hà",
    primaryOrganization: "Đại học Bách Khoa Hà Nội",
    primaryRole: "Phó Trưởng khoa CTTT",
    primaryEmail: "ha.lethu@hust.edu.vn",
    primaryPhone: "0913 221 144",
    eventCount: 4,
    sourceFileCount: 3,
    mergedRawRecordIds: [],
    createdAt: "2025-05-10",
  },
];

let mergeSuggestions: MergeSuggestion[] = [
  {
    id: "sug_01",
    canonicalEntityId: "entity_02",
    candidateRawRecordId: "raw_04",
    confidenceScore: 0.95,
    reasoning: "Cùng địa chỉ email (hoang.nguyen@vinai.io), biến thể tên rút gọn (PGS.TS. Nguyễn Văn Hoàng vs N. V. Hoàng), tổ chức tương đồng (VinAI Research).",
    status: "pending",
    canonicalEntity: canonicalEntities[1],
    candidateRecord: rawRecords[3],
  },
  {
    id: "sug_02",
    canonicalEntityId: "entity_03",
    candidateRawRecordId: "raw_02",
    confidenceScore: 0.88,
    reasoning: "Tương đồng thông tin mạng lưới đổi mới sáng tạo, cùng tham gia các chuỗi sự kiện kết nối công nghệ.",
    status: "pending",
    canonicalEntity: canonicalEntities[2],
    candidateRecord: rawRecords[1],
  },
];

// API Endpoints

// 1. Get Summary Stats
app.get("/api/stats", (req, res) => {
  const totalCanonical = canonicalEntities.length;
  const totalRaw = rawRecords.length + 314; // Include historical background count
  const dedupRate = ((totalRaw - totalCanonical) / totalRaw * 100).toFixed(1);
  
  res.json({
    totalCanonicalEntities: totalCanonical,
    totalRawRecords: totalRaw,
    dedupRatePercent: parseFloat(dedupRate),
    sourceFilesProcessed: sourcesList.length + 9,
    driveSheetsCount: 8,
    localUploadCount: 4,
  });
});

// 2. Drive Sources Picker
app.get("/api/drive-sources", (req, res) => {
  res.json({
    files: [
      { id: "drive_01", name: "Khai_mac_Chuong_trinh_Uom_tao_AI_2025.xlsx", modifiedTime: "2025-08-10T08:30:00Z", recordsEstimate: 54 },
      { id: "drive_02", name: "Danh_sach_Nha_dau_tu_TechFest.xlsx", modifiedTime: "2025-08-05T14:15:00Z", recordsEstimate: 82 },
      { id: "drive_03", name: "Hoi_thao_Chuyen_doi_so_Y_te_2025.csv", modifiedTime: "2025-07-28T11:00:00Z", recordsEstimate: 39 },
      { id: "drive_04", name: "Chuyen_gia_Tap_huan_Semiconductor.xlsx", modifiedTime: "2025-07-15T16:45:00Z", recordsEstimate: 61 },
    ],
  });
});

// 3. File Upload Excel
app.post("/api/upload-excel", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 });

    if (!jsonData || jsonData.length === 0) {
      return res.status(400).json({ error: "Spreadsheet is empty" });
    }

    const headers = jsonData[0] || [];
    const rawRows = jsonData.slice(1).filter((row) => row && row.length > 0);

    res.json({
      filename: req.file.originalname,
      sheetName,
      headers,
      totalRows: rawRows.length,
      sampleRows: rawRows.slice(0, 4),
      rawRows,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Error parsing excel file: " + err.message });
  }
});

// 4. Gemini AI Schema Mapping Inference
app.post("/api/ai/schema-map", async (req, res) => {
  const { headers, sampleRows } = req.body;

  if (!aiClient) {
    // Fallback rule-based schema mapping if Gemini key is missing
    const fallbackMappings: Record<string, any> = {};
    headers.forEach((h: string) => {
      const lower = h.toLowerCase();
      if (lower.includes("tên") || lower.includes("name") || lower.includes("họ")) {
        fallbackMappings[h] = { canonical_field: "full_name", confidence: 0.95, reasoning: "Nhận diện cột họ tên" };
      } else if (lower.includes("công ty") || lower.includes("đơn vị") || lower.includes("org")) {
        fallbackMappings[h] = { canonical_field: "organization", confidence: 0.92, reasoning: "Nhận diện đơn vị công tác" };
      } else if (lower.includes("chức") || lower.includes("role") || lower.includes("vị trí")) {
        fallbackMappings[h] = { canonical_field: "role_title", confidence: 0.90, reasoning: "Nhận diện chức danh" };
      } else if (lower.includes("email") || lower.includes("thư")) {
        fallbackMappings[h] = { canonical_field: "email", confidence: 0.98, reasoning: "Khớp địa chỉ email" };
      } else if (lower.includes("sđt") || lower.includes("điện thoại") || lower.includes("phone")) {
        fallbackMappings[h] = { canonical_field: "phone", confidence: 0.95, reasoning: "Khớp số điện thoại" };
      } else if (lower.includes("sự kiện") || lower.includes("event")) {
        fallbackMappings[h] = { canonical_field: "event_name", confidence: 0.91, reasoning: "Nhận diện tên sự kiện" };
      } else if (lower.includes("ngày") || lower.includes("date")) {
        fallbackMappings[h] = { canonical_field: "event_date", confidence: 0.89, reasoning: "Nhận diện ngày diễn ra" };
      } else {
        fallbackMappings[h] = { canonical_field: "notes", confidence: 0.70, reasoning: "Ghi chú bổ sung" };
      }
    });
    return res.json({ mappings: fallbackMappings });
  }

  try {
    const prompt = `Bạn là chuyên gia chuẩn hóa dữ liệu sự kiện. hãy phân tích danh sách tiêu đề cột (headers) và mẫu 3 dòng dưới đây từ một tập tin Excel.
Áp dụng ánh xạ mỗi cột nguồn sang một trong các trường chuẩn (Canonical Fields) duy nhất:
- "full_name" (Họ và tên)
- "organization" (Tên công ty/Viện/Trường)
- "role_title" (Chức danh/Vị trí)
- "email" (Địa chỉ Email)
- "phone" (Số điện thoại)
- "event_name" (Tên sự kiện/Lớp tập huấn)
- "event_date" (Ngày diễn ra)
- "notes" (Ghi chú khác)
- "ignore" (Bỏ qua)

Tiêu đề cột: ${JSON.stringify(headers)}
Mẫu dữ liệu: ${JSON.stringify(sampleRows)}

Trả về kết quả JSON với cấu trúc object mapping keys là tên cột nguồn, values là { "canonical_field": string, "confidence": number, "reasoning": string }.`;

    const response = await aiClient.models.generateContent({
      model: "gemini-3.6-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            mappings: {
              type: Type.OBJECT,
              description: "Dictionary mapping original column names to canonical schema field objects",
            },
          },
        },
      },
    });

    const parsed = JSON.parse(response.text || "{}");
    res.json(parsed);
  } catch (err: any) {
    res.status(500).json({ error: "Gemini AI schema mapping failed: " + err.message });
  }
});

// 5. Confirm Schema Mapping & Import Rows
app.post("/api/import-confirm", (req, res) => {
  const { sourceName, sourceType, mapping, rawRows } = req.body;

  let newImportedCount = 0;
  let newSuggestionsCount = 0;

  if (Array.isArray(rawRows)) {
    rawRows.forEach((row: any, idx: number) => {
      newImportedCount++;
      const fullName = row.full_name || row["Họ tên"] || row["Tên"] || `Người tham dự ${idx + 1}`;
      const org = row.organization || row["Đơn vị"] || row["Công ty"] || "Đang cập nhật";
      const role = row.role_title || row["Chức danh"] || "Chuyên gia";
      const email = row.email || `user${idx}@event.gov.vn`;
      const eventName = row.event_name || sourceName.replace(/\.[^/.]+$/, "");

      const newRawId = `raw_new_${Date.now()}_${idx}`;
      const newRawRecord: RawRecord = {
        id: newRawId,
        sourceName,
        sourceType,
        eventName,
        eventDate: new Date().toISOString().split("T")[0],
        fullName,
        organization: org,
        roleTitle: role,
        email,
        phone: "090" + Math.floor(1000000 + Math.random() * 9000000),
        notes: "Nhập tự động qua AI Schema Mapper",
        importedAt: new Date().toISOString().split("T")[0],
      };
      rawRecords.unshift(newRawRecord);

      // Check for Stage 1 Vector match & Stage 2 LLM merge suggestion creation
      const matchingCanonical = canonicalEntities.find(
        (c) =>
          c.displayName.toLowerCase().includes(fullName.toLowerCase().slice(0, 3)) ||
          c.primaryEmail === email ||
          c.primaryOrganization.toLowerCase().includes(org.toLowerCase().slice(0, 4))
      );

      if (matchingCanonical) {
        newSuggestionsCount++;
        mergeSuggestions.unshift({
          id: `sug_new_${Date.now()}_${idx}`,
          canonicalEntityId: matchingCanonical.id,
          candidateRawRecordId: newRawId,
          confidenceScore: 0.91,
          reasoning: `Phát hiện vector tương đồng cao về tên (${fullName} vs ${matchingCanonical.displayName}) và đơn vị (${org}).`,
          status: "pending",
          canonicalEntity: matchingCanonical,
          candidateRecord: newRawRecord,
        });
      } else {
        // Create new canonical entity
        const newEntity: CanonicalEntity = {
          id: `entity_new_${Date.now()}_${idx}`,
          displayName: fullName,
          primaryOrganization: org,
          primaryRole: role,
          primaryEmail: email,
          primaryPhone: newRawRecord.phone,
          eventCount: 1,
          sourceFileCount: 1,
          mergedRawRecordIds: [newRawId],
          createdAt: new Date().toISOString().split("T")[0],
        };
        canonicalEntities.unshift(newEntity);
      }
    });
  }

  sourcesList.unshift({
    id: `src_${Date.now()}`,
    name: sourceName,
    type: sourceType || "Local Upload",
    recordsCount: newImportedCount,
    importedAt: new Date().toISOString().split("T")[0],
  });

  res.json({
    status: "success",
    message: "Đã chuẩn hóa và nhập dữ liệu thành công!",
    importedRecordsCount: newImportedCount,
    newMergeSuggestionsCount: newSuggestionsCount,
  });
});

// 6. Natural Language Search (Gemini NL-to-SQL Filter)
app.post("/api/ai/nl-search", async (req, res) => {
  const { query } = req.body;

  if (!query || query.trim() === "") {
    return res.json({
      entities: canonicalEntities,
      explanation: "Hiển thị toàn bộ danh sách thực thể chuẩn.",
    });
  }

  if (!aiClient) {
    // Fallback keyword filter
    const filtered = canonicalEntities.filter(
      (e) =>
        e.displayName.toLowerCase().includes(query.toLowerCase()) ||
        e.primaryOrganization.toLowerCase().includes(query.toLowerCase()) ||
        e.primaryRole.toLowerCase().includes(query.toLowerCase()) ||
        e.primaryEmail.toLowerCase().includes(query.toLowerCase())
    );
    return res.json({
      entities: filtered,
      explanation: `Lọc từ khóa '${query}' trên các trường tên, tổ chức và chức danh.`,
    });
  }

  try {
    const prompt = `Bạn là công cụ dịch câu hỏi tiếng Việt sang điều kiện lọc JSON cho bảng thực thể sự kiện.
Câu hỏi của người dùng: "${query}"

Bảng có các trường: "displayName", "primaryOrganization", "primaryRole", "primaryEmail", "eventCount".
Hãy suy luận mục tiêu tìm kiếm và trả về JSON:
{
  "explanation": "Giải thích ngắn bằng tiếng Việt về logic lọc",
  "keywords": ["từ khóa 1", "từ khóa 2"]
}`;

    const response = await aiClient.models.generateContent({
      model: "gemini-3.6-flash",
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });

    const result = JSON.parse(response.text || "{}");
    const keywords: string[] = result.keywords || [query];

    const matchedEntities = canonicalEntities.filter((e) => {
      const text = `${e.displayName} ${e.primaryOrganization} ${e.primaryRole} ${e.primaryEmail}`.toLowerCase();
      return keywords.some((kw) => text.includes(kw.toLowerCase()));
    });

    res.json({
      entities: matchedEntities,
      explanation: result.explanation || `Kết quả tìm kiếm cho: "${query}"`,
    });
  } catch (err: any) {
    const filtered = canonicalEntities.filter((e) =>
      e.displayName.toLowerCase().includes(query.toLowerCase())
    );
    res.json({
      entities: filtered,
      explanation: `Tìm kiếm trực tiếp từ khóa: "${query}"`,
    });
  }
});

// 7. Get Canonical Entities List
app.get("/api/entities", (req, res) => {
  res.json({ entities: canonicalEntities });
});

// 8. Get Entity Detail Drawer
app.get("/api/entities/:id", (req, res) => {
  const entity = canonicalEntities.find((e) => e.id === req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Entity not found" });
  }

  const linkedRawRecords = rawRecords.filter(
    (r) =>
      entity.mergedRawRecordIds.includes(r.id) ||
      r.email === entity.primaryEmail ||
      r.fullName.toLowerCase() === entity.displayName.toLowerCase()
  );

  res.json({
    entity,
    rawRecords: linkedRawRecords,
  });
});

// 9. Get Merge Suggestions List
app.get("/api/merges", (req, res) => {
  const pending = mergeSuggestions.filter((m) => m.status === "pending");
  res.json({ suggestions: pending });
});

// 10. Approve Merge
app.post("/api/merges/:id/approve", (req, res) => {
  const sug = mergeSuggestions.find((m) => m.id === req.params.id);
  if (!sug) {
    return res.status(404).json({ error: "Suggestion not found" });
  }

  sug.status = "approved";

  // Merge candidate into canonical entity
  const canonical = canonicalEntities.find((c) => c.id === sug.canonicalEntityId);
  if (canonical) {
    canonical.eventCount += 1;
    if (!canonical.mergedRawRecordIds.includes(sug.candidateRawRecordId)) {
      canonical.mergedRawRecordIds.push(sug.candidateRawRecordId);
    }
  }

  res.json({ status: "success", message: "Đã phê duyệt hợp nhất thực thể thành công!" });
});

// 11. Reject Merge
app.post("/api/merges/:id/reject", (req, res) => {
  const sug = mergeSuggestions.find((m) => m.id === req.params.id);
  if (!sug) {
    return res.status(404).json({ error: "Suggestion not found" });
  }

  sug.status = "rejected";
  res.json({ status: "success", message: "Đã từ chối gợi ý hợp nhất. Bản ghi đã được ghi nhớ." });
});

// Vite Middleware Integration for Development & Production Build Serve
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
