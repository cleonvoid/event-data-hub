import type pg from "pg";
import { pool, query, vectorScan, vectorToSql, isMemoryStoreActive } from "./db.js";
import {
  memoryCreateSource,
  memoryListSources,
  memoryInsertRawRecord,
  memoryGetRawRecordsForEntity,
  memoryGetRawRecordById,
  memoryGetEmbeddingsForEntity,
  memoryCreateCanonicalEntity,
  memoryLinkRecordToEntity,
  memoryUpdateEntityCentroid,
  memoryEnrichEntityFromRecord,
  memoryListEntities,
  memoryGetEntityById,
  memoryFindCandidateEntitiesByVector,
  memoryFindCandidateEntitiesByIdentifier,
  memoryInsertMergeSuggestion,
  memoryListPendingSuggestions,
  memoryGetSuggestionForUpdate,
  memorySetSuggestionStatus,
  memoryMarkAutoRejected,
  memoryRejectSupersededSuggestions,
  memoryReassignRecordToEntity,
  memoryGetStats,
} from "./memory-store.js";
import {
  eventCountSubquery,
  recordCountSubquery,
  sourceFileCountSubquery,
} from "./search-schema.js";
import type {
  CanonicalEntityRow,
  MergeSuggestionRow,
  RawRecordRow,
  SourceRow,
  StatsSummary,
} from "./types.js";

type Executor = Pick<pg.PoolClient, "query">;
const db = (client?: Executor): Executor => client ?? pool;

/**
 * All SQL for the app. Raw parameterised SQL, no query builder — every statement
 * here is readable as-is and every value is bound, never interpolated.
 *
 * Counts (event_count / source_file_count / record_count) are computed by
 * correlated subquery at read time rather than stored on canonical_entities.
 * Stored counters go stale the instant a merge is approved or a source deleted.
 */

const ENTITY_COLUMNS = `
  c.id,
  c.organization_id,
  c.entity_type,
  c.display_name,
  c.primary_email,
  c.primary_phone,
  c.primary_organization,
  c.primary_role,
  c.created_at,
  ${eventCountSubquery()}      AS event_count,
  ${sourceFileCountSubquery()} AS source_file_count,
  ${recordCountSubquery()}     AS record_count
`;

