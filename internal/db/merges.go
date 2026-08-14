package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

var (
	ErrNotFound = errors.New("không tìm thấy")
	ErrConflict = errors.New("đã được xử lý")
)

type NewMergeSuggestion struct {
	OrganizationID       string
	CanonicalEntityID    string
	CandidateRawRecordID string
	VectorSimilarity     float64
	LLMConfidence        float64
	CombinedConfidence   float64
	LLMVerdict           bool
	Reasoning            string
}

// InsertMergeSuggestion returns false when the pair already had a row. The
// unique index on (canonical_entity_id, candidate_raw_record_id) means a
// previously rejected pair is silently skipped rather than re-proposed.
func (d *DB) InsertMergeSuggestion(ctx context.Context, s NewMergeSuggestion) (bool, error) {
	tag, err := d.Pool.Exec(ctx, `
		INSERT INTO merge_suggestions (
			organization_id, canonical_entity_id, candidate_raw_record_id,
			vector_similarity, llm_confidence, combined_confidence, llm_verdict, reasoning
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (canonical_entity_id, candidate_raw_record_id) DO NOTHING`,
		s.OrganizationID, s.CanonicalEntityID, s.CandidateRawRecordID,
		s.VectorSimilarity, s.LLMConfidence, s.CombinedConfidence, s.LLMVerdict, s.Reasoning)
	if err != nil {
		return false, fmt.Errorf("insert merge suggestion: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// MarkAutoRejected records a Stage 2 "confidently not a match" as a permanent
// negative signal without human involvement. This never merges anything — it
// only stops the pair being re-adjudicated on every future import.
func (d *DB) MarkAutoRejected(ctx context.Context, entityID, recordID string) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE merge_suggestions
		SET status = 'rejected', decided_at = NOW(), decided_by = 'gemini_stage2'
		WHERE canonical_entity_id = $1 AND candidate_raw_record_id = $2 AND status = 'pending'`,
		entityID, recordID)
	return err
}

func (d *DB) ListPendingSuggestions(ctx context.Context, orgID string, limit int) ([]MergeSuggestion, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT id, organization_id, canonical_entity_id, candidate_raw_record_id,
		       vector_similarity, llm_confidence, combined_confidence,
		       llm_verdict, reasoning, status, created_at
		FROM merge_suggestions
		WHERE organization_id = $1 AND status = 'pending'
		ORDER BY combined_confidence DESC, created_at ASC
		LIMIT $2`, orgID, limit)
	if err != nil {
		return nil, fmt.Errorf("list suggestions: %w", err)
	}

	var out []MergeSuggestion
	for rows.Next() {
		var m MergeSuggestion
		if err := rows.Scan(&m.ID, &m.OrganizationID, &m.CanonicalEntityID, &m.CandidateRawRecordID,
			&m.VectorSimilarity, &m.LLMConfidence, &m.CombinedConfidence,
			&m.LLMVerdict, &m.Reasoning, &m.Status, &m.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Hydrate each side. Done after the cursor is closed so we are not holding a
	// connection open across further queries.
	hydrated := make([]MergeSuggestion, 0, len(out))
	for _, m := range out {
		entity, err := d.GetEntity(ctx, orgID, m.CanonicalEntityID)
		if err != nil {
			return nil, err
		}
		record, err := d.GetRawRecord(ctx, orgID, m.CandidateRawRecordID)
		if err != nil {
			return nil, err
		}
		if entity == nil || record == nil {
			continue // referenced row was deleted; skip quietly
		}
		m.Entity = *entity
		m.Record = *record
		hydrated = append(hydrated, m)
	}
	return hydrated, nil
}

// ApproveMerge moves the candidate record onto the target entity, absorbing and
// deleting the record's previous entity when it becomes empty. Returns the
// target entity id.
func (d *DB) ApproveMerge(ctx context.Context, orgID, suggestionID, decidedBy string) (string, error) {
	var targetEntityID string

	err := d.WithTx(ctx, func(tx pgx.Tx) error {
		var canonicalID, recordID, status string
		err := tx.QueryRow(ctx, `
			SELECT canonical_entity_id, candidate_raw_record_id, status
			FROM merge_suggestions
			WHERE id = $1 AND organization_id = $2
			FOR UPDATE`, suggestionID, orgID).Scan(&canonicalID, &recordID, &status)
		if err != nil {
			if err == pgx.ErrNoRows {
				return ErrNotFound
			}
			return err
		}
		if status != "pending" {
			return fmt.Errorf("%w (%s)", ErrConflict, status)
		}
		targetEntityID = canonicalID

		if _, err := tx.Exec(ctx, `
			UPDATE merge_suggestions SET status='approved', decided_at=NOW(), decided_by=$2
			WHERE id = $1`, suggestionID, decidedBy); err != nil {
			return err
		}

		var previousEntityID string
		err = tx.QueryRow(ctx,
			`SELECT canonical_entity_id FROM raw_to_canonical WHERE raw_record_id = $1`, recordID,
		).Scan(&previousEntityID)
		if err != nil && err != pgx.ErrNoRows {
			return err
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO raw_to_canonical (raw_record_id, canonical_entity_id, organization_id, link_method)
			VALUES ($1,$2,$3,'approved_merge')
			ON CONFLICT (raw_record_id)
			DO UPDATE SET canonical_entity_id = EXCLUDED.canonical_entity_id,
			              link_method = 'approved_merge', linked_at = NOW()`,
			recordID, canonicalID, orgID); err != nil {
			return err
		}

		// Absorb the record's old single-record entity if nothing is left on it.
		if previousEntityID != "" && previousEntityID != canonicalID {
			var remaining int
			if err := tx.QueryRow(ctx,
				`SELECT COUNT(*) FROM raw_to_canonical WHERE canonical_entity_id = $1`, previousEntityID,
			).Scan(&remaining); err != nil {
				return err
			}
			if remaining == 0 {
				if _, err := tx.Exec(ctx, `DELETE FROM canonical_entities WHERE id = $1`, previousEntityID); err != nil {
					return err
				}
			}
		}

		var rec RawRecord
		row := tx.QueryRow(ctx, `
			SELECT `+rawRecordColumns+`
			FROM raw_records r JOIN sources s ON s.id = r.source_id
			WHERE r.id = $1`, recordID)
		if err := scanRawRecord(row, &rec); err == nil {
			if err := d.EnrichEntityFromRecord(ctx, tx, canonicalID, rec); err != nil {
				return err
			}
		} else if err != pgx.ErrNoRows {
			return err
		}

		// Any other pending suggestion for this record is moot now.
		_, err = tx.Exec(ctx, `
			UPDATE merge_suggestions
			SET status='rejected', decided_at=NOW(), decided_by='superseded'
			WHERE candidate_raw_record_id = $1 AND status = 'pending' AND id <> $2`,
			recordID, suggestionID)
		return err
	})
	if err != nil {
		return "", err
	}
	return targetEntityID, nil
}

// RejectMerge keeps the row with status='rejected'. Combined with the unique
// pair index, that is what prevents the same pair being suggested again.
func (d *DB) RejectMerge(ctx context.Context, orgID, suggestionID, decidedBy string) error {
	return d.WithTx(ctx, func(tx pgx.Tx) error {
		var status string
		err := tx.QueryRow(ctx, `
			SELECT status FROM merge_suggestions
			WHERE id = $1 AND organization_id = $2 FOR UPDATE`, suggestionID, orgID).Scan(&status)
		if err != nil {
			if err == pgx.ErrNoRows {
				return ErrNotFound
			}
			return err
		}
		if status != "pending" {
			return fmt.Errorf("%w (%s)", ErrConflict, status)
		}
		_, err = tx.Exec(ctx, `
			UPDATE merge_suggestions SET status='rejected', decided_at=NOW(), decided_by=$2
			WHERE id = $1`, suggestionID, decidedBy)
		return err
	})
}
