package db

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// entityColumns is shared by every canonical-entity SELECT. The counts are
// correlated subqueries rather than stored columns: a stored counter goes stale
// the moment a merge is approved.
const entityColumns = `
	c.id,
	c.organization_id,
	c.entity_type,
	c.display_name,
	COALESCE(c.primary_email, ''),
	COALESCE(c.primary_phone, ''),
	COALESCE(c.primary_organization, ''),
	COALESCE(c.primary_role, ''),
	c.created_at,
	(SELECT COUNT(DISTINCT r.event_name)
	   FROM raw_to_canonical l JOIN raw_records r ON r.id = l.raw_record_id
	  WHERE l.canonical_entity_id = c.id AND r.event_name IS NOT NULL AND r.event_name <> ''),
	(SELECT COUNT(DISTINCT r.source_id)
	   FROM raw_to_canonical l JOIN raw_records r ON r.id = l.raw_record_id
	  WHERE l.canonical_entity_id = c.id),
	(SELECT COUNT(*) FROM raw_to_canonical l WHERE l.canonical_entity_id = c.id)
`

func scanEntity(row pgx.Row, e *CanonicalEntity) error {
	return row.Scan(&e.ID, &e.OrganizationID, &e.EntityType, &e.DisplayName,
		&e.PrimaryEmail, &e.PrimaryPhone, &e.PrimaryOrganization, &e.PrimaryRole,
		&e.CreatedAt, &e.EventCount, &e.SourceFileCount, &e.RecordCount)
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

func (d *DB) CreateSource(ctx context.Context, tx pgx.Tx, s Source, importedBy string, mappingJSON []byte) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `
		INSERT INTO sources (organization_id, name, source_type, external_file_id, imported_by, field_mapping)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,$6)
		RETURNING id`,
		s.OrganizationID, s.Name, s.SourceType, s.ExternalFileID, importedBy, mappingJSON,
	).Scan(&id)
	return id, err
}

func (d *DB) ListSources(ctx context.Context, orgID string) ([]Source, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT s.id, s.organization_id, s.name, s.source_type,
		       COALESCE(s.external_file_id, ''), s.imported_at,
		       (SELECT COUNT(*) FROM raw_records r WHERE r.source_id = s.id)
		FROM sources s
		WHERE s.organization_id = $1
		ORDER BY s.imported_at DESC`, orgID)
	if err != nil {
		return nil, fmt.Errorf("list sources: %w", err)
	}
	defer rows.Close()

	var out []Source
	for rows.Next() {
		var s Source
		if err := rows.Scan(&s.ID, &s.OrganizationID, &s.Name, &s.SourceType,
			&s.ExternalFileID, &s.ImportedAt, &s.RecordsCount); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// Raw records
// ---------------------------------------------------------------------------

type NewRawRecord struct {
	SourceID       string
	OrganizationID string
	RowNumber      int
	RawDataJSON    []byte
	FullName       string
	Organization   string
	RoleTitle      string
	Email          string
	Phone          string
	EventName      string
	EventDate      *time.Time
	EventDateRaw   string
	Notes          string
	NormalizedText string
	Embedding      []float32
}

func (d *DB) InsertRawRecord(ctx context.Context, tx pgx.Tx, r NewRawRecord) (string, error) {
	var id string
	var embedding any
	if len(r.Embedding) > 0 {
		embedding = vectorLiteral(r.Embedding)
	}
	err := tx.QueryRow(ctx, `
		INSERT INTO raw_records (
			source_id, organization_id, row_number, raw_data,
			full_name, organization, role_title, email, phone,
			event_name, event_date, event_date_raw, notes,
			normalized_text, embedding
		) VALUES ($1,$2,$3,$4,
		          NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),
		          NULLIF($10,''),$11,NULLIF($12,''),NULLIF($13,''),
		          $14,$15::vector)
		RETURNING id`,
		r.SourceID, r.OrganizationID, r.RowNumber, r.RawDataJSON,
		r.FullName, r.Organization, r.RoleTitle, r.Email, r.Phone,
		r.EventName, r.EventDate, r.EventDateRaw, r.Notes,
		r.NormalizedText, embedding,
	).Scan(&id)
	return id, err
}

const rawRecordColumns = `
	r.id, r.source_id, s.name, s.source_type, r.organization_id, r.row_number,
	COALESCE(r.full_name,''), COALESCE(r.organization,''), COALESCE(r.role_title,''),
	COALESCE(r.email,''), COALESCE(r.phone,''), COALESCE(r.event_name,''),
	r.event_date, COALESCE(r.event_date_raw,''), COALESCE(r.notes,''),
	r.normalized_text, r.created_at
