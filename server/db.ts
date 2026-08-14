import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

/**
 * pgvector note: we deliberately do NOT call pgvector's registerTypes() on pool
 * connect. That helper is async and the pg 'connect' event cannot await it, so
 * a query issued on a freshly-opened connection can race the registration.
 * Instead every vector parameter is passed as a string and cast in SQL with
 * `$n::vector`, and vectors read back are parsed with fromSql(). Deterministic,
 * no registration step, no race.
 */
export { toSql as vectorToSql, fromSql as vectorFromSql } from "pgvector";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  // A pooled connection died while idle. pg will discard it; log so it is not silent.
  console.error("[db] idle client error:", err.message);
});

export type QueryParam = string | number | boolean | null | Date | object;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly QueryParam[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}

/**
 * Whether the server's pgvector supports hnsw.iterative_scan (0.8.0+).
 *
 * Read from pg_extension rather than pg_settings: pgvector registers its GUCs in
 * the module's _PG_init, which Postgres runs lazily the first time a session
 * touches a vector type, so on a freshly-opened pooled connection the setting is
 * absent from pg_settings even when it is supported.
 */
let iterativeScan = false;

function versionAtLeast(version: string, major: number, minor: number): boolean {
  const parts = version.split(".");
  if (parts.length < 2) return false;
  const gotMajor = Number.parseInt(parts[0] ?? "", 10);
  const gotMinor = Number.parseInt(parts[1] ?? "", 10);
  if (Number.isNaN(gotMajor) || Number.isNaN(gotMinor)) return false;
  return gotMajor === major ? gotMinor >= minor : gotMajor > major;
}

async function detectIterativeScan(): Promise<void> {
  try {
    const res = await query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    const version = res.rows[0]?.extversion;
    if (!version) {
      console.log("[db] pgvector extension not found");
      return;
    }
    iterativeScan = versionAtLeast(version, 0, 8);
    console.log(
      iterativeScan
        ? `[db] pgvector ${version} — iterative scan enabled for candidate retrieval`
        : `[db] pgvector ${version} predates iterative scan (0.8.0+); using a wider ef_search`,
    );
  } catch (err) {
    console.error("[db] could not read pgvector version:", (err as Error).message);
  }
}

/**
 * Settings that widen an HNSW scan so quals pgvector can only apply afterwards
 * still leave usable candidates.
 *
 * Stage 1 filters by organization_id and by an anti-join against
 * merge_suggestions, neither of which the index can evaluate. pgvector applies
 * them to the ~ef_search tuples the approximate scan already chose, so in a
 * database with many tenants the nearest neighbours can all belong to other
 * organisations and be filtered away, returning nothing. Iterative scan keeps
 * pulling batches until enough rows survive; strict_order (not relaxed_order)
 * because the query pairs ORDER BY distance with LIMIT.
 */
function vectorScanSettings(): string[] {
  return iterativeScan
    ? ["SET LOCAL hnsw.iterative_scan = 'strict_order'", "SET LOCAL hnsw.ef_search = 100"]
    : ["SET LOCAL hnsw.ef_search = 400"];
}

/**
 * Runs an HNSW query with those settings applied. SET LOCAL needs a
 * transaction, so this owns one unless the caller passes a client that is
 * already inside one.
 */
export async function vectorScan<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly QueryParam[] = [],
  client?: Pick<pg.PoolClient, "query">,
): Promise<pg.QueryResult<T>> {
  if (client) {
    for (const stmt of vectorScanSettings()) await client.query(stmt);
    return client.query<T>(text, params as unknown[]);
  }

  const owned = await pool.connect();
  try {
    await owned.query("BEGIN");
    for (const stmt of vectorScanSettings()) await owned.query(stmt);
    const result = await owned.query<T>(text, params as unknown[]);
    await owned.query("COMMIT"); // read-only; COMMIT and ROLLBACK are equivalent here
    return result;
  } catch (err) {
    await owned.query("ROLLBACK").catch(() => {
      /* connection already broken; the throw below is the real error */
    });
    throw err;
  } finally {
    owned.release();
  }
}

/** Runs fn inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      /* connection already broken; the throw below is the real error */
    });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resolved from process.cwd(), NOT from import.meta.url: the production build
 * bundles this server to CJS (dist/server.cjs), where import.meta.url is empty
 * and would silently resolve the migrations directory to the filesystem root.
 * MIGRATIONS_DIR overrides it if the layout ever differs.
 */
function resolveMigrationsDir(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(process.cwd(), "migrations"),
    path.resolve(process.cwd(), "..", "migrations"),
  ].filter((p): p is string => Boolean(p));

  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  }
  throw new Error(
    `Could not find the migrations directory (looked in: ${candidates.join(", ")}). ` +
      `Set MIGRATIONS_DIR to its absolute path.`,
  );
}

/**
 * Applies any *.up.sql in migrations/ that has not run yet, in filename order,
 * each in its own transaction. golang-migrate naming is preserved so the Go app
 * and this one share the exact same files.
 */
export async function runMigrations(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = new Set(
    (await query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map(
      (r) => r.version,
    ),
  );

  const migrationsDir = resolveMigrationsDir();
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".up.sql"))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.up\.sql$/, "");
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    });
    console.log(`[db] applied migration ${version}`);
  }

  await detectIterativeScan();
}

export async function closePool(): Promise<void> {
  await pool.end();
}
