export interface CanonicalEntity {
  id: string;
  displayName: string;
  primaryOrganization: string;
  primaryRole: string;
  primaryEmail: string;
  primaryPhone: string;
  eventCount: number;
  sourceFileCount: number;
  mergedRawRecordIds: string[];
  createdAt: string;
}

export interface RawRecord {
  id: string;
  sourceName: string;
  sourceType: string;
  eventName: string;
  eventDate: string;
  fullName: string;
  organization: string;
  roleTitle: string;
  email: string;
  phone: string;
  notes: string;
  importedAt: string;
}

export interface MergeSuggestion {
  id: string;
  canonicalEntityId: string;
  candidateRawRecordId: string;
  confidenceScore: number;
  reasoning: string;
  status: 'pending' | 'approved' | 'rejected';
  canonicalEntity: CanonicalEntity;
  candidateRecord: RawRecord;
}

export interface StatsSummary {
  totalCanonicalEntities: number;
  totalRawRecords: number;
  dedupRatePercent: number;
  sourceFilesProcessed: number;
  driveSheetsCount: number;
  localUploadCount: number;
}

export interface FieldMappingDetail {
  canonical_field: string;
  confidence: number;
  reasoning: string;
}

export interface SchemaMappingResult {
  mappings: Record<string, FieldMappingDetail>;
}

export interface DriveSourceFile {
  id: string;
  name: string;
  modifiedTime: string;
  recordsEstimate: number;
}