`

func scanRawRecord(row pgx.Row, r *RawRecord) error {
	return row.Scan(&r.ID, &r.SourceID, &r.SourceName, &r.SourceType, &r.OrganizationID,
		&r.RowNumber, &r.FullName, &r.Organization, &r.RoleTitle, &r.Email, &r.Phone,
		&r.EventName, &r.EventDate, &r.EventDateRaw, &r.Notes, &r.NormalizedText, &r.CreatedAt)
}

func (d *DB) GetRawRecord(ctx context.Context, orgID, recordID string) (*RawRecord, error) {
	var r RawRecord
	row := d.Pool.QueryRow(ctx, `
		SELECT `+rawRecordColumns+`
		FROM raw_records r JOIN sources s ON s.id = r.source_id
		WHERE r.id = $1 AND r.organization_id = $2`, recordID, orgID)
	if err := scanRawRecord(row, &r); err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &r, nil
}

func (d *DB) GetRecordsForEntity(ctx context.Context, orgID, entityID string) ([]RawRecord, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT `+rawRecordColumns+`
		FROM raw_to_canonical l
		JOIN raw_records r ON r.id = l.raw_record_id
		JOIN sources s     ON s.id = r.source_id
		WHERE l.canonical_entity_id = $1 AND l.organization_id = $2
		ORDER BY r.event_date DESC NULLS LAST, r.created_at DESC`, entityID, orgID)
	if err != nil {
		return nil, fmt.Errorf("records for entity: %w", err)
	}
	defer rows.Close()

	var out []RawRecord
	for rows.Next() {
		var r RawRecord
		if err := scanRawRecord(rows, &r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// Canonical entities
// ---------------------------------------------------------------------------

func (d *DB) CreateCanonicalEntity(ctx context.Context, tx pgx.Tx, e CanonicalEntity, embedding []float32) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `
		INSERT INTO canonical_entities (
			organization_id, entity_type, display_name,
			primary_email, primary_phone, primary_organization, primary_role, embedding
		) VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),$8::vector)
		RETURNING id`,
		e.OrganizationID, e.EntityType, e.DisplayName,
		e.PrimaryEmail, e.PrimaryPhone, e.PrimaryOrganization, e.PrimaryRole,
		vectorLiteral(embedding),
	).Scan(&id)
	return id, err
}

func (d *DB) LinkRecordToEntity(ctx context.Context, tx pgx.Tx, recordID, entityID, orgID, method string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO raw_to_canonical (raw_record_id, canonical_entity_id, organization_id, link_method)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (raw_record_id) DO NOTHING`, recordID, entityID, orgID, method)
	return err
}

// EnrichEntityFromRecord fills blank canonical fields from a merged record.
// Existing non-empty values win: a merge enriches, it never overwrites.
func (d *DB) EnrichEntityFromRecord(ctx context.Context, tx pgx.Tx, entityID string, r RawRecord) error {
	_, err := tx.Exec(ctx, `
		UPDATE canonical_entities SET
			primary_email        = COALESCE(NULLIF(primary_email,''), NULLIF($2,'')),
			primary_phone        = COALESCE(NULLIF(primary_phone,''), NULLIF($3,'')),
			primary_organization = COALESCE(NULLIF(primary_organization,''), NULLIF($4,'')),
			primary_role         = COALESCE(NULLIF(primary_role,''), NULLIF($5,'')),
			updated_at           = NOW()
		WHERE id = $1`, entityID, r.Email, r.Phone, r.Organization, r.RoleTitle)
	return err
}

func (d *DB) GetEntity(ctx context.Context, orgID, entityID string) (*CanonicalEntity, error) {
	var e CanonicalEntity
	row := d.Pool.QueryRow(ctx,
		`SELECT `+entityColumns+` FROM canonical_entities c WHERE c.id = $1 AND c.organization_id = $2`,
		entityID, orgID)
	if err := scanEntity(row, &e); err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &e, nil
}

// ListEntities applies an optional pre-built, parameterised predicate. The
// predicate SQL is assembled in internal/search from a fixed whitelist — it
// never contains user or model text.
func (d *DB) ListEntities(ctx context.Context, orgID string, predicate string, predicateArgs []any, limit, offset int) ([]CanonicalEntity, int, error) {
	args := append([]any{orgID}, predicateArgs...)
	where := ""
	if predicate != "" {
		where = " AND (" + predicate + ")"
	}

	var total int
	if err := d.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM canonical_entities c WHERE c.organization_id = $1`+where, args...,
	).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count entities: %w", err)
	}

	listArgs := append(append([]any{}, args...), limit, offset)
	rows, err := d.Pool.Query(ctx, fmt.Sprintf(`
		SELECT %s
		FROM canonical_entities c
		WHERE c.organization_id = $1%s
		ORDER BY (SELECT COUNT(DISTINCT r.event_name)
		            FROM raw_to_canonical l JOIN raw_records r ON r.id = l.raw_record_id
		           WHERE l.canonical_entity_id = c.id) DESC,
		         c.display_name ASC
		LIMIT $%d OFFSET $%d`, entityColumns, where, len(args)+1, len(args)+2), listArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("list entities: %w", err)
	}
	defer rows.Close()

	var out []CanonicalEntity
	for rows.Next() {
		var e CanonicalEntity
		if err := scanEntity(rows, &e); err != nil {
			return nil, 0, err
		}
		out = append(out, e)
	}
	return out, total, rows.Err()
}

