import * as XLSX from "xlsx";

/**
 * Google Drive + Sheets clients.
 *
 * These call the real REST APIs with the signed-in user's OAuth access token,
 * which the browser obtains through the Firebase Google provider (scopes are
 * listed in README.md). There is deliberately no sample-data fallback: an
 * unconfigured or unauthorised call fails with a clear message rather than
 * quietly returning fake Vietnamese filenames that look like a working import.
 */

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

export const MIME_GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
export const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  iconLink?: string;
  owners?: string;
  sizeBytes?: number;
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

async function googleFetch(url: string, accessToken: string): Promise<Response> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detail = body.slice(0, 400);
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      /* non-JSON error body; the raw text is the best detail available */
    }
    throw new GoogleApiError(
      `Google API ${res.status}: ${detail || res.statusText}`,
      res.status,
    );
  }
  return res;
}

/**
 * Lists the user's spreadsheets. Paginates fully — the earlier version took only
 * the first page, so anyone with more than 100 files silently could not see the
 * rest of them.
 */
export async function listSpreadsheets(
  accessToken: string,
  opts: { pageLimit?: number; search?: string } = {},
): Promise<DriveFile[]> {
  if (!accessToken) {
    throw new GoogleApiError("Thiếu Google OAuth access token để truy cập Drive", 401);
  }

  const clauses = [
    `(mimeType='${MIME_GOOGLE_SHEET}' or mimeType='${MIME_XLSX}')`,
    "trashed=false",
  ];
  if (opts.search) {
    // Escaped for the Drive query language: single quotes and backslashes.
    const safe = opts.search.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    clauses.push(`name contains '${safe}'`);
  }

  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  const pageLimit = opts.pageLimit ?? 5;

  for (let page = 0; page < pageLimit; page++) {
    const params = new URLSearchParams({
      q: clauses.join(" and "),
      fields: "nextPageToken, files(id,name,mimeType,modifiedTime,iconLink,size,owners(displayName))",
      orderBy: "modifiedTime desc",
      pageSize: "100",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: "user",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await googleFetch(`${DRIVE_FILES}?${params}`, accessToken);
    const data = (await res.json()) as {
      nextPageToken?: string;
      files?: {
        id: string;
        name: string;
        mimeType: string;
        modifiedTime: string;
        iconLink?: string;
        size?: string;
        owners?: { displayName?: string }[];
      }[];
    };

    for (const f of data.files ?? []) {
      files.push({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime,
        iconLink: f.iconLink,
        owners: f.owners?.[0]?.displayName,
        sizeBytes: f.size ? Number(f.size) : undefined,
      });
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return files;
}

export interface SheetGrid {
  title: string;
  headers: string[];
  rows: string[][];
}

/** Reads a native Google Sheet's first tab through the Sheets API. */
export async function readGoogleSheet(
  accessToken: string,
  spreadsheetId: string,
): Promise<SheetGrid> {
  const metaRes = await googleFetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?fields=properties(title),sheets(properties(title,sheetId))`,
    accessToken,
  );
  const meta = (await metaRes.json()) as {
    properties?: { title?: string };
    sheets?: { properties?: { title?: string } }[];
  };

  const firstTab = meta.sheets?.[0]?.properties?.title;
  if (!firstTab) throw new GoogleApiError("Bảng tính không có trang tính nào", 400);

  const valuesRes = await googleFetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(firstTab)}` +
      // UNFORMATTED_VALUE keeps dates as Excel serial numbers, which
      // parseEventDate() handles precisely. FORMATTED_VALUE would hand us
      // locale-dependent strings instead.
      `?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
    accessToken,
  );
  const values = ((await valuesRes.json()) as { values?: unknown[][] }).values ?? [];

  return gridFromRows(meta.properties?.title ?? firstTab, values);
}

/** Downloads an .xlsx stored in Drive and parses it with the same code path as a local upload. */
export async function readDriveXlsx(
  accessToken: string,
  fileId: string,
): Promise<SheetGrid> {
  const res = await googleFetch(
    `${DRIVE_FILES}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    accessToken,
  );
  const buffer = Buffer.from(await res.arrayBuffer());
  return parseWorkbook(buffer);
}

/** Shared .xlsx/.csv parsing for local uploads and Drive downloads. */
export function parseWorkbook(buffer: Buffer): SheetGrid {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("Tệp không chứa trang tính nào");

  const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
    header: 1,
    blankrows: false,
    defval: "",
  });
  return gridFromRows(sheetName, rows);
}

function gridFromRows(title: string, rows: unknown[][]): SheetGrid {
  if (rows.length === 0) return { title, headers: [], rows: [] };

  const rawHeaders = (rows[0] ?? []).map((h) => String(h ?? "").trim());
  const width = Math.max(rawHeaders.length, ...rows.map((r) => r?.length ?? 0));

  // Blank and duplicate header cells both break a column->field mapping keyed by
  // header name, so they are given stable synthetic names here.
  const seen = new Map<string, number>();
  const headers: string[] = [];
  for (let i = 0; i < width; i++) {
    let name = rawHeaders[i] || `Cột ${i + 1}`;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count > 0) name = `${name} (${count + 1})`;
    headers.push(name);
  }

  const dataRows = rows
    .slice(1)
    .map((r) => Array.from({ length: width }, (_, i) => String(r?.[i] ?? "")))
    .filter((r) => r.some((cell) => cell.trim() !== ""));

  return { title, headers, rows: dataRows };
}
