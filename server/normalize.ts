/**
 * Text/value normalisation shared by import and entity resolution.
 *
 * Two different "normal forms" live here and they are not interchangeable:
 *  - normalizedIdentity()  — human-readable, diacritics INTACT, fed to the
 *    embedding model. Vietnamese diacritics carry meaning and the multilingual
 *    embedding model uses them, so stripping here would lose signal.
 *  - blockingKey()         — diacritics STRIPPED, punctuation removed, used for
 *    cheap exact-match candidate blocking where "Trần Văn A" must equal
 *    "Tran Van A".
 */

export function cleanCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/\s+/g, " ").trim();
}

/** Strips Vietnamese diacritics (and đ/Đ, which NFD does not decompose). */
export function stripDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/**
 * Vietnamese academic/professional title prefixes. These are extremely common in
 * this dataset ("PGS.TS. Nguyễn Văn Hoàng") and are pure noise for matching, so
 * they are stripped from blocking keys but left in the display name.
 */
const TITLE_PREFIX =
  /^(?:gs|pgs|ts|ths|th\.s|bs|ks|cn|ncs|prof|dr|mr|mrs|ms|ong|ba)\b[.\s]*/i;

export function stripTitles(name: string): string {
  let out = name.trim();
  // Repeat: "PGS.TS. Nguyen" has two stacked prefixes.
  for (let i = 0; i < 4; i++) {
    const next = out.replace(TITLE_PREFIX, "").trim();
    if (next === out) break;
    out = next;
  }
  return out || name.trim();
}

/** Lowercased, de-diacriticised, alphanumeric-only key for exact-match blocking. */
export function blockingKey(s: string): string {
  return stripDiacritics(stripTitles(cleanCell(s)))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeEmail(s: string): string {
  const v = cleanCell(s).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : "";
}

/** Digits only, so "0912 345 678" and "0912345678" compare equal. */
export function normalizePhone(s: string): string {
  const digits = cleanCell(s).replace(/[^\d+]/g, "");
  if (!digits) return "";
  // Vietnamese numbers show up as +84xxxxxxxxx and 0xxxxxxxxx interchangeably.
  return digits.replace(/^\+?84/, "0");
}

/**
 * The string that gets embedded. Per the brief: name + organization + role.
 * Email is deliberately excluded — it is handled by exact blocking instead,
 * where a typo comparison is far more reliable than cosine distance.
 */
export function normalizedIdentity(parts: {
  fullName?: string | null;
  organization?: string | null;
  roleTitle?: string | null;
}): string {
  const name = cleanCell(parts.fullName);
  const org = cleanCell(parts.organization);
  const role = cleanCell(parts.roleTitle);
  return [name, org, role].filter(Boolean).join(" | ") || name || "(không rõ)";
}

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30); // Excel's day 0, accounting for its 1900 leap-year bug

/**
 * Parses the wildly inconsistent date formats these spreadsheets contain.
 * Returns an ISO yyyy-mm-dd string, or null when the value is unusable —
 * null is stored alongside the untouched original in event_date_raw rather
 * than guessing.
 */
export function parseEventDate(input: unknown): string | null {
  if (input === null || input === undefined) return null;

  // Excel serial numbers arrive as numbers (or numeric strings) from xlsx.
  if (typeof input === "number" && Number.isFinite(input)) {
    return excelSerialToIso(input);
  }

  const raw = cleanCell(input);
  if (!raw) return null;

  if (/^\d{5}(\.\d+)?$/.test(raw)) {
    return excelSerialToIso(Number(raw));
  }

  // ISO: 2025-06-15 (optionally with a time component)
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (iso) return buildIso(+iso[1], +iso[2], +iso[3]);

  // d/m/yyyy or d-m-yyyy. Vietnamese convention is day-first, so 03/06/2025
  // is 3 June. When the first component is > 12 it is unambiguously the day;
  // when the SECOND is > 12 the file must actually be month-first, so we swap.
  const dmy = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (dmy) {
    let day = +dmy[1];
    let month = +dmy[2];
    let year = +dmy[3];
    if (year < 100) year += year < 70 ? 2000 : 1900;
    if (month > 12 && day <= 12) [day, month] = [month, day];
    return buildIso(year, month, day);
  }

  // "15 tháng 6 năm 2025" / "15 thang 6 2025"
  const vn = stripDiacritics(raw.toLowerCase()).match(
    /^(\d{1,2})\s*thang\s*(\d{1,2})\s*(?:nam\s*)?(\d{4})$/,
  );
  if (vn) return buildIso(+vn[3], +vn[2], +vn[1]);

  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    return buildIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  return null;
}

function excelSerialToIso(serial: number): string | null {
  if (serial < 1 || serial > 100_000) return null;
  const ms = EXCEL_EPOCH_UTC + Math.floor(serial) * 86_400_000;
  const d = new Date(ms);
  return buildIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function buildIso(year: number, month: number, day: number): string | null {
  if (!year || !month || !day) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1900 || year > 2200) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Rejects impossible dates like 31/02 that Date silently rolls over.
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