function mapEntity(r: pg.QueryResultRow): CanonicalEntityRow {
  return {
    id: r.id,
    organizationId: r.organization_id,
    entityType: r.entity_type,
    displayName: r.display_name,
    primaryEmail: r.primary_email,
    primaryPhone: r.primary_phone,
    primaryOrganization: r.primary_organization,
    primaryRole: r.primary_role,
    eventCount: Number(r.event_count ?? 0),
    sourceFileCount: Number(r.source_file_count ?? 0),
    recordCount: Number(r.record_count ?? 0),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

function mapRawRecord(r: pg.QueryResultRow): RawRecordRow {
  return {
    id: r.id,
    sourceId: r.source_id,
    sourceName: r.source_name ?? "",
    sourceType: r.source_type ?? "",
    rowNumber: Number(r.row_number ?? 0),
    rawData: (r.raw_data ?? {}) as Record<string, string>,
    fullName: r.full_name,
    organization: r.organization,
    roleTitle: r.role_title,
    email: r.email,
    phone: r.phone,
    eventName: r.event_name,
    eventDate: r.event_date instanceof Date ? r.event_date.toISOString().slice(0, 10) : r.event_date,
    eventDateRaw: r.event_date_raw,
    notes: r.notes,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export async function createSource(
  input: {
    organizationId: string;
    name: string;
    sourceType: SourceRow["sourceType"];
    externalFileId: string | null;
    importedBy: string;
    fieldMapping: Record<string, string>;
  },
  client?: Executor,
): Promise<string> {
  if (isMemoryStoreActive()) {
    return memoryCreateSource(input);
  }
  const res = await db(client).query<{ id: string }>(
    `INSERT INTO sources (organization_id, name, source_type, external_file_id, imported_by, field_mapping)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      input.organizationId,
      input.name,
      input.sourceType,
      input.externalFileId,
      input.importedBy,
      JSON.stringify(input.fieldMapping),
    ],
  );
  return res.rows[0].id;
}

export async function listSources(organizationId: string): Promise<SourceRow[]> {
  if (isMemoryStoreActive()) {
    return memoryListSources(organizationId);
  }
  const res = await query(
    `SELECT s.id, s.organization_id, s.name, s.source_type, s.external_file_id, s.imported_at,
            (SELECT COUNT(*) FROM raw_records r WHERE r.source_id = s.id) AS records_count
     FROM sources s
     WHERE s.organization_id = $1
     ORDER BY s.imported_at DESC`,
    [organizationId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    name: r.name,
    sourceType: r.source_type,
    externalFileId: r.external_file_id,
    importedAt: r.imported_at instanceof Date ? r.imported_at.toISOString() : String(r.imported_at),
    recordsCount: Number(r.records_count ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Raw records
// ---------------------------------------------------------------------------

export interface NewRawRecord {
  sourceId: string;
  organizationId: string;
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
  embedding: number[];
}

export async function insertRawRecord(rec: NewRawRecord, client?: Executor): Promise<string> {
  if (isMemoryStoreActive()) {
    return memoryInsertRawRecord(rec);
  }
  const res = await db(client).query<{ id: string }>(
    `INSERT INTO raw_records (
       source_id, organization_id, row_number, raw_data,
       full_name, organization, role_title, email, phone,
       event_name, event_date, event_date_raw, notes,
       normalized_text, embedding
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::vector)
     RETURNING id`,
    [
      rec.sourceId,
      rec.organizationId,
      rec.rowNumber,
      JSON.stringify(rec.rawData),
      rec.fullName,
      rec.organization,
      rec.roleTitle,
      rec.email,
      rec.phone,
      rec.eventName,
      rec.eventDate,
      rec.eventDateRaw,
      rec.notes,
      rec.normalizedText,
      vectorToSql(rec.embedding),
    ],
  );
  return res.rows[0].id;
}

export async function getRawRecordsForEntity(
  organizationId: string,
  entityId: string,
): Promise<RawRecordRow[]> {
  if (isMemoryStoreActive()) {
    return memoryGetRawRecordsForEntity(organizationId, entityId);
  }
  const res = await query(
    `SELECT r.*, s.name AS source_name, s.source_type
     FROM raw_to_canonical l
     JOIN raw_records r ON r.id = l.raw_record_id
     JOIN sources s      ON s.id = r.source_id
     WHERE l.canonical_entity_id = $1 AND l.organization_id = $2
     ORDER BY r.event_date DESC NULLS LAST, r.created_at DESC`,
    [entityId, organizationId],
  );
  return res.rows.map(mapRawRecord);
}

export async function getRawRecordById(
  organizationId: string,
  recordId: string,
  client?: Executor,
): Promise<RawRecordRow | null> {
  if (isMemoryStoreActive()) {
    return memoryGetRawRecordById(organizationId, recordId);
  }
  const res = await db(client).query(
    `SELECT r.*, s.name AS source_name, s.source_type
     FROM raw_records r
     JOIN sources s ON s.id = r.source_id
     WHERE r.id = $1 AND r.organization_id = $2`,
    [recordId, organizationId],
  );
  return res.rows[0] ? mapRawRecord(res.rows[0]) : null;
}

/** Reads embeddings for a set of raw records. Used to recompute entity centroids. */
export async function getEmbeddingsForEntity(
  entityId: string,
  client?: Executor,
): Promise<number[][]> {
  if (isMemoryStoreActive()) {
    return memoryGetEmbeddingsForEntity(entityId);
  }
  const res = await db(client).query<{ embedding: string | null }>(
    `SELECT r.embedding::text AS embedding
     FROM raw_to_canonical l
     JOIN raw_records r ON r.id = l.raw_record_id
     WHERE l.canonical_entity_id = $1 AND r.embedding IS NOT NULL`,
    [entityId],
  );
  return res.rows
    .map((r) => (r.embedding ? (JSON.parse(r.embedding) as number[]) : null))
    .filter((v): v is number[] => Array.isArray(v));
}

// ---------------------------------------------------------------------------
// Canonical entities
// ---------------------------------------------------------------------------

export async function createCanonicalEntity(
  input: {
    organizationId: string;
    entityType: string;
    displayName: string;
    primaryEmail: string | null;
    primaryPhone: string | null;
    primaryOrganization: string | null;
    primaryRole: string | null;
    embedding: number[];
  },
  client?: Executor,
): Promise<string> {
  if (isMemoryStoreActive()) {
    return memoryCreateCanonicalEntity(input);
  }
  const res = await db(client).query<{ id: string }>(
    `INSERT INTO canonical_entities (
       organization_id, entity_type, display_name,
       primary_email, primary_phone, primary_organization, primary_role, embedding
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector)
     RETURNING id`,
    [
      input.organizationId,
      input.entityType,
      input.displayName,
      input.primaryEmail,
      input.primaryPhone,
      input.primaryOrganization,
      input.primaryRole,
      vectorToSql(input.embedding),
    ],
  );
  return res.rows[0].id;
}

export async function linkRecordToEntity(
  input: {
    rawRecordId: string;
    canonicalEntityId: string;
    organizationId: string;
    linkMethod: "seed" | "approved_merge";
  },
  client?: Executor,
): Promise<void> {
  if (isMemoryStoreActive()) {
    return memoryLinkRecordToEntity(input);
  }
  await db(client).query(
    `INSERT INTO raw_to_canonical (raw_record_id, canonical_entity_id, organization_id, link_method)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (raw_record_id) DO NOTHING`,
    [input.rawRecordId, input.canonicalEntityId, input.organizationId, input.linkMethod],
  );
}

export async function updateEntityCentroid(
  entityId: string,
  embedding: number[],
  client?: Executor,
): Promise<void> {
  if (isMemoryStoreActive()) {
    return memoryUpdateEntityCentroid(entityId, embedding);
  }
  await db(client).query(
    `UPDATE canonical_entities SET embedding = $2::vector, updated_at = NOW() WHERE id = $1`,
    [entityId, vectorToSql(embedding)],
  );
}

/**
 * Fills in blank canonical fields from a newly merged record. Existing non-empty
 * values win — a merge enriches an entity, it never overwrites curated data.
 */
export async function enrichEntityFromRecord(
  entityId: string,
  record: RawRecordRow,
  client?: Executor,
): Promise<void> {
  if (isMemoryStoreActive()) {
    return memoryEnrichEntityFromRecord(entityId, record);
  }
  await db(client).query(
    `UPDATE canonical_entities SET
       primary_email        = COALESCE(NULLIF(primary_email, ''), NULLIF($2, '')),
       primary_phone        = COALESCE(NULLIF(primary_phone, ''), NULLIF($3, '')),
       primary_organization = COALESCE(NULLIF(primary_organization, ''), NULLIF($4, '')),
       primary_role         = COALESCE(NULLIF(primary_role, ''), NULLIF($5, '')),
       updated_at           = NOW()
     WHERE id = $1`,
    [entityId, record.email ?? "", record.phone ?? "", record.organization ?? "", record.roleTitle ?? ""],
  );
}

export interface ListEntitiesOptions {
  predicateSql?: string | null;
  predicateParams?: (string | number)[];
  limit: number;
  offset: number;
}

export async function listEntities(
  organizationId: string,
  opts: ListEntitiesOptions,
): Promise<{ entities: CanonicalEntityRow[]; total: number }> {
  if (isMemoryStoreActive()) {
    return memoryListEntities(organizationId, opts);
  }
  const where = opts.predicateSql ? `AND (${opts.predicateSql})` : "";
  const params: (string | number)[] = [organizationId, ...(opts.predicateParams ?? [])];

  const countRes = await query<{ total: string }>(
    `SELECT COUNT(*) AS total FROM canonical_entities c WHERE c.organization_id = $1 ${where}`,
    params,
  );

  const listRes = await query(
    `SELECT ${ENTITY_COLUMNS}
     FROM canonical_entities c
     WHERE c.organization_id = $1 ${where}
     ORDER BY ${eventCountSubquery()} DESC, c.display_name ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, opts.limit, opts.offset],
  );

  return {
    entities: listRes.rows.map(mapEntity),
    total: Number(countRes.rows[0]?.total ?? 0),
  };
}

export async function getEntityById(
  organizationId: string,
  entityId: string,
  client?: Executor,
): Promise<CanonicalEntityRow | null> {
  if (isMemoryStoreActive()) {
    return memoryGetEntityById(organizationId, entityId);
  }
  const res = await db(client).query(
    `SELECT ${ENTITY_COLUMNS} FROM canonical_entities c WHERE c.id = $1 AND c.organization_id = $2`,
    [entityId, organizationId],
  );
  return res.rows[0] ? mapEntity(res.rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Stage 1: vector candidate retrieval
// ---------------------------------------------------------------------------

export interface CandidateEntity {
  entity: CanonicalEntityRow;
  similarity: number;
  /** True when the candidate came from exact email/phone blocking, not the vector index. */
  viaBlocking: boolean;
}

/**
 * Stage 1 — pgvector cosine retrieval.
 */
export async function findCandidateEntitiesByVector(
  organizationId: string,
  rawRecordId: string,
  embedding: number[],
  topN: number,
  client?: Executor,
): Promise<CandidateEntity[]> {
  if (isMemoryStoreActive()) {
    return memoryFindCandidateEntitiesByVector(organizationId, rawRecordId, embedding, topN);
  }
  const res = await vectorScan(
    `SELECT ${ENTITY_COLUMNS},
            1 - (c.embedding <=> $2::vector) AS similarity
     FROM canonical_entities c
     WHERE c.organization_id = $1
       AND c.embedding IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM merge_suggestions ms
         WHERE ms.canonical_entity_id = c.id
           AND ms.candidate_raw_record_id = $3
       )
     ORDER BY c.embedding <=> $2::vector
     LIMIT $4`,
    [organizationId, vectorToSql(embedding), rawRecordId, topN],
    client,
  );
  return res.rows.map((r) => ({
    entity: mapEntity(r),
    similarity: Number(r.similarity ?? 0),
    viaBlocking: false,
  }));
}

/**
 * Deterministic blocking on exact email / phone match, unioned into the Stage 1 candidate set.
 */
export async function findCandidateEntitiesByIdentifier(
  organizationId: string,
  rawRecordId: string,
  email: string,
  phone: string,
  client?: Executor,
): Promise<CandidateEntity[]> {
  if (isMemoryStoreActive()) {
    return memoryFindCandidateEntitiesByIdentifier(organizationId, rawRecordId, email, phone);
  }
  if (!email && !phone) return [];
  const res = await db(client).query(
    `SELECT ${ENTITY_COLUMNS}
     FROM canonical_entities c
     WHERE c.organization_id = $1
       AND (
         ($2 <> '' AND LOWER(c.primary_email) = $2)
         OR ($3 <> '' AND regexp_replace(COALESCE(c.primary_phone, ''), '[^0-9]', '', 'g') = $3)
       )
       AND NOT EXISTS (
         SELECT 1 FROM merge_suggestions ms
         WHERE ms.canonical_entity_id = c.id
           AND ms.candidate_raw_record_id = $4
       )
     LIMIT 5`,
    [organizationId, email, phone.replace(/\D/g, ""), rawRecordId],
  );
  return res.rows.map((r) => ({
    entity: mapEntity(r),
    similarity: 1.0,
    viaBlocking: true,
  }));
}

// ---------------------------------------------------------------------------
// Merge suggestions
// ---------------------------------------------------------------------------

export async function insertMergeSuggestion(
  input: {
    organizationId: string;
    canonicalEntityId: string;
    candidateRawRecordId: string;
    vectorSimilarity: number;
    llmConfidence: number;
    combinedConfidence: number;
    llmVerdict: boolean;
    reasoning: string;
  },
  client?: Executor,
): Promise<boolean> {
  if (isMemoryStoreActive()) {
    return memoryInsertMergeSuggestion(input);
  }
  const res = await db(client).query(
    `INSERT INTO merge_suggestions (
       organization_id, canonical_entity_id, candidate_raw_record_id,
       vector_similarity, llm_confidence, combined_confidence,
       llm_verdict, reasoning
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (canonical_entity_id, candidate_raw_record_id) DO NOTHING`,
    [
      input.organizationId,
      input.canonicalEntityId,
      input.candidateRawRecordId,
      input.vectorSimilarity,
      input.llmConfidence,
      input.combinedConfidence,
      input.llmVerdict,
      input.reasoning,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listPendingSuggestions(
  organizationId: string,
  limit = 50,
): Promise<MergeSuggestionRow[]> {
  if (isMemoryStoreActive()) {
    return memoryListPendingSuggestions(organizationId, limit);
  }
  const res = await query(
    `SELECT ms.id, ms.canonical_entity_id, ms.candidate_raw_record_id,
            ms.vector_similarity, ms.llm_confidence, ms.combined_confidence,
            ms.llm_verdict, ms.reasoning, ms.status, ms.created_at
     FROM merge_suggestions ms
     WHERE ms.organization_id = $1 AND ms.status = 'pending'
     ORDER BY ms.combined_confidence DESC, ms.created_at ASC
     LIMIT $2`,
    [organizationId, limit],
  );

  const out: MergeSuggestionRow[] = [];
  for (const r of res.rows) {
    const [entity, record] = await Promise.all([
      getEntityById(organizationId, r.canonical_entity_id),
      getRawRecordById(organizationId, r.candidate_raw_record_id),
    ]);
    if (!entity || !record) continue; // referenced row was deleted; skip quietly
    out.push({
      id: r.id,
      canonicalEntityId: r.canonical_entity_id,
      candidateRawRecordId: r.candidate_raw_record_id,
      vectorSimilarity: Number(r.vector_similarity),
      llmConfidence: Number(r.llm_confidence),
      combinedConfidence: Number(r.combined_confidence),
      llmVerdict: r.llm_verdict,
      reasoning: r.reasoning,
      status: r.status,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      canonicalEntity: entity,
      candidateRecord: record,
    });
  }
  return out;
}

export async function getSuggestionForUpdate(
  organizationId: string,
  suggestionId: string,
  client: Executor,
): Promise<{
  id: string;
  canonicalEntityId: string;
  candidateRawRecordId: string;
  status: string;
} | null> {
  if (isMemoryStoreActive()) {
    return memoryGetSuggestionForUpdate(organizationId, suggestionId);
  }
  const res = await client.query(
    `SELECT id, canonical_entity_id, candidate_raw_record_id, status
     FROM merge_suggestions
     WHERE id = $1 AND organization_id = $2
     FOR UPDATE`,
    [suggestionId, organizationId],
  );
  const r = res.rows[0];
  return r
    ? {
        id: r.id,
        canonicalEntityId: r.canonical_entity_id,
        candidateRawRecordId: r.candidate_raw_record_id,
        status: r.status,
      }
    : null;
}

export async function setSuggestionStatus(
  suggestionId: string,
  status: "approved" | "rejected",
  decidedBy: string,
  client?: Executor,
): Promise<void> {
  if (isMemoryStoreActive()) {
    return memorySetSuggestionStatus(suggestionId, status, decidedBy);
  }
  await db(client).query(
    `UPDATE merge_suggestions
     SET status = $2, decided_at = NOW(), decided_by = $3
     WHERE id = $1`,
    [suggestionId, status, decidedBy],
  );
}

export async function markAutoRejected(
  canonicalEntityId: string,
  candidateRawRecordId: string,
  client?: Executor,
): Promise<void> {
  if (isMemoryStoreActive()) {
    return memoryMarkAutoRejected(canonicalEntityId, candidateRawRecordId);
  }
  await db(client).query(
    `UPDATE merge_suggestions
     SET status = 'rejected', decided_at = NOW(), decided_by = 'gemini_stage2'
     WHERE canonical_entity_id = $1 AND candidate_raw_record_id = $2 AND status = 'pending'`,
    [canonicalEntityId, candidateRawRecordId],
  );
}

export async function rejectSupersededSuggestions(
  candidateRawRecordId: string,
  excludeSuggestionId: string,
  client?: Executor,
): Promise<void> {
  if (isMemoryStoreActive()) {
    return memoryRejectSupersededSuggestions(candidateRawRecordId, excludeSuggestionId);
  }
  await db(client).query(
    `UPDATE merge_suggestions
     SET status = 'rejected', decided_at = NOW(), decided_by = 'superseded'
     WHERE candidate_raw_record_id = $1 AND status = 'pending' AND id <> $2`,
    [candidateRawRecordId, excludeSuggestionId],
  );
}

/**
 * Moves a raw record from whatever entity currently owns it onto the target.
 * Approving a merge means "these are the same person", so the record's old
 * single-record entity is absorbed and deleted if it becomes empty.
 */
export async function reassignRecordToEntity(
  input: { rawRecordId: string; targetEntityId: string; organizationId: string },
  client: Executor,
): Promise<{ removedEntityId: string | null }> {
  if (isMemoryStoreActive()) {
    return memoryReassignRecordToEntity(input);
  }
  const current = await client.query<{ canonical_entity_id: string }>(
    `SELECT canonical_entity_id FROM raw_to_canonical WHERE raw_record_id = $1`,
    [input.rawRecordId],
  );
  const previousEntityId = current.rows[0]?.canonical_entity_id ?? null;

  await client.query(
    `INSERT INTO raw_to_canonical (raw_record_id, canonical_entity_id, organization_id, link_method)
     VALUES ($1,$2,$3,'approved_merge')
     ON CONFLICT (raw_record_id)
     DO UPDATE SET canonical_entity_id = EXCLUDED.canonical_entity_id,
                   link_method = 'approved_merge',
                   linked_at = NOW()`,
    [input.rawRecordId, input.targetEntityId, input.organizationId],
  );

  if (!previousEntityId || previousEntityId === input.targetEntityId) {
    return { removedEntityId: null };
  }

  const remaining = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM raw_to_canonical WHERE canonical_entity_id = $1`,
    [previousEntityId],
  );
  if (Number(remaining.rows[0]?.count ?? 0) === 0) {
    await client.query(`DELETE FROM canonical_entities WHERE id = $1`, [previousEntityId]);
    return { removedEntityId: previousEntityId };
  }
  return { removedEntityId: null };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function getStats(organizationId: string): Promise<StatsSummary> {
  if (isMemoryStoreActive()) {
    return memoryGetStats(organizationId);
  }
  const res = await query<{
    total_entities: string;
    total_raw: string;
    total_sources: string;
    pending_merges: string;
    linked_raw: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM canonical_entities WHERE organization_id = $1) AS total_entities,
       (SELECT COUNT(*) FROM raw_records        WHERE organization_id = $1) AS total_raw,
       (SELECT COUNT(*) FROM sources            WHERE organization_id = $1) AS total_sources,
       (SELECT COUNT(*) FROM merge_suggestions
         WHERE organization_id = $1 AND status = 'pending')                 AS pending_merges,
       (SELECT COUNT(DISTINCT raw_record_id) FROM raw_to_canonical
         WHERE organization_id = $1)                                          AS linked_raw`,
    [organizationId],
  );

  const byType = await query<{ source_type: string; file_count: string; record_count: string }>(
    `SELECT s.source_type,
            COUNT(DISTINCT s.id) AS file_count,
            COUNT(r.id)          AS record_count
     FROM sources s
     LEFT JOIN raw_records r ON r.source_id = s.id
     WHERE s.organization_id = $1
     GROUP BY s.source_type
     ORDER BY s.source_type`,
    [organizationId],
  );

  const totalRaw = Number(res.rows[0]?.total_raw ?? 0);
  const totalEntities = Number(res.rows[0]?.total_entities ?? 0);
  const linkedRaw = Number(res.rows[0]?.linked_raw ?? 0);

  return {
    totalCanonicalEntities: totalEntities,
    totalRawRecords: totalRaw,
    dedupRatePercent:
      linkedRaw > 0 ? Number((((linkedRaw - totalEntities) / linkedRaw) * 100).toFixed(1)) : 0,
    sourceFilesProcessed: Number(res.rows[0]?.total_sources ?? 0),
    pendingMergeSuggestions: Number(res.rows[0]?.pending_merges ?? 0),
    bySourceType: byType.rows.map((r) => ({
      sourceType: r.source_type,
      fileCount: Number(r.file_count),
      recordCount: Number(r.record_count),
    })),
  };
}
