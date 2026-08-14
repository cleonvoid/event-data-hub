/**
 * The whitelist that makes natural-language search safe.
 *
 * The language model chooses a `column` id and an `operator` id from these
 * lists. It never produces SQL. Each id maps to a FIXED SQL expression defined
 * here in source, so no model-authored string is ever concatenated into a query;
 * only bound $n parameters carry model-derived data.
 *
 * Adding a column here is the ONLY way to widen what search can reach.
 */

export type SearchColumnKind = "entity" | "event" | "aggregate";
export type SearchValueType = "text" | "number";

interface SearchColumnDef {
  kind: SearchColumnKind;
  /** Fixed SQL fragment. Never contains anything derived from user/model input. */
  sql: string;
  type: SearchValueType;
  label: string;
}

export const SEARCH_COLUMNS = {
  display_name: { kind: "entity", sql: "c.display_name", type: "text", label: "Tên hiển thị" },
  primary_organization: { kind: "entity", sql: "c.primary_organization", type: "text", label: "Đơn vị" },
  primary_role: { kind: "entity", sql: "c.primary_role", type: "text", label: "Chức danh" },
  primary_email: { kind: "entity", sql: "c.primary_email", type: "text", label: "Email" },
  event_name: { kind: "event", sql: "r.event_name", type: "text", label: "Tên sự kiện" },
  event_year: { kind: "event", sql: "EXTRACT(YEAR FROM r.event_date)", type: "number", label: "Năm sự kiện" },
  event_count: { kind: "aggregate", sql: "", type: "number", label: "Số sự kiện" },
} as const satisfies Record<string, SearchColumnDef>;

export type SearchColumnId = keyof typeof SEARCH_COLUMNS;
export const SEARCH_COLUMN_IDS = Object.keys(SEARCH_COLUMNS) as SearchColumnId[];

interface SearchOperatorDef {
  /** SQL comparison template; {col} and {param} are the only substitutions. */
  template: string;
  /** Which value types this operator may be used with. */
  allowed: SearchValueType[];
  label: string;
}

export const SEARCH_OPERATORS = {
  contains: { template: "{col} ILIKE {param}", allowed: ["text"], label: "chứa" },
  equals: { template: "{col} = {param}", allowed: ["text", "number"], label: "bằng" },
  not_equals: { template: "{col} <> {param}", allowed: ["text", "number"], label: "khác" },
  gt: { template: "{col} > {param}", allowed: ["number"], label: "lớn hơn" },
  gte: { template: "{col} >= {param}", allowed: ["number"], label: "từ" },
  lt: { template: "{col} < {param}", allowed: ["number"], label: "nhỏ hơn" },
  lte: { template: "{col} <= {param}", allowed: ["number"], label: "đến" },
} as const satisfies Record<string, SearchOperatorDef>;

export type SearchOperatorId = keyof typeof SEARCH_OPERATORS;
export const SEARCH_OPERATOR_IDS = Object.keys(SEARCH_OPERATORS) as SearchOperatorId[];

export interface ValidatedFilter {
  column: SearchColumnId;
  operator: SearchOperatorId;
  value: string;
}

export interface BuiltPredicate {
  /** SQL boolean expression, or null when no valid filter survived. */
  sql: string | null;
  params: (string | number)[];
  /** Filters that were dropped, with the reason — surfaced to the user. */
  rejected: { filter: unknown; reason: string }[];
  accepted: ValidatedFilter[];
}

/**
 * Turns model-proposed filters into a parameterised SQL predicate.
 *
 * @param filters    Untrusted, straight from the model.
 * @param logic      How to combine them.
 * @param startIndex First $n placeholder number to use (callers usually bind
 *                   organization_id as $1, so this is typically 2).
 */
