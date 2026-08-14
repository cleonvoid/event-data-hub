import { config } from "../config.js";
import { getEmbedClient, withRetry, isRateLimitCooldownActive } from "./client.js";

/**
 * Vertex AI / Gemini text embeddings for Stage 1 candidate retrieval.
 */

const BATCH_SIZE = 16;

function fallbackPseudoEmbedding(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  const normalized = text.toLowerCase().trim();
  if (!normalized) {
    vec[0] = 1;
    return vec;
  }
  for (let i = 0; i < normalized.length; i++) {
    const charCode = normalized.charCodeAt(i);
    const pos = (charCode * 31 + i * 17) % dim;
    vec[pos] += 1;
    if (i + 1 < normalized.length) {
      const bi = (charCode * 37 + normalized.charCodeAt(i + 1) * 43) % dim;
      vec[bi] += 1.5;
    }
  }
  return normalize(vec);
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  if (!process.env.GEMINI_API_KEY || isRateLimitCooldownActive()) {
    return texts.map((t) => fallbackPseudoEmbedding(t, config.embeddings.dimensions));
  }

  try {
    const client = getEmbedClient();
    const out: number[][] = [];

    const batchSize =
      config.embeddings.useVertex && config.embeddings.model === "gemini-embedding-001"
        ? 1
        : BATCH_SIZE;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      const response = await withRetry(`embedTexts[${i}..${i + batch.length})`, () =>
        client.models.embedContent({
          model: config.embeddings.model,
          contents: batch,
          config: {
            outputDimensionality: config.embeddings.dimensions,
            taskType: "SEMANTIC_SIMILARITY",
          },
        }),
      );

      const embeddings = response.embeddings ?? [];
      if (embeddings.length !== batch.length) {
        throw new Error(
          `embedding batch size mismatch: sent ${batch.length} texts, got ${embeddings.length} vectors`,
        );
      }

      for (const e of embeddings) {
        const values = e.values;
        if (!values || values.length === 0) {
          throw new Error("embedding API returned an empty vector");
        }
        if (values.length !== config.embeddings.dimensions) {
          throw new Error(
            `embedding dimension mismatch: model returned ${values.length}, ` +
              `schema expects VECTOR(${config.embeddings.dimensions}).`,
          );
        }
        out.push(normalize(values));
      }
    }

    return out;
  } catch (err) {
    console.warn(
      `[embeddings] API failed: ${(err as Error).message}. Using deterministic embedding fallback.`,
    );
    return texts.map((t) => fallbackPseudoEmbedding(t, config.embeddings.dimensions));
  }
}

export async function embedOne(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text]);
  return vec;
}

export function normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const mag = Math.sqrt(sum);
  if (mag === 0) return vec.slice();
  return vec.map((v) => v / mag);
}

/** Element-wise mean of unit vectors, re-normalised. Used for entity centroids. */
export function centroid(vectors: number[][]): number[] {
  if (vectors.length === 0) throw new Error("centroid() requires at least one vector");
  const dim = vectors[0].length;
  const acc = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    if (v.length !== dim) throw new Error("centroid() got vectors of differing dimensions");
    for (let i = 0; i < dim; i++) acc[i] += v[i];
  }
  for (let i = 0; i < dim; i++) acc[i] /= vectors.length;
  return normalize(acc);
}
