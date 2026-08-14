import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";

/**
 * Two clients, because the two Google surfaces have different auth models:
 *
 *  - textClient  : Gemini API (API key). Used for all generation.
 *  - embedClient : Vertex AI when USE_VERTEX_EMBEDDINGS=true (project + ADC,
 *                  which is what Cloud Run gets for free), otherwise the Gemini
 *                  API. Both serve the same embedding model and produce
 *                  interchangeable vectors — the difference is only how you
 *                  authenticate, which is what lets this run locally with just
 *                  an API key and on GCP with no key at all.
 */

let _textClient: GoogleGenAI | null = null;
let _embedClient: GoogleGenAI | null = null;

export class AiNotConfiguredError extends Error {
  constructor(what: string) {
    super(
      `${what} requires GEMINI_API_KEY (or USE_VERTEX_EMBEDDINGS=true with GOOGLE_CLOUD_PROJECT + ADC). ` +
        `See README.md — "Biến môi trường".`,
    );
    this.name = "AiNotConfiguredError";
  }
}

export function getTextClient(): GoogleGenAI {
  if (!config.gemini.apiKey) throw new AiNotConfiguredError("Gemini text generation");
  if (!_textClient) _textClient = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  return _textClient;
}

export function getEmbedClient(): GoogleGenAI {
  if (_embedClient) return _embedClient;

  if (config.embeddings.useVertex) {
    if (!config.embeddings.project) {
      throw new AiNotConfiguredError(
        "Vertex AI embeddings (USE_VERTEX_EMBEDDINGS=true but GOOGLE_CLOUD_PROJECT is unset)",
      );
    }
    _embedClient = new GoogleGenAI({
      vertexai: true,
      project: config.embeddings.project,
      location: config.embeddings.location,
    });
    return _embedClient;
  }

  if (!config.gemini.apiKey) throw new AiNotConfiguredError("Embeddings");
  _embedClient = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  return _embedClient;
}

export function isAiConfigured(): boolean {
  return Boolean(config.gemini.apiKey) || (config.embeddings.useVertex && Boolean(config.embeddings.project));
}

const RETRYABLE = /\b(429|500|502|503|504|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED)\b/i;

/**
 * Retries transient Google API failures with exponential backoff. Permanent
 * errors (400 bad model id, 401/403 bad key) are rethrown immediately — retrying
 * those just makes a broken demo slower to diagnose.
 */
export async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!RETRYABLE.test(msg) || i === attempts - 1) break;
      const delay = 400 * 2 ** i + Math.random() * 200;
      console.warn(`[ai] ${label} attempt ${i + 1} failed (${msg.slice(0, 120)}); retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Strips ```json fences some models still emit around structured output. */
export function parseJsonResponse<T>(text: string | undefined, label: string): T {
  if (!text || !text.trim()) {
    throw new Error(`${label}: model returned an empty response`);
  }
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new Error(`${label}: model response was not valid JSON: ${cleaned.slice(0, 200)}`);
  }
}