export function buildSearchPredicate(
  filters: unknown[],
  logic: "AND" | "OR",
  startIndex: number,
): BuiltPredicate {
  const params: (string | number)[] = [];
  const clauses: string[] = [];
  const rejected: BuiltPredicate["rejected"] = [];
  const accepted: ValidatedFilter[] = [];
  let paramIndex = startIndex;

  for (const raw of filters) {
    const f = raw as { column?: unknown; operator?: unknown; value?: unknown };

    if (typeof f?.column !== "string" || !(f.column in SEARCH_COLUMNS)) {
      rejected.push({ filter: raw, reason: `Cột không nằm trong danh sách cho phép` });
      continue;
    }
    if (typeof f?.operator !== "string" || !(f.operator in SEARCH_OPERATORS)) {
      rejected.push({ filter: raw, reason: `Toán tử không nằm trong danh sách cho phép` });
      continue;
    }

    const columnId = f.column as SearchColumnId;
    const operatorId = f.operator as SearchOperatorId;
    const column: SearchColumnDef = SEARCH_COLUMNS[columnId];
    const operator: SearchOperatorDef = SEARCH_OPERATORS[operatorId];

    if (!operator.allowed.includes(column.type)) {
      rejected.push({
        filter: raw,
        reason: `Toán tử "${operatorId}" không dùng được với cột kiểu ${column.type}`,
      });
      continue;
    }

    const rawValue = f.value === null || f.value === undefined ? "" : String(f.value).trim();
    if (!rawValue) {
      rejected.push({ filter: raw, reason: "Giá trị rỗng" });
      continue;
    }

    let boundValue: string | number;
    if (column.type === "number") {
      const n = Number(rawValue);
      if (!Number.isFinite(n)) {
        rejected.push({ filter: raw, reason: `"${rawValue}" không phải là số` });
        continue;
      }
      boundValue = n;
    } else {
      // ILIKE wildcards are added here, server-side. Any % or _ the model
      // supplied is escaped first so it cannot widen the match itself.
      boundValue = operatorId === "contains" ? `%${escapeLike(rawValue)}%` : rawValue;
    }

    const placeholder = `$${paramIndex++}`;
    params.push(boundValue);
    accepted.push({ column: columnId, operator: operatorId, value: rawValue });

    const comparison = operator.template
      .replace("{col}", column.kind === "aggregate" ? eventCountSubquery() : column.sql)
      .replace("{param}", placeholder);

    // Event-scoped columns live on raw_records, one row per source appearance,
    // so they are wrapped in EXISTS against this entity's linked records.
    // Wrapping (rather than joining) keeps one output row per entity and lets
    // OR-combined predicates stay independent.
    clauses.push(
      column.kind === "event"
        ? `EXISTS (
             SELECT 1
             FROM raw_to_canonical l
             JOIN raw_records r ON r.id = l.raw_record_id
             WHERE l.canonical_entity_id = c.id AND ${comparison}
           )`
        : `(${comparison})`,
    );
  }

  return {
    sql: clauses.length ? clauses.join(`\n  ${logic} `) : null,
    params,
    rejected,
    accepted,
  };
}

/** Distinct events an entity appears in. Correlated to c.id from the outer query. */
export function eventCountSubquery(): string {
  return `(
    SELECT COUNT(DISTINCT r.event_name)
    FROM raw_to_canonical l
    JOIN raw_records r ON r.id = l.raw_record_id
    WHERE l.canonical_entity_id = c.id
      AND r.event_name IS NOT NULL AND r.event_name <> ''
  )`;
}

export function sourceFileCountSubquery(): string {
  return `(
    SELECT COUNT(DISTINCT r.source_id)
    FROM raw_to_canonical l
    JOIN raw_records r ON r.id = l.raw_record_id
    WHERE l.canonical_entity_id = c.id
  )`;
}

export function recordCountSubquery(): string {
  return `(
    SELECT COUNT(*)
    FROM raw_to_canonical l
    WHERE l.canonical_entity_id = c.id
  )`;
}

/** Escapes LIKE metacharacters so a model-supplied value cannot widen the match. */
function escapeLike(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}
