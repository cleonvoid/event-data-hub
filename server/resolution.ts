import type pg from "pg";
import { config } from "./config.js";
import { withTransaction } from "./db.js";
import { adjudicateMergeBatch } from "./ai/gemini.js";
import { centroid, embedTexts } from "./ai/embeddings.js";
import * as repo from "./repo.js";
import {
  blockingKey,
  cleanCell,
  normalizeEmail,
  normalizePhone,
  normalizedIdentity,
  parseEventDate,
} from "./normalize.js";
import { isCanonicalField, type CanonicalField } from "./types.js";

/**
 * Two-stage entity resolution.
 *
 *   Stage 1  pgvector cosine retrieval over canonical_entities → top-N candidates.
 *            O(log n) via the HNSW index instead of O(n²) pairwise comparison.
 *   Stage 2  Gemini adjudicates ONLY those candidates and returns a structured
 *            verdict + reason.
 *
 * Nothing here ever merges automatically. Every surviving candidate becomes a
 * merge_suggestion the user has to approve or reject.
 */

// ---------------------------------------------------------------------------
// Confidence blending
// ---------------------------------------------------------------------------

/**
 * Blends the two stages into one score.
 *
 * Weighting rationale: the vector only ever saw "name | organization | role",
 * so it is a recall device — good at surfacing candidates, weak at deciding.
 * The LLM additionally sees email and phone, which are the actual identifying
 * evidence for this dataset, so it carries the larger weight. The vector term is
 * kept because a high-similarity pair the model is lukewarm about is still worth
 * ranking above a low-similarity one it is equally lukewarm about.
 */
export function combineConfidence(
  vectorSimilarity: number,
  llmConfidence: number,
  llmVerdict: boolean,
): number {
  // The model's confidence is in its *verdict*. Convert to P(same entity).
  const pSame = llmVerdict ? llmConfidence : 1 - llmConfidence;
  const vec = Math.min(1, Math.max(0, vectorSimilarity));
  return Number((0.35 * vec + 0.65 * pSame).toFixed(4));
}

/**
 * Above this the model's "not a match" is trusted enough to record a permanent
 * negative signal without asking a human. Below it the pair is still shown for
 * review, because an uncertain no is exactly the case a person should look at.
 */
const AUTO_REJECT_CONFIDENCE = 0.75;

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

export interface ParsedRow {
  rowNumber: number;
  rawData: Record<string, string>;
  fullName: string | null;
  organization: string | null;
  roleTitle: string | null;
  email: string | null;
  phone: string | null;
  eventName: string | null;
  eventDate: string | null;
  eventDateRaw: string | null;
  notes: string | null;
  normalizedText: string;
}

/**
 * Applies the user-confirmed mapping to the sheet rows.
 *
 * Multiple source columns can map to the same canonical field (two "Ghi chú"
 * columns, say); their values are joined rather than one silently winning.
 * The full original row is always preserved in rawData regardless of mapping.
 */
