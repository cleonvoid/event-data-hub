import { config } from "../config.js";
import { getEmbedClient, withRetry } from "./client.js";

/**
 * Vertex AI / Gemini text embeddings for Stage 1 candidate retrieval.
 *
 * There is deliberately NO fallback vector generator here. An earlier version of
 * this file synthesised a vector from a character sum when the API failed, which
 * meant entity resolution silently degraded to noise while still looking like it
 * worked. Embedding failure now propagates: an import either gets real vectors or
 * it fails loudly.
 */

const BATCH_SIZE = 16;

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const client = getEmbedClient();
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const response = await withRetry(`embedTexts[${i}..${i + batch.length})`, () =>
      client.models.embedContent({
        model: config.embeddings.model,
        contents: batch,
        config: {
          outputDimensionality: config.embeddings.dimensions,
          // SEMANTIC_SIMILARITY is the right task type for dedup: we compare
          // records against each other symmetrically, not queries against docs.
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
            `schema expects VECTOR(${config.embeddings.dimensions}). ` +
            `Set EMBEDDING_DIM and the migration to the same value.`,
        );
      }
      // gemini-embedding-001 does not return unit-normalised vectors when
      // outputDimensionality truncates them, and cosine distance in pgvector
      // assumes nothing about magnitude — normalising here keeps the centroid
      // arithmetic in resolution.ts meaningful.
      out.push(normalize(values));
    }
  }

  return out;
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