// ---------------------------------------------------------------------------
// Stage 1 retrieval
// ---------------------------------------------------------------------------

// FindCandidatesByVector is Stage 1: pgvector cosine retrieval over canonical
// entities, using the HNSW index instead of O(n²) pairwise comparison.
//
// `<=>` is cosine distance and embeddings are unit-normalised on write, so
// 1 - distance is plain cosine similarity.
//
// The NOT EXISTS clause is the negative signal: any pair that already has a
// merge_suggestions row — pending, approved, or rejected — is excluded, so a
// rejected pair is never proposed again.
//
// Every one of those quals is invisible to the HNSW index, so pgvector applies
// them only after the approximate scan has chosen its candidate tuples. Import
// seeds one entity per row, which means a file listing the same person 100
// times fills the neighbourhood with near-zero-distance duplicates that the
// row_number qual then discards — and the one eligible earlier row need not be
// among them. runVectorScan therefore widens the scan first; see
// vectorScanSettings.
func (d *DB) FindCandidatesByVector(ctx context.Context, orgID, recordID, entityType string, embedding []float32, topN int) ([]CandidateEntity, error) {
	rows, release, err := d.runVectorScan(ctx, `
		SELECT `+entityColumns+`, 1 - (c.embedding <=> $2::vector) AS similarity
		FROM canonical_entities c
			WHERE c.organization_id = $1
			  AND c.entity_type = $5
			  AND c.embedding IS NOT NULL
			  AND NOT EXISTS (
			      SELECT 1 FROM raw_to_canonical own
			      WHERE own.canonical_entity_id = c.id AND own.raw_record_id = $3)
			  AND NOT EXISTS (
			      SELECT 1
			      FROM raw_to_canonical candidate_link
			      JOIN raw_records candidate_raw ON candidate_raw.id = candidate_link.raw_record_id
			      JOIN raw_records current_raw ON current_raw.id = $3
			      WHERE candidate_link.canonical_entity_id = c.id
			        AND candidate_raw.source_id = current_raw.source_id
			        AND candidate_raw.row_number >= current_raw.row_number)
		  AND NOT EXISTS (
		      SELECT 1 FROM merge_suggestions ms
		      WHERE ms.canonical_entity_id = c.id AND ms.candidate_raw_record_id = $3)
		ORDER BY c.embedding <=> $2::vector
			LIMIT $4`, orgID, vectorLiteral(embedding), recordID, topN, entityType)
	if err != nil {
		return nil, fmt.Errorf("vector retrieval: %w", err)
	}
	defer release()
	defer rows.Close()

	var out []CandidateEntity
	for rows.Next() {
		var c CandidateEntity
		if err := rows.Scan(&c.Entity.ID, &c.Entity.OrganizationID, &c.Entity.EntityType,
			&c.Entity.DisplayName, &c.Entity.PrimaryEmail, &c.Entity.PrimaryPhone,
			&c.Entity.PrimaryOrganization, &c.Entity.PrimaryRole, &c.Entity.CreatedAt,
			&c.Entity.EventCount, &c.Entity.SourceFileCount, &c.Entity.RecordCount,
			&c.Similarity); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// vectorScanSettings widens the HNSW scan so that quals pgvector can only
// apply after the fact still leave usable candidates.
//
// With pgvector 0.8.0+ the right tool is iterative scan: the index keeps
// returning batches until enough tuples survive the filters. strict_order (not
// relaxed_order) is required here because the query pairs ORDER BY distance
// with LIMIT, and relaxed ordering could let the LIMIT cut a nearer entity.
// On older servers there is no such mechanism, so the only lever is a much
// larger ef_search — mitigation, not a guarantee.
func vectorScanSettings(iterativeScan bool) []string {
	if iterativeScan {
		return []string{
			`SET LOCAL hnsw.iterative_scan = 'strict_order'`,
			`SET LOCAL hnsw.ef_search = 100`,
		}
	}
	return []string{`SET LOCAL hnsw.ef_search = 400`}
}

// runVectorScan executes an HNSW query with those settings applied. SET LOCAL
// needs a transaction, and the transaction has to outlive the pgx.Rows, so the
// caller gets a release func to call once it has finished scanning.
func (d *DB) runVectorScan(ctx context.Context, sql string, args ...any) (pgx.Rows, func(), error) {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("begin vector scan: %w", err)
	}
	release := func() { _ = tx.Rollback(ctx) } // read-only; nothing to commit
	for _, stmt := range vectorScanSettings(d.iterativeScan) {
		if _, err := tx.Exec(ctx, stmt); err != nil {
			release()
			return nil, nil, fmt.Errorf("tune vector scan (%s): %w", stmt, err)
		}
	}
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		release()
		return nil, nil, err
	}
	return rows, release, nil
}

