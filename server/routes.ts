import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { config } from "./config.js";
import { currentUser, requireAuth } from "./auth.js";
import { isAiConfigured } from "./ai/client.js";
import { inferSchemaMapping, translateNlSearch } from "./ai/gemini.js";
import * as repo from "./repo.js";
import {
  GoogleApiError,
  MIME_GOOGLE_SHEET,
  listSpreadsheets,
  parseWorkbook,
  readDriveXlsx,
  readGoogleSheet,
} from "./google-workspace.js";
import { buildSearchPredicate, SEARCH_COLUMNS, SEARCH_OPERATORS } from "./search-schema.js";
import {
  ConflictError,
  NotFoundError,
  approveMerge,
  importAndResolve,
  rejectMerge,
} from "./resolution.js";
import { isCanonicalField } from "./types.js";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_IMPORT_ROWS = 5000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

/** Wraps an async handler so a rejected promise reaches the error middleware. */
function asyncRoute(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export const api = Router();

// ---------------------------------------------------------------------------
// Health / identity
// ---------------------------------------------------------------------------

api.get(
  "/health",
  asyncRoute(async (_req, res) => {
    res.json({
      status: "ok",
      authMode: config.auth.mode,
      aiConfigured: isAiConfigured(),
      geminiModel: config.gemini.model,
      embeddingModel: config.embeddings.model,
      embeddingProvider: config.embeddings.useVertex ? "vertex-ai" : "gemini-api",
    });
  }),
);

api.use(requireAuth);

api.get(
  "/me",
  asyncRoute(async (req, res) => {
    res.json(currentUser(req));
  }),
);

// ---------------------------------------------------------------------------
// Stats & sources
// ---------------------------------------------------------------------------

api.get(
  "/stats",
  asyncRoute(async (req, res) => {
    res.json(await repo.getStats(currentUser(req).organizationId));
  }),
);

api.get(
  "/sources",
  asyncRoute(async (req, res) => {
    res.json({ sources: await repo.listSources(currentUser(req).organizationId) });
  }),
);

// ---------------------------------------------------------------------------
// Google Drive browsing
// ---------------------------------------------------------------------------

/**
 * The Google OAuth access token is passed per-request in X-Google-Access-Token.
 * It is a different credential from the Firebase ID token: the ID token proves
 * who the user is to us, the access token authorises us to call Drive/Sheets as
 * them. It is never stored server-side.
 */
function googleAccessToken(req: Request): string {
  return req.header("x-google-access-token") ?? "";
}

api.get(
  "/drive/files",
  asyncRoute(async (req, res) => {
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const files = await listSpreadsheets(googleAccessToken(req), {
      search: search || undefined,
    });
    res.json({ files });
  }),
);

// ---------------------------------------------------------------------------
// Preview: read a sheet + propose a mapping (never imports)
// ---------------------------------------------------------------------------

interface PreviewPayload {
  sourceName: string;
  sourceType: "google_sheets" | "google_drive_xlsx" | "local_upload";
  externalFileId: string | null;
  sheetTitle: string;
  headers: string[];
  totalRows: number;
  sampleRows: string[][];
  rows: string[][];
  mapping: Record<string, { canonical_field: string; confidence: number; reasoning: string }>;
  mappingSource: "gemini" | "unavailable";
  mappingError?: string;
}

async function buildPreview(
  sourceName: string,
  sourceType: PreviewPayload["sourceType"],
  externalFileId: string | null,
  grid: { title: string; headers: string[]; rows: string[][] },
): Promise<PreviewPayload> {
  if (grid.headers.length === 0) {
    throw new HttpError(400, "Tệp không có dòng tiêu đề nào để phân tích");
  }
  if (grid.rows.length > MAX_IMPORT_ROWS) {
    throw new HttpError(
      413,
      `Tệp có ${grid.rows.length} dòng, vượt giới hạn ${MAX_IMPORT_ROWS} dòng mỗi lần nhập.`,
    );
  }

  const sampleRows = grid.rows.slice(0, 5);

  let mapping: PreviewPayload["mapping"] = {};
  let mappingSource: PreviewPayload["mappingSource"] = "gemini";
  let mappingError: string | undefined;

  try {
    mapping = await inferSchemaMapping(grid.headers, sampleRows);
  } catch (err) {
    // The mapping step is advisory — the user confirms it anyway. If Gemini is
    // unavailable we still show the confirmation UI with everything unmapped,
    // rather than blocking the import or silently guessing.
    mappingSource = "unavailable";
    mappingError = err instanceof Error ? err.message : String(err);
    mapping = Object.fromEntries(
      grid.headers.map((h) => [
        h,
        { canonical_field: "ignore", confidence: 0, reasoning: "Chưa có đề xuất từ Gemini" },
      ]),
    );
  }

  return {
    sourceName,
    sourceType,
    externalFileId,
    sheetTitle: grid.title,
    headers: grid.headers,
    totalRows: grid.rows.length,
    sampleRows,
    rows: grid.rows,
    mapping,
    mappingSource,
    mappingError,
  };
}

api.post(
  "/preview/upload",
  upload.single("file"),
  asyncRoute(async (req, res) => {
    if (!req.file) throw new HttpError(400, "Chưa chọn tệp để tải lên");
    const grid = parseWorkbook(req.file.buffer);
    res.json(await buildPreview(req.file.originalname, "local_upload", null, grid));
  }),
);

api.post(
  "/preview/drive",
  asyncRoute(async (req, res) => {
    const { fileId, mimeType, name } = req.body as {
      fileId?: string;
      mimeType?: string;
      name?: string;
    };
    if (!fileId) throw new HttpError(400, "Thiếu fileId");

    const token = googleAccessToken(req);
    const isNativeSheet = mimeType === MIME_GOOGLE_SHEET;
    const grid = isNativeSheet
      ? await readGoogleSheet(token, fileId)
      : await readDriveXlsx(token, fileId);

    res.json(
      await buildPreview(
        name || grid.title,
        isNativeSheet ? "google_sheets" : "google_drive_xlsx",
        fileId,
        grid,
      ),
    );
  }),
);

// ---------------------------------------------------------------------------
// Import (after the user confirms the mapping)
// ---------------------------------------------------------------------------

api.post(
  "/import/confirm",
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const body = req.body as {
      sourceName?: string;
      sourceType?: string;
      externalFileId?: string | null;
      headers?: unknown;
      rows?: unknown;
      mapping?: unknown;
    };

    const headers = Array.isArray(body.headers) ? body.headers.map((h) => String(h)) : [];
    const rows = Array.isArray(body.rows) ? (body.rows as unknown[][]) : [];
    const sourceType = body.sourceType;

    if (!body.sourceName) throw new HttpError(400, "Thiếu tên nguồn dữ liệu");
    if (headers.length === 0) throw new HttpError(400, "Thiếu danh sách cột tiêu đề");
    if (rows.length === 0) throw new HttpError(400, "Không có dòng dữ liệu nào để nhập");
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new HttpError(413, `Vượt giới hạn ${MAX_IMPORT_ROWS} dòng mỗi lần nhập`);
    }
    if (
      sourceType !== "google_sheets" &&
      sourceType !== "google_drive_xlsx" &&
      sourceType !== "local_upload"
    ) {
      throw new HttpError(400, "sourceType không hợp lệ");
    }

    // The confirmed mapping comes from the browser, so validate it here rather
    // than trusting that it still matches what Gemini proposed.
    const mapping: Record<string, string> = {};
    const rawMapping = (body.mapping ?? {}) as Record<string, unknown>;
    for (const header of headers) {
      const value = rawMapping[header];
      mapping[header] = isCanonicalField(value) ? value : "ignore";
    }
    if (!Object.values(mapping).some((v) => v !== "ignore")) {
      throw new HttpError(400, "Cần ánh xạ ít nhất một cột sang trường chuẩn");
    }

    const result = await importAndResolve({
      organizationId: user.organizationId,
      importedBy: user.email,
      sourceName: String(body.sourceName),
      sourceType,
      externalFileId: body.externalFileId ? String(body.externalFileId) : null,
      headers,
      rows,
      mapping,
    });

    res.json({
      status: "success",
      message:
        `Đã nhập ${result.importedRecords} bản ghi, tạo ${result.newEntities} thực thể ` +
        `và ${result.suggestionsCreated} gợi ý hợp nhất chờ duyệt.`,
      ...result,
    });
  }),
);

