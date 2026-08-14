/** Mirrors server/types.ts. Keep the two in sync when changing an API shape. */

export interface AuthUser {
  uid: string;
  email: string;
  organizationId: string;
}

export interface CanonicalEntity {
  id: string;
  organizationId: string;
  entityType: string;
  displayName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  primaryOrganization: string | null;
  primaryRole: string | null;
  eventCount: number;
  sourceFileCount: number;
  recordCount: number;
  createdAt: string;
}

export interface RawRecord {
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

export interface MergeSuggestion {
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
  canonicalEntity: CanonicalEntity;
  candidateRecord: RawRecord;
}

export interface StatsSummary {
  totalCanonicalEntities: number;
  totalRawRecords: number;
  dedupRatePercent: number;
  sourceFilesProcessed: number;
  pendingMergeSuggestions: number;
  bySourceType: { sourceType: string; fileCount: number; recordCount: number }[];
}

export interface SourceRow {
  id: string;
  name: string;
  sourceType: string;
  externalFileId: string | null;
  importedAt: string;
  recordsCount: number;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  iconLink?: string;
  owners?: string;
  sizeBytes?: number;
}

export interface FieldMappingDetail {
  canonical_field: string;
  confidence: number;
  reasoning: string;
}

export interface PreviewPayload {
  sourceName: string;
  sourceType: "google_sheets" | "google_drive_xlsx" | "local_upload";
  externalFileId: string | null;
  sheetTitle: string;
  headers: string[];
  totalRows: number;
  sampleRows: string[][];
  rows: string[][];
  mapping: Record<string, FieldMappingDetail>;
  mappingSource: "gemini" | "unavailable";
  mappingError?: string;
}

export interface AppliedFilter {
  column: string;
  columnLabel: string;
  operator: string;
  operatorLabel: string;
  value: string;
}

export interface EntitySearchResponse {
  entities: CanonicalEntity[];
  total: number;
  page: number;
  limit: number;
  mode: "all" | "gemini" | "keyword";
  explanation: string | null;
  logic?: "AND" | "OR";
  filters: AppliedFilter[];
}

export interface ImportResult {
  status: string;
  message: string;
  sourceId: string;
  importedRecords: number;
  skippedRows: number;
  newEntities: number;
  suggestionsCreated: number;
  autoRejected: number;
  geminiCalls: number;
}

export interface HealthInfo {
  status: string;
  authMode: "dev" | "firebase";
  aiConfigured: boolean;
  geminiModel: string;
  embeddingModel: string;
  embeddingProvider: string;
}

export const CANONICAL_FIELD_OPTIONS = [
  { value: "full_name", label: "Họ và tên" },
  { value: "organization", label: "Đơn vị / Công ty" },
  { value: "role_title", label: "Chức danh / Vai trò" },
  { value: "email", label: "Địa chỉ Email" },
  { value: "phone", label: "Số điện thoại" },
  { value: "event_name", label: "Tên sự kiện" },
  { value: "event_date", label: "Ngày diễn ra" },
  { value: "notes", label: "Ghi chú" },
  { value: "ignore", label: "Bỏ qua cột này" },
] as const;