// FindCandidatesByIdentifier blocks on exact email/phone. Cosine distance over
// "name | org | role" cannot see an email at all, so someone who changed both
// employer and job title would otherwise be missed despite an unambiguous
// identifier being present.
//
// Deliberately not filtered by entity_type. The type is *inferred* per row —
// a row is only "organization" when it happens to carry no name and no email —
// so the same organisation can enter the system under either type. An exact
// email or phone match is stronger evidence than that inference, and filtering
// on it would bypass blocking in exactly the ambiguous cases it exists for.
func (d *DB) FindCandidatesByIdentifier(ctx context.Context, orgID, recordID, email, phone string) ([]CandidateEntity, error) {
	if email == "" && phone == "" {
		return nil, nil
	}
	rows, err := d.Pool.Query(ctx, `
		SELECT `+entityColumns+`
		FROM canonical_entities c
			WHERE c.organization_id = $1
		  AND (($2 <> '' AND LOWER(c.primary_email) = $2)
		    OR ($3 <> '' AND regexp_replace(COALESCE(c.primary_phone,''), '[^0-9]', '', 'g') = $3))
			  AND NOT EXISTS (
			      SELECT 1 FROM merge_suggestions ms
			      WHERE ms.canonical_entity_id = c.id AND ms.candidate_raw_record_id = $4)
			  AND NOT EXISTS (
			      SELECT 1 FROM raw_to_canonical own
			      WHERE own.canonical_entity_id = c.id AND own.raw_record_id = $4)
			  AND NOT EXISTS (
			      SELECT 1
			      FROM raw_to_canonical candidate_link
			      JOIN raw_records candidate_raw ON candidate_raw.id = candidate_link.raw_record_id
			      JOIN raw_records current_raw ON current_raw.id = $4
			      WHERE candidate_link.canonical_entity_id = c.id
			        AND candidate_raw.source_id = current_raw.source_id
			        AND candidate_raw.row_number >= current_raw.row_number)
			LIMIT 5`, orgID, strings.ToLower(email), digitsOnly(phone), recordID)
	if err != nil {
		return nil, fmt.Errorf("identifier blocking: %w", err)
	}
	defer rows.Close()

	var out []CandidateEntity
	for rows.Next() {
		var c CandidateEntity
		if err := scanEntity(rows, &c.Entity); err != nil {
			return nil, err
		}
		c.Similarity = 1
		c.ViaBlocking = true
		out = append(out, c)
	}
	return out, rows.Err()
}

func digitsOnly(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
