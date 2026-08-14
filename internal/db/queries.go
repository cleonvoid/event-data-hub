package db

import (
	"context"
	"fmt"

	"github.com/pgvector/pgvector-go"
)

type Source struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	SourceType     string `json:"source_type"`
	ExternalFileID string `json:"external_file_id"`
	OrganizationID string `json:"organization_id"`
	ImportedAt     string `json:"imported_at"`
}

type RawRecord struct {
	ID             string `json:"id"`
	SourceID       string `json:"source_id"`
	RawDataJSON    string `json:"raw_data"`
	EventName      string `json:"event_name"`
	EventDate      string `json:"event_date"`
	FullName       string `json:"full_name"`
	Organization   string `json:"organization"`
	RoleTitle      string `json:"role_title"`
	Email          string `json:"email"`
	Phone          string `json:"phone"`
	Notes          string `json:"notes"`
	NormalizedText string `json:"normalized_text"`
}

type CanonicalEntity struct {
	ID                  string `json:"id"`
	OrganizationID      string `json:"organization_id"`
	EntityType          string `json:"entity_type"`
	DisplayName         string `json:"display_name"`
	PrimaryEmail        string `json:"primary_email"`
	PrimaryPhone        string `json:"primary_phone"`
	PrimaryOrganization string `json:"primary_organization"`
	PrimaryRole         string `json:"primary_role"`
	EventCount          int    `json:"event_count"`
	SourceFileCount     int    `json:"source_file_count"`
	CreatedAt           string `json:"created_at"`
}

type MergeSuggestion struct {
	ID                    string          `json:"id"`
	CanonicalEntityID     string          `json:"canonical_entity_id"`
	CandidateRawRecordID  string          `json:"candidate_raw_record_id"`
	ConfidenceScore       float64         `json:"confidence_score"`
	Reasoning             string          `json:"reasoning"`
	Status                string          `json:"status"`
	CanonicalEntity       CanonicalEntity `json:"canonical_entity"`
	CandidateRecord       RawRecord       `json:"candidate_record"`
}

type StatsSummary struct {
	TotalCanonicalEntities int `json:"total_canonical_entities"`
	TotalRawRecords        int `json:"total_raw_records"`
	DedupRatePercent       float64 `json:"dedup_rate_percent"`
	SourceFilesProcessed   int `json:"source_files_processed"`
	DriveSheetsCount       int `json:"drive_sheets_count"`
	LocalUploadCount       int `json:"local_upload_count"`
}

// Stage 1: Retrieve Top-N similar canonical entities using pgvector cosine distance
func (db *DB) FindTopNCandidatesByVector(ctx context.Context, embedding []float32, topN int, orgID string) ([]CanonicalEntity, error) {
	if db.Pool == nil {
		return []CanonicalEntity{}, nil
	}

	vec := pgvector.NewVector(embedding)
	query := `
		SELECT c.id, c.organization_id, c.entity_type, c.display_name, 
		       COALESCE(c.primary_email, ''), COALESCE(c.primary_phone, ''),
		       COALESCE(c.primary_organization, ''), COALESCE(c.primary_role, ''),
		       c.event_count, c.source_file_count
		FROM canonical_entities c
		JOIN raw_to_canonical rtc ON c.id = rtc.canonical_entity_id
		JOIN raw_records r ON rtc.raw_record_id = r.id
		WHERE c.organization_id = $1
		ORDER BY r.embedding <=> $2 ASC
		LIMIT $3
	`

	rows, err := db.Pool.Query(ctx, query, orgID, vec, topN)
	if err != nil {
		return nil, fmt.Errorf("vector similarity search failed: %w", err)
	}
	defer rows.Close()

	var candidates []CanonicalEntity
	for rows.Next() {
		var e CanonicalEntity
		if err := rows.Scan(&e.ID, &e.OrganizationID, &e.EntityType, &e.DisplayName,
			&e.PrimaryEmail, &e.PrimaryPhone, &e.PrimaryOrganization, &e.PrimaryRole,
			&e.EventCount, &e.SourceFileCount); err != nil {
			return nil, err
		}
		candidates = append(candidates, e)
	}
	return candidates, nil
}

func (db *DB) GetStats(ctx context.Context, orgID string) (*StatsSummary, error) {
	if db.Pool == nil {
		// Mock stats for preview environment fallback
		return &StatsSummary{
			TotalCanonicalEntities: 142,
			TotalRawRecords:        318,
			DedupRatePercent:       55.3,
			SourceFilesProcessed:   12,
			DriveSheetsCount:       8,
			LocalUploadCount:       4,
		}, nil
	}

	var stats StatsSummary
	err := db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM canonical_entities WHERE organization_id = $1`, orgID).Scan(&stats.TotalCanonicalEntities)
	if err != nil {
		return nil, err
	}

	err = db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM raw_records r JOIN sources s ON r.source_id = s.id WHERE s.organization_id = $1`, orgID).Scan(&stats.TotalRawRecords)
	if err != nil {
		return nil, err
	}

	err = db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM sources WHERE organization_id = $1`, orgID).Scan(&stats.SourceFilesProcessed)
	if err != nil {
		return nil, err
	}

	if stats.TotalRawRecords > 0 {
		stats.DedupRatePercent = float64(stats.TotalRawRecords-stats.TotalCanonicalEntities) / float64(stats.TotalRawRecords) * 100.0
	}

	return &stats, nil
}