// ---------------------------------------------------------------------------
// Entities + natural-language search
// ---------------------------------------------------------------------------

api.get(
  "/entities",
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25) || 25));
    const offset = (page - 1) * limit;

    if (!q) {
      const { entities, total } = await repo.listEntities(user.organizationId, {
        limit,
        offset,
      });
      res.json({ entities, total, page, limit, explanation: null, filters: [], mode: "all" });
      return;
    }

    let plan;
    let mode: "gemini" | "keyword" = "gemini";
    try {
      plan = await translateNlSearch(q);
    } catch (err) {
      // Search must keep working without Gemini. Fall back to a plain keyword
      // scan across the text columns — same whitelist, same parameterisation.
      mode = "keyword";
      plan = {
        filters: (["display_name", "primary_organization", "primary_role", "primary_email"] as const).map(
          (column) => ({ column, operator: "contains" as const, value: q }),
        ),
        logic: "OR" as const,
        explanation:
          `Gemini không khả dụng (${err instanceof Error ? err.message.slice(0, 120) : "lỗi"}), ` +
          `đang tìm theo từ khóa "${q}".`,
      };
    }

    // $1 is organization_id, so model-derived parameters start at $2.
    const predicate = buildSearchPredicate(plan.filters, plan.logic, 2);

    const { entities, total } = await repo.listEntities(user.organizationId, {
      predicateSql: predicate.sql,
      predicateParams: predicate.params,
      limit,
      offset,
    });

    res.json({
      entities,
      total,
      page,
      limit,
      mode,
      explanation: plan.explanation,
      logic: plan.logic,
      filters: predicate.accepted.map((f) => ({
        column: f.column,
        columnLabel: SEARCH_COLUMNS[f.column].label,
        operator: f.operator,
        operatorLabel: SEARCH_OPERATORS[f.operator].label,
        value: f.value,
      })),
      rejectedFilters: predicate.rejected,
    });
  }),
);

