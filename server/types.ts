/** Canonical schema field ids. 'ignore' means "do not import this column". */
export const CANONICAL_FIELDS = [
  "full_name",
  "organization",
  "role_title",
  "email",
  "phone",
  "event_name",
  "event_date",
  "notes",
  "ignore",
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

export function isCanonicalField(v: unknown): v is CanonicalField {
  return typeof v === "string" && (CANONICAL_FIELDS as readonly string[]).includes(v);
}

export interface FieldMappingDetail {
  canonical_field: CanonicalField;
  confidence: number;
  reasoning: string;
}

export interface SchemaMappingResult {
  mappings: Record<string, FieldMappingDetail>;
}

export interface AuthUser {
  uid: string;
  email: string;
  organizationId: string;
}

export interface SourceRow {
  id: string;
  organizationId: string;
  name: string;
  sourceType: "google_sheets" | "google_drive_xlsx" | "local_upload";
  externalFileId: string | null;
  importedAt: string;
  recordsCount: number;
}

export interface RawRecordRow {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
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
  createdAt: string;
}

export interface CanonicalEntityRow {
  id: string;
  organizationId: string;
  entityType: string;
  displayName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  primaryOrganization: string | null;
  primaryRole: string | null;
  /** Derived at query time from raw_to_canonical, never stored. */
  eventCount: number;
  sourceFileCount: number;
  recordCount: number;
  createdAt: string;
}

export interface MergeSuggestionRow {
  id: string;
  canonicalEntityId: string;
  candidateRawRecordId: string;
  vectorSimilarity: number;
  llmConfidence: number;
  combinedConfidence: number;
  llmVerdict: boolean;
  reasoning: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  canonicalEntity: CanonicalEntityRow;
  candidateRecord: RawRecordRow;
}

export interface StatsSummary {
  totalCanonicalEntities: number;
  totalRawRecords: number;
  dedupRatePercent: number;
  sourceFilesProcessed: number;
  pendingMergeSuggestions: number;
  bySourceType: { sourceType: string; fileCount: number; recordCount: number }[];
}

/** A single validated predicate produced by the NL search translator. */
export interface SearchFilter {
  column: string;
  operator: string;
  value: string | number;
}
