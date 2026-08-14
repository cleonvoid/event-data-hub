import "dotenv/config";

/**
 * Central env config. Nothing in this project reads process.env directly outside
 * this file, so the full set of required variables is visible in one place.
 */

function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export const config = {
  port: 3000,

  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://postgres:postgrespassword@localhost:5433/event_data_hub",

  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    /**
     * Model id is configurable because Gemini model names move fast. If this id
     * 404s, the startup preflight in server.ts prints the failure and tells you
     * to override GEMINI_MODEL — it does not silently fall back.
     */
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
  },

  embeddings: {
    model: process.env.EMBEDDING_MODEL ?? "gemini-embedding-001",
    /** Must match the VECTOR(n) width in migrations/000001_init.up.sql. */
    dimensions: Number(process.env.EMBEDDING_DIM ?? 768),
    /**
     * Vertex AI is the target for deployment (it is what the brief asks for and
     * what Cloud Run gets via ADC). The Gemini Developer API exposes the same
     * embedding models behind an API key, which is what makes local dev possible
     * without a GCP project. Same model, same vectors, different front door.
     */
    useVertex: bool(process.env.USE_VERTEX_EMBEDDINGS, false),
    project: process.env.GOOGLE_CLOUD_PROJECT ?? "",
    location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
  },

  auth: {
    /**
     * 'firebase' verifies real Firebase ID tokens.
     * 'dev'      skips verification and pins every request to devOrgId.
     * Dev mode refuses to start when NODE_ENV=production (see auth.ts).
     */
    mode: (process.env.AUTH_MODE ?? "dev") as "firebase" | "dev",
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? "",
    devOrgId: process.env.DEV_ORG_ID ?? "org_local_dev",
    devEmail: process.env.DEV_EMAIL ?? "dev@localhost",
  },

  resolution: {
    /** Stage 1: how many canonical entities to retrieve per new raw record. */
    topN: Number(process.env.RESOLUTION_TOP_N ?? 5),
    /**
     * Stage 1 floor. Below this cosine similarity a candidate is not worth
     * spending a Gemini call on.
     *
     * 0.89 is measured, not guessed. On the seed corpus, embeddings of
     * "name | organization | role" put UNRELATED Vietnamese people at
     * 0.804–0.880 (these strings are structurally near-identical, so the
     * similarity range is compressed and a naive 0.5 floor admits everything),
     * while true name variants land at 0.909–0.940:
     *     "PGS.TS. Nguyễn Văn Hoàng" vs "N. V. Hoàng"        → 0.940
     *     "Phạm Quốc Bảo"            vs "Pham Quoc Bao"      → 0.939
     *     "Trần Minh Đức"            vs "Tran Van Minh Duc"  → 0.909
     * 0.89 sits in the gap. Raising it is safe because exact email/phone
     * blocking runs in parallel and ignores this floor entirely, so the
     * strongest evidence never depends on the cosine score.
     *
     * Re-measure on your own data before changing it.
     */
    minVectorSimilarity: Number(process.env.RESOLUTION_MIN_SIMILARITY ?? 0.89),
    /** Below this combined score we do not even show the suggestion. */
    minCombinedConfidence: Number(process.env.RESOLUTION_MIN_COMBINED ?? 0.5),
  },

  isProduction: process.env.NODE_ENV === "production",
};

export type AppConfig = typeof config;
