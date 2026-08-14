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
}

export async function closePool(): Promise<void> {
  await pool.end();
}
