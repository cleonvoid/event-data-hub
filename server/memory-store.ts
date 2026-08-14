import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  CanonicalEntityRow,
  MergeSuggestionRow,
  RawRecordRow,
  SourceRow,
  StatsSummary,
} from "./types.js";
import type { CandidateEntity, ListEntitiesOptions, NewRawRecord } from "./repo.js";

export interface MemorySource {
  id: string;
  organizationId: string;
  name: string;
  sourceType: "google_sheets" | "google_drive_xlsx" | "local_upload";
  externalFileId: string | null;
  importedBy: string;
  importedAt: string;
  fieldMapping: Record<string, string>;
}

export interface MemoryRawRecord {
  id: string;
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
  createdAt: string;
}

export interface MemoryCanonicalEntity {
  id: string;
  organizationId: string;
  entityType: string;
  displayName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  primaryOrganization: string | null;
  primaryRole: string | null;
  embedding: number[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRawToCanonical {
  rawRecordId: string;
  canonicalEntityId: string;
  organizationId: string;
  linkMethod: "seed" | "approved_merge";
  linkedAt: string;
}

export interface MemoryMergeSuggestion {
  id: string;
  organizationId: string;
  canonicalEntityId: string;
  candidateRawRecordId: string;
  vectorSimilarity: number;
  llmConfidence: number;
  combinedConfidence: number;
  llmVerdict: boolean;
  reasoning: string;
  status: "pending" | "approved" | "rejected";
  decidedAt: string | null;
  decidedBy: string | null;
  createdAt: string;
}

export interface MemoryDataState {
  sources: MemorySource[];
  rawRecords: MemoryRawRecord[];
  canonicalEntities: MemoryCanonicalEntity[];
  rawToCanonical: MemoryRawToCanonical[];
  mergeSuggestions: MemoryMergeSuggestion[];
}

const state: MemoryDataState = {
  sources: [],
  rawRecords: [],
  canonicalEntities: [],
  rawToCanonical: [],
  mergeSuggestions: [],
};

const DB_FILE_PATH = path.resolve(process.cwd(), "data", "memory_db.json");

function loadState(): void {
  try {
    if (fs.existsSync(DB_FILE_PATH)) {
      const raw = fs.readFileSync(DB_FILE_PATH, "utf8");
      const parsed = JSON.parse(raw) as Partial<MemoryDataState>;
      state.sources = parsed.sources ?? [];
      state.rawRecords = parsed.rawRecords ?? [];
      state.canonicalEntities = parsed.canonicalEntities ?? [];
      state.rawToCanonical = parsed.rawToCanonical ?? [];
      state.mergeSuggestions = parsed.mergeSuggestions ?? [];
    }
  } catch (err) {
    console.warn("[memory-store] failed to load state file:", err);
  }
}

function persistState(): void {
  try {
    const dir = path.dirname(DB_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DB_FILE_PATH, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.warn("[memory-store] failed to persist state:", err);
  }
}

// Initialize on module load
loadState();

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function mapCanonicalEntityRow(
  e: MemoryCanonicalEntity,
  orgId: string,
): CanonicalEntityRow {
  const linkedRawIds = state.rawToCanonical
    .filter((l) => l.canonicalEntityId === e.id && l.organizationId === orgId)
    .map((l) => l.rawRecordId);

  const linkedRecords = state.rawRecords.filter((r) =>
    linkedRawIds.includes(r.id),
  );

  const distinctEvents = new Set(
    linkedRecords.map((r) => r.eventName).filter(Boolean),
  );
  const distinctSources = new Set(linkedRecords.map((r) => r.sourceId));

  return {
    id: e.id,
    organizationId: e.organizationId,
    entityType: e.entityType,
    displayName: e.displayName,
    primaryEmail: e.primaryEmail,
    primaryPhone: e.primaryPhone,
    primaryOrganization: e.primaryOrganization,
    primaryRole: e.primaryRole,
    eventCount: distinctEvents.size,
    sourceFileCount: distinctSources.size,
    recordCount: linkedRawIds.length,
    createdAt: e.createdAt,
  };
}

function mapRawRecordRow(r: MemoryRawRecord): RawRecordRow {
  const source = state.sources.find((s) => s.id === r.sourceId);
  return {
    id: r.id,
    sourceId: r.sourceId,
    sourceName: source?.name ?? "",
    sourceType: source?.sourceType ?? "",
    rowNumber: r.rowNumber,
    rawData: r.rawData,
    fullName: r.fullName,
    organization: r.organization,
    roleTitle: r.roleTitle,
    email: r.email,
    phone: r.phone,
    eventName: r.eventName,
    eventDate: r.eventDate,
    eventDateRaw: r.eventDateRaw,
    notes: r.notes,
    createdAt: r.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Memory Store CRUD Operations matching repo.ts
// ---------------------------------------------------------------------------

export async function memoryCreateSource(input: {
  organizationId: string;
  name: string;
  sourceType: SourceRow["sourceType"];
  externalFileId: string | null;
  importedBy: string;
  fieldMapping: Record<string, string>;
}): Promise<string> {
  const id = randomUUID();
  const source: MemorySource = {
    id,
    organizationId: input.organizationId,
    name: input.name,
    sourceType: input.sourceType,
    externalFileId: input.externalFileId,
    importedBy: input.importedBy,
    importedAt: new Date().toISOString(),
    fieldMapping: input.fieldMapping,
  };
  state.sources.unshift(source);
  persistState();
  return id;
}

export async function memoryListSources(
  organizationId: string,
): Promise<SourceRow[]> {
  return state.sources
    .filter((s) => s.organizationId === organizationId)
    .map((s) => ({
      id: s.id,
      organizationId: s.organizationId,
      name: s.name,
      sourceType: s.sourceType,
      externalFileId: s.externalFileId,
      importedAt: s.importedAt,
      recordsCount: state.rawRecords.filter((r) => r.sourceId === s.id).length,
    }));
}

export async function memoryInsertRawRecord(
  rec: NewRawRecord,
): Promise<string> {
  const id = randomUUID();
  const raw: MemoryRawRecord = {
    id,
    sourceId: rec.sourceId,
    organizationId: rec.organizationId,
    rowNumber: rec.rowNumber,
    rawData: rec.rawData,
    fullName: rec.fullName,
    organization: rec.organization,
    roleTitle: rec.roleTitle,
    email: rec.email,
    phone: rec.phone,
    eventName: rec.eventName,
    eventDate: rec.eventDate,
    eventDateRaw: rec.eventDateRaw,
    notes: rec.notes,
    normalizedText: rec.normalizedText,
    embedding: rec.embedding,
    createdAt: new Date().toISOString(),
  };
  state.rawRecords.push(raw);
  persistState();
  return id;
}

export async function memoryGetRawRecordsForEntity(
  organizationId: string,
  entityId: string,
): Promise<RawRecordRow[]> {
  const linkedIds = state.rawToCanonical
    .filter(
      (l) =>
        l.canonicalEntityId === entityId && l.organizationId === organizationId,
    )
    .map((l) => l.rawRecordId);

  return state.rawRecords
    .filter((r) => linkedIds.includes(r.id) && r.organizationId === organizationId)
    .sort((a, b) => {
      if (a.eventDate && b.eventDate) {
        return b.eventDate.localeCompare(a.eventDate);
      }
      return b.createdAt.localeCompare(a.createdAt);
    })
    .map(mapRawRecordRow);
}

export async function memoryGetRawRecordById(
  organizationId: string,
  recordId: string,
): Promise<RawRecordRow | null> {
  const rec = state.rawRecords.find(
    (r) => r.id === recordId && r.organizationId === organizationId,
  );
  return rec ? mapRawRecordRow(rec) : null;
}

export async function memoryGetEmbeddingsForEntity(
  entityId: string,
): Promise<number[][]> {
  const linkedIds = state.rawToCanonical
    .filter((l) => l.canonicalEntityId === entityId)
    .map((l) => l.rawRecordId);

  return state.rawRecords
    .filter((r) => linkedIds.includes(r.id) && r.embedding && r.embedding.length > 0)
    .map((r) => r.embedding);
}

export async function memoryCreateCanonicalEntity(input: {
  organizationId: string;
  entityType: string;
  displayName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  primaryOrganization: string | null;
  primaryRole: string | null;
  embedding: number[];
}): Promise<string> {
  const id = randomUUID();
  const entity: MemoryCanonicalEntity = {
    id,
    organizationId: input.organizationId,
    entityType: input.entityType,
    displayName: input.displayName,
    primaryEmail: input.primaryEmail,
    primaryPhone: input.primaryPhone,
    primaryOrganization: input.primaryOrganization,
    primaryRole: input.primaryRole,
    embedding: input.embedding,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.canonicalEntities.push(entity);
  persistState();
  return id;
}

export async function memoryLinkRecordToEntity(input: {
  rawRecordId: string;
  canonicalEntityId: string;
  organizationId: string;
  linkMethod: "seed" | "approved_merge";
}): Promise<void> {
  const idx = state.rawToCanonical.findIndex(
    (l) => l.rawRecordId === input.rawRecordId,
  );
  if (idx >= 0) {
    state.rawToCanonical[idx] = {
      rawRecordId: input.rawRecordId,
      canonicalEntityId: input.canonicalEntityId,
      organizationId: input.organizationId,
      linkMethod: input.linkMethod,
      linkedAt: new Date().toISOString(),
    };
  } else {
    state.rawToCanonical.push({
      rawRecordId: input.rawRecordId,
      canonicalEntityId: input.canonicalEntityId,
      organizationId: input.organizationId,
      linkMethod: input.linkMethod,
      linkedAt: new Date().toISOString(),
    });
  }
  persistState();
}

export async function memoryUpdateEntityCentroid(
  entityId: string,
  embedding: number[],
): Promise<void> {
  const e = state.canonicalEntities.find((item) => item.id === entityId);
  if (e) {
    e.embedding = embedding;
    e.updatedAt = new Date().toISOString();
    persistState();
  }
}

export async function memoryEnrichEntityFromRecord(
  entityId: string,
  record: RawRecordRow,
): Promise<void> {
  const e = state.canonicalEntities.find((item) => item.id === entityId);
  if (e) {
    if (!e.primaryEmail && record.email) e.primaryEmail = record.email;
    if (!e.primaryPhone && record.phone) e.primaryPhone = record.phone;
    if (!e.primaryOrganization && record.organization)
      e.primaryOrganization = record.organization;
    if (!e.primaryRole && record.roleTitle) e.primaryRole = record.roleTitle;
    e.updatedAt = new Date().toISOString();
    persistState();
  }
}

export async function memoryListEntities(
  organizationId: string,
  opts: ListEntitiesOptions,
): Promise<{ entities: CanonicalEntityRow[]; total: number }> {
  let list = state.canonicalEntities.filter(
    (e) => e.organizationId === organizationId,
  );

  if (opts.predicateParams && opts.predicateParams.length > 0) {
    const q = String(opts.predicateParams[0] ?? "").toLowerCase().replace(/%/g, "");
    if (q) {
      list = list.filter((e) => {
        const dName = (e.displayName ?? "").toLowerCase();
        const pOrg = (e.primaryOrganization ?? "").toLowerCase();
        const pRole = (e.primaryRole ?? "").toLowerCase();
        const pEmail = (e.primaryEmail ?? "").toLowerCase();
        const pPhone = (e.primaryPhone ?? "").toLowerCase();
        return (
          dName.includes(q) ||
          pOrg.includes(q) ||
          pRole.includes(q) ||
          pEmail.includes(q) ||
          pPhone.includes(q)
        );
      });
    }
  }

  const mapped = list.map((e) => mapCanonicalEntityRow(e, organizationId));
  mapped.sort((a, b) => {
    if (b.eventCount !== a.eventCount) return b.eventCount - a.eventCount;
    return a.displayName.localeCompare(b.displayName);
  });

  const total = mapped.length;
  const paginated = mapped.slice(opts.offset, opts.offset + opts.limit);
  return { entities: paginated, total };
}

export async function memoryGetEntityById(
  organizationId: string,
  entityId: string,
): Promise<CanonicalEntityRow | null> {
  const e = state.canonicalEntities.find(
    (item) => item.id === entityId && item.organizationId === organizationId,
  );
  return e ? mapCanonicalEntityRow(e, organizationId) : null;
}

export async function memoryFindCandidateEntitiesByVector(
  organizationId: string,
  rawRecordId: string,
  embedding: number[],
  topN: number,
): Promise<CandidateEntity[]> {
  const existingSuggestionEntityIds = new Set(
    state.mergeSuggestions
      .filter(
        (ms) =>
          ms.organizationId === organizationId &&
          ms.candidateRawRecordId === rawRecordId,
      )
      .map((ms) => ms.canonicalEntityId),
  );

  const candidates: CandidateEntity[] = [];

  for (const e of state.canonicalEntities) {
    if (e.organizationId !== organizationId) continue;
    if (!e.embedding || e.embedding.length === 0) continue;
    if (existingSuggestionEntityIds.has(e.id)) continue;

    const sim = cosineSimilarity(embedding, e.embedding);
    candidates.push({
      entity: mapCanonicalEntityRow(e, organizationId),
      similarity: sim,
      viaBlocking: false,
    });
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, topN);
}

export async function memoryFindCandidateEntitiesByIdentifier(
  organizationId: string,
  rawRecordId: string,
  email: string,
  phone: string,
): Promise<CandidateEntity[]> {
  if (!email && !phone) return [];

  const normEmail = email.trim().toLowerCase();
  const normPhone = phone.replace(/\D/g, "");

  const existingSuggestionEntityIds = new Set(
    state.mergeSuggestions
      .filter(
        (ms) =>
          ms.organizationId === organizationId &&
          ms.candidateRawRecordId === rawRecordId,
      )
      .map((ms) => ms.canonicalEntityId),
  );

  const candidates: CandidateEntity[] = [];

  for (const e of state.canonicalEntities) {
    if (e.organizationId !== organizationId) continue;
    if (existingSuggestionEntityIds.has(e.id)) continue;

    const entEmail = (e.primaryEmail ?? "").trim().toLowerCase();
    const entPhone = (e.primaryPhone ?? "").replace(/\D/g, "");

    const matchEmail = Boolean(normEmail && entEmail === normEmail);
    const matchPhone = Boolean(normPhone && entPhone === normPhone);

    if (matchEmail || matchPhone) {
      candidates.push({
        entity: mapCanonicalEntityRow(e, organizationId),
        similarity: 1.0,
        viaBlocking: true,
      });
    }
  }

  return candidates.slice(0, 5);
}

export async function memoryInsertMergeSuggestion(input: {
  organizationId: string;
  canonicalEntityId: string;
  candidateRawRecordId: string;
  vectorSimilarity: number;
  llmConfidence: number;
  combinedConfidence: number;
  llmVerdict: boolean;
  reasoning: string;
}): Promise<boolean> {
  const existing = state.mergeSuggestions.find(
    (ms) =>
      ms.canonicalEntityId === input.canonicalEntityId &&
      ms.candidateRawRecordId === input.candidateRawRecordId,
  );
  if (existing) return false;

  const id = randomUUID();
  state.mergeSuggestions.push({
    id,
    organizationId: input.organizationId,
    canonicalEntityId: input.canonicalEntityId,
    candidateRawRecordId: input.candidateRawRecordId,
    vectorSimilarity: input.vectorSimilarity,
    llmConfidence: input.llmConfidence,
    combinedConfidence: input.combinedConfidence,
    llmVerdict: input.llmVerdict,
    reasoning: input.reasoning,
    status: "pending",
    decidedAt: null,
    decidedBy: null,
    createdAt: new Date().toISOString(),
  });
  persistState();
  return true;
}

export async function memoryListPendingSuggestions(
  organizationId: string,
  limit = 50,
): Promise<MergeSuggestionRow[]> {
  const pending = state.mergeSuggestions
    .filter(
      (ms) => ms.organizationId === organizationId && ms.status === "pending",
    )
    .sort((a, b) => b.combinedConfidence - a.combinedConfidence)
    .slice(0, limit);

  const result: MergeSuggestionRow[] = [];
  for (const s of pending) {
    const entity = state.canonicalEntities.find(
      (e) => e.id === s.canonicalEntityId && e.organizationId === organizationId,
    );
    const rawRec = state.rawRecords.find(
      (r) =>
        r.id === s.candidateRawRecordId && r.organizationId === organizationId,
    );
    if (!entity || !rawRec) continue;

    result.push({
      id: s.id,
      canonicalEntityId: s.canonicalEntityId,
      candidateRawRecordId: s.candidateRawRecordId,
      vectorSimilarity: s.vectorSimilarity,
      llmConfidence: s.llmConfidence,
      combinedConfidence: s.combinedConfidence,
      llmVerdict: s.llmVerdict,
      reasoning: s.reasoning,
      status: s.status,
      createdAt: s.createdAt,
      canonicalEntity: mapCanonicalEntityRow(entity, organizationId),
      candidateRecord: mapRawRecordRow(rawRec),
    });
  }

  return result;
}

export async function memoryGetSuggestionForUpdate(
  organizationId: string,
  suggestionId: string,
): Promise<{
  id: string;
  canonicalEntityId: string;
  candidateRawRecordId: string;
  status: string;
} | null> {
  const s = state.mergeSuggestions.find(
    (item) => item.id === suggestionId && item.organizationId === organizationId,
  );
  return s
    ? {
        id: s.id,
        canonicalEntityId: s.canonicalEntityId,
        candidateRawRecordId: s.candidateRawRecordId,
        status: s.status,
      }
    : null;
}

export async function memorySetSuggestionStatus(
  suggestionId: string,
  status: "approved" | "rejected",
  decidedBy: string,
): Promise<void> {
  const s = state.mergeSuggestions.find((item) => item.id === suggestionId);
  if (s) {
    s.status = status;
    s.decidedAt = new Date().toISOString();
    s.decidedBy = decidedBy;
    persistState();
  }
}

export async function memoryMarkAutoRejected(
  canonicalEntityId: string,
  candidateRawRecordId: string,
): Promise<void> {
  for (const s of state.mergeSuggestions) {
    if (
      s.canonicalEntityId === canonicalEntityId &&
      s.candidateRawRecordId === candidateRawRecordId &&
      s.status === "pending"
    ) {
      s.status = "rejected";
      s.decidedAt = new Date().toISOString();
      s.decidedBy = "gemini_stage2";
    }
  }
  persistState();
}

export async function memoryRejectSupersededSuggestions(
  candidateRawRecordId: string,
  excludeSuggestionId: string,
): Promise<void> {
  for (const s of state.mergeSuggestions) {
    if (
      s.candidateRawRecordId === candidateRawRecordId &&
      s.status === "pending" &&
      s.id !== excludeSuggestionId
    ) {
      s.status = "rejected";
      s.decidedAt = new Date().toISOString();
      s.decidedBy = "superseded";
    }
  }
  persistState();
}

export async function memoryReassignRecordToEntity(input: {
  rawRecordId: string;
  targetEntityId: string;
  organizationId: string;
}): Promise<{ removedEntityId: string | null }> {
  const currentLink = state.rawToCanonical.find(
    (l) => l.rawRecordId === input.rawRecordId,
  );
  const previousEntityId = currentLink?.canonicalEntityId ?? null;

  if (currentLink) {
    currentLink.canonicalEntityId = input.targetEntityId;
    currentLink.linkMethod = "approved_merge";
    currentLink.linkedAt = new Date().toISOString();
  } else {
    state.rawToCanonical.push({
      rawRecordId: input.rawRecordId,
      canonicalEntityId: input.targetEntityId,
      organizationId: input.organizationId,
      linkMethod: "approved_merge",
      linkedAt: new Date().toISOString(),
    });
  }

  if (!previousEntityId || previousEntityId === input.targetEntityId) {
    persistState();
    return { removedEntityId: null };
  }

  const remaining = state.rawToCanonical.filter(
    (l) => l.canonicalEntityId === previousEntityId,
  ).length;

  if (remaining === 0) {
    const idx = state.canonicalEntities.findIndex(
      (e) => e.id === previousEntityId,
    );
    if (idx >= 0) {
      state.canonicalEntities.splice(idx, 1);
    }
    persistState();
    return { removedEntityId: previousEntityId };
  }

  persistState();
  return { removedEntityId: null };
}

export async function memoryGetStats(
  organizationId: string,
): Promise<StatsSummary> {
  const totalEntities = state.canonicalEntities.filter(
    (e) => e.organizationId === organizationId,
  ).length;
  const totalRaw = state.rawRecords.filter(
    (r) => r.organizationId === organizationId,
  ).length;
  const totalSources = state.sources.filter(
    (s) => s.organizationId === organizationId,
  ).length;
  const pendingMerges = state.mergeSuggestions.filter(
    (ms) => ms.organizationId === organizationId && ms.status === "pending",
  ).length;

  const linkedRawSet = new Set(
    state.rawToCanonical
      .filter((l) => l.organizationId === organizationId)
      .map((l) => l.rawRecordId),
  );
  const linkedRaw = linkedRawSet.size;

  const bySourceTypeMap = new Map<
    string,
    { fileCount: number; recordCount: number }
  >();
  for (const s of state.sources.filter((s) => s.organizationId === organizationId)) {
    const recs = state.rawRecords.filter((r) => r.sourceId === s.id).length;
    const cur = bySourceTypeMap.get(s.sourceType) ?? {
      fileCount: 0,
      recordCount: 0,
    };
    cur.fileCount += 1;
    cur.recordCount += recs;
    bySourceTypeMap.set(s.sourceType, cur);
  }

  const bySourceType = Array.from(bySourceTypeMap.entries()).map(
    ([sourceType, data]) => ({
      sourceType,
      fileCount: data.fileCount,
      recordCount: data.recordCount,
    }),
  );

  return {
    totalCanonicalEntities: totalEntities,
    totalRawRecords: totalRaw,
    dedupRatePercent:
      linkedRaw > 0
        ? Number((((linkedRaw - totalEntities) / linkedRaw) * 100).toFixed(1))
        : 0,
    sourceFilesProcessed: totalSources,
    pendingMergeSuggestions: pendingMerges,
    bySourceType,
  };
}

export function memoryHasData(organizationId: string): boolean {
  return (
    state.canonicalEntities.some((e) => e.organizationId === organizationId) ||
    state.sources.some((s) => s.organizationId === organizationId)
  );
}