api.get(
  "/entities/:id",
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const entity = await repo.getEntityById(user.organizationId, req.params.id);
    if (!entity) throw new HttpError(404, "Không tìm thấy thực thể");

    const records = await repo.getRawRecordsForEntity(user.organizationId, req.params.id);

    // Which canonical fields actually disagree across the merged records — this
    // is what the detail drawer highlights so a reviewer can spot a bad merge.
    const comparable = ["fullName", "organization", "roleTitle", "email", "phone"] as const;
    const differingFields = comparable.filter((field) => {
      const values = new Set(
        records.map((r) => (r[field] ?? "").toString().trim().toLowerCase()).filter(Boolean),
      );
      return values.size > 1;
    });

    res.json({ entity, records, differingFields });
  }),
);

// ---------------------------------------------------------------------------
// Merge review
// ---------------------------------------------------------------------------

api.get(
  "/merges",
  asyncRoute(async (req, res) => {
    const suggestions = await repo.listPendingSuggestions(currentUser(req).organizationId);
    res.json({ suggestions });
  }),
);

api.post(
  "/merges/:id/approve",
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const result = await approveMerge({
      organizationId: user.organizationId,
      suggestionId: req.params.id,
      decidedBy: user.email,
    });
    res.json({ status: "success", message: "Đã phê duyệt hợp nhất thực thể.", ...result });
  }),
);

api.post(
  "/merges/:id/reject",
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    await rejectMerge({
      organizationId: user.organizationId,
      suggestionId: req.params.id,
      decidedBy: user.email,
    });
    res.json({
      status: "success",
      message: "Đã từ chối gợi ý. Cặp bản ghi này sẽ không được đề xuất lại.",
    });
  }),
);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof GoogleApiError) {
    res.status(err.status === 401 || err.status === 403 ? err.status : 502).json({
      error: err.message,
      hint: "Kiểm tra Google OAuth scope cho Drive/Sheets (xem README).",
    });
    return;
  }
  if (err instanceof Error && err.message.includes("File too large")) {
    res.status(413).json({ error: `Tệp vượt quá ${MAX_UPLOAD_BYTES / 1024 / 1024}MB` });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error("[api] unhandled error:", err);
  res.status(500).json({ error: message });
}