export function parseRows(
  headers: string[],
  rows: unknown[][],
  mapping: Record<string, string>,
  fallbackEventName: string,
): ParsedRow[] {
  const out: ParsedRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const rawData: Record<string, string> = {};
    const collected = new Map<CanonicalField, string[]>();

    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      const value = cleanCell(row[c]);
      rawData[header] = value;

      const target = mapping[header];
      if (!isCanonicalField(target) || target === "ignore" || !value) continue;
      const bucket = collected.get(target) ?? [];
      bucket.push(value);
      collected.set(target, bucket);
    }

    const take = (f: CanonicalField): string => (collected.get(f) ?? []).join(" / ");

    const fullName = take("full_name");
    const organization = take("organization");
    const roleTitle = take("role_title");
    const email = normalizeEmail(take("email"));
    const phone = normalizePhone(take("phone"));
    const eventDateRaw = take("event_date");
    const notes = take("notes");
    const eventName = take("event_name") || fallbackEventName;

    // A row with neither a name nor an email identifies nobody — skip it rather
    // than manufacturing a placeholder entity.
    if (!fullName && !email) continue;

    out.push({
      rowNumber: i + 1,
      rawData,
      fullName: fullName || null,
      organization: organization || null,
      roleTitle: roleTitle || null,
      email: email || null,
      phone: phone || null,
      eventName: eventName || null,
      eventDate: parseEventDate(eventDateRaw),
      eventDateRaw: eventDateRaw || null,
      notes: notes || null,
      normalizedText: normalizedIdentity({ fullName, organization, roleTitle }),
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Import + resolve
// ---------------------------------------------------------------------------

export interface ImportResult {
  sourceId: string;
  importedRecords: number;
  skippedRows: number;
  newEntities: number;
  suggestionsCreated: number;
  autoRejected: number;
  geminiCalls: number;
}

export async function importAndResolve(input: {
  organizationId: string;
  importedBy: string;
  sourceName: string;
  sourceType: "google_sheets" | "google_drive_xlsx" | "local_upload";
  externalFileId: string | null;
  headers: string[];
  rows: unknown[][];
  mapping: Record<string, string>;
}): Promise<ImportResult> {
  const fallbackEventName = input.sourceName.replace(/\.[^./\\]+$/, "");
  const parsed = parseRows(input.headers, input.rows, input.mapping, fallbackEventName);
  const skippedRows = input.rows.length - parsed.length;

  if (parsed.length === 0) {
    throw new Error(
      "Không có dòng nào chứa họ tên hoặc email hợp lệ. Vui lòng kiểm tra lại ánh xạ cột.",
    );
  }

  // Embed everything up front, in batches. This is the slow step, so doing it
  // once beats interleaving it with per-row database work.
  const embeddings = await embedTexts(parsed.map((p) => p.normalizedText));

  // The source row and all raw records land in one transaction: a half-imported
  // file is worse than a failed one.
  const { sourceId, recordIds } = await withTransaction(async (client) => {
    const sourceId = await repo.createSource(
      {
        organizationId: input.organizationId,
        name: input.sourceName,
        sourceType: input.sourceType,
        externalFileId: input.externalFileId,
        importedBy: input.importedBy,
        fieldMapping: input.mapping,
      },
      client,
    );

    const recordIds: string[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i];
      recordIds.push(
        await repo.insertRawRecord(
          {
            sourceId,
            organizationId: input.organizationId,
            rowNumber: p.rowNumber,
            rawData: p.rawData,
            fullName: p.fullName,
            organization: p.organization,
            roleTitle: p.roleTitle,
            email: p.email,
            phone: p.phone,
            eventName: p.eventName,
            eventDate: p.eventDate,
            eventDateRaw: p.eventDateRaw,
            notes: p.notes,
            normalizedText: p.normalizedText,
            embedding: embeddings[i],
          },
          client,
        ),
      );
    }
    return { sourceId, recordIds };
  });

  // Resolution runs OUTSIDE the import transaction and sequentially: each record
  // must be able to match entities seeded by earlier records in the same file,
  // which is the common case when one spreadsheet lists a person twice.
  let newEntities = 0;
  let suggestionsCreated = 0;
  let autoRejected = 0;
  let geminiCalls = 0;

  for (let i = 0; i < parsed.length; i++) {
    const outcome = await resolveRecord({
      organizationId: input.organizationId,
      rawRecordId: recordIds[i],
      parsed: parsed[i],
      embedding: embeddings[i],
    });
    newEntities += outcome.createdEntity ? 1 : 0;
    suggestionsCreated += outcome.suggestionsCreated;
    autoRejected += outcome.autoRejected;
    geminiCalls += outcome.geminiCalls;
  }

  return {
    sourceId,
    importedRecords: parsed.length,
    skippedRows,
    newEntities,
    suggestionsCreated,
    autoRejected,
    geminiCalls,
  };
}

interface ResolveOutcome {
  createdEntity: boolean;
  suggestionsCreated: number;
  autoRejected: number;
  geminiCalls: number;
}

/**
 * Resolves one freshly-inserted raw record.
 *
 * Order matters: candidate retrieval happens BEFORE the record's own seed entity
 * is created, so the record can never match itself.
 */
async function resolveRecord(input: {
  organizationId: string;
  rawRecordId: string;
  parsed: ParsedRow;
  embedding: number[];
}): Promise<ResolveOutcome> {
  const { organizationId, rawRecordId, parsed, embedding } = input;

  // ---- Stage 1: vector retrieval (+ deterministic identifier blocking) ----
  const [byVector, byIdentifier] = await Promise.all([
    repo.findCandidateEntitiesByVector(
      organizationId,
      rawRecordId,
      embedding,
      config.resolution.topN,
    ),
    repo.findCandidateEntitiesByIdentifier(
      organizationId,
      rawRecordId,
      parsed.email ?? "",
      parsed.phone ?? "",
    ),
  ]);

  const candidates = new Map<string, repo.CandidateEntity>();
  for (const c of byVector) {
    if (c.similarity >= config.resolution.minVectorSimilarity) candidates.set(c.entity.id, c);
  }
  // Identifier matches bypass the similarity floor — an exact email match is
  // stronger evidence than any cosine score.
  for (const c of byIdentifier) candidates.set(c.entity.id, c);

  let suggestionsCreated = 0;
  let autoRejected = 0;
  let geminiCalls = 0;

  // ---- Stage 2: one batched LLM call for the whole shortlist ----
  const shortlist = [...candidates.values()];
  let verdicts = new Map<string, { isSameEntity: boolean; confidence: number; reasoning: string }>();
  if (shortlist.length > 0) {
    try {
      geminiCalls++;
      verdicts = await adjudicateMergeBatch(
        {
          fullName: parsed.fullName ?? "",
          organization: parsed.organization ?? "",
          role: parsed.roleTitle ?? "",
          email: parsed.email ?? "",
          phone: parsed.phone ?? "",
          eventName: parsed.eventName ?? "",
        },
        shortlist.map((c) => ({
          id: c.entity.id,
          displayName: c.entity.displayName,
          organization: c.entity.primaryOrganization ?? "",
          role: c.entity.primaryRole ?? "",
          email: c.entity.primaryEmail ?? "",
          phone: c.entity.primaryPhone ?? "",
          vectorSimilarity: c.similarity,
        })),
      );
    } catch (err) {
      // A failed adjudication must not abort the whole import. Those pairs get
      // no suggestion row, so they are reconsidered on a later import.
      console.error(
        `[resolution] Stage 2 failed for record ${rawRecordId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  for (const candidate of shortlist) {
    const verdict = verdicts.get(candidate.entity.id);
    if (!verdict) continue;

    const combined = combineConfidence(candidate.similarity, verdict.confidence, verdict.isSameEntity);

    const confidentlyNotAMatch = !verdict.isSameEntity && verdict.confidence >= AUTO_REJECT_CONFIDENCE;

    if (confidentlyNotAMatch) {
      // Persist as an already-rejected row. This is the negative signal: the
      // unique (entity, record) index means this pair is never proposed again,
      // and no Gemini call is ever spent on it again either.
      await repo.insertMergeSuggestion({
        organizationId,
        canonicalEntityId: candidate.entity.id,
        candidateRawRecordId: rawRecordId,
        vectorSimilarity: candidate.similarity,
        llmConfidence: verdict.confidence,
        combinedConfidence: combined,
        llmVerdict: false,
        reasoning: verdict.reasoning,
      });
      await markAutoRejected(candidate.entity.id, rawRecordId);
      autoRejected++;
      continue;
    }

    if (combined < config.resolution.minCombinedConfidence) continue;

    const inserted = await repo.insertMergeSuggestion({
      organizationId,
      canonicalEntityId: candidate.entity.id,
      candidateRawRecordId: rawRecordId,
      vectorSimilarity: candidate.similarity,
      llmConfidence: verdict.confidence,
      combinedConfidence: combined,
      llmVerdict: verdict.isSameEntity,
      reasoning: verdict.reasoning,
    });
    if (inserted) suggestionsCreated++;
  }

  // ---- Always seed the record's own canonical entity ----
  // Every raw record belongs to exactly one entity from the moment it lands. A
  // pending suggestion does not change that; approving one later moves the
  // record onto the target entity and removes this now-empty seed. That keeps
  // the dedup statistic honest: it only improves when a human approves a merge.
  await withTransaction(async (client) => {
    const entityId = await repo.createCanonicalEntity(
      {
        organizationId,
        entityType: "person",
        displayName: parsed.fullName ?? parsed.email ?? "(không rõ)",
        primaryEmail: parsed.email,
        primaryPhone: parsed.phone,
        primaryOrganization: parsed.organization,
        primaryRole: parsed.roleTitle,
        embedding,
      },
      client,
    );
    await repo.linkRecordToEntity(
      { rawRecordId, canonicalEntityId: entityId, organizationId, linkMethod: "seed" },
      client,
    );
  });

  return { createdEntity: true, suggestionsCreated, autoRejected, geminiCalls };
}

async function markAutoRejected(entityId: string, rawRecordId: string): Promise<void> {
  await repo.markAutoRejected(entityId, rawRecordId);
}

// ---------------------------------------------------------------------------
// Approve / reject
// ---------------------------------------------------------------------------

export async function approveMerge(input: {
  organizationId: string;
  suggestionId: string;
  decidedBy: string;
}): Promise<{ entityId: string; absorbedEntityId: string | null }> {
  const entityId = await withTransaction(async (client) => {
    const suggestion = await repo.getSuggestionForUpdate(
      input.organizationId,
      input.suggestionId,
      client,
    );
    if (!suggestion) throw new NotFoundError("Không tìm thấy gợi ý hợp nhất");
    if (suggestion.status !== "pending") {
      throw new ConflictError(`Gợi ý này đã được xử lý (${suggestion.status})`);
    }

    await repo.setSuggestionStatus(input.suggestionId, "approved", input.decidedBy, client);

    const { removedEntityId } = await repo.reassignRecordToEntity(
      {
        rawRecordId: suggestion.candidateRawRecordId,
        targetEntityId: suggestion.canonicalEntityId,
        organizationId: input.organizationId,
      },
      client,
    );

    const record = await repo.getRawRecordById(
      input.organizationId,
      suggestion.candidateRawRecordId,
      client,
    );
    if (record) {
      await repo.enrichEntityFromRecord(suggestion.canonicalEntityId, record, client);
    }

    // Any other pending suggestion pointing at this record is now moot — the
    // record has an owner. Resolve them so the review queue stays truthful.
    await repo.rejectSupersededSuggestions(suggestion.candidateRawRecordId, input.suggestionId, client);

    return { targetId: suggestion.canonicalEntityId, removedEntityId };
  }).then(async ({ targetId, removedEntityId }) => {
    // Recompute the centroid after commit so Stage 1 retrieval improves as the
    // entity accumulates name variants.
    await recomputeCentroid(targetId);
    return { entityId: targetId, absorbedEntityId: removedEntityId };
  });

  return entityId;
}

export async function rejectMerge(input: {
  organizationId: string;
  suggestionId: string;
  decidedBy: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    const suggestion = await repo.getSuggestionForUpdate(
      input.organizationId,
      input.suggestionId,
      client,
    );
    if (!suggestion) throw new NotFoundError("Không tìm thấy gợi ý hợp nhất");
    if (suggestion.status !== "pending") {
      throw new ConflictError(`Gợi ý này đã được xử lý (${suggestion.status})`);
    }
    // The row survives with status='rejected'. Combined with the unique index on
    // (canonical_entity_id, candidate_raw_record_id), this is what stops the
    // same pair from ever being suggested again.
    await repo.setSuggestionStatus(input.suggestionId, "rejected", input.decidedBy, client);
  });
}

async function recomputeCentroid(entityId: string): Promise<void> {
  const vectors = await repo.getEmbeddingsForEntity(entityId);
  if (vectors.length === 0) return;
  await repo.updateEntityCentroid(entityId, centroid(vectors));
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** Exported for tests / diagnostics. */
export { blockingKey };
export type { pg };
