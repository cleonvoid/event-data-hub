package db

import (
	"context"
	"fmt"
	"math"
)

func (d *DB) GetStats(ctx context.Context, orgID string) (Stats, error) {
	var s Stats

	err := d.Pool.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM canonical_entities WHERE organization_id = $1),
			(SELECT COUNT(*) FROM raw_records        WHERE organization_id = $1),
			(SELECT COUNT(*) FROM sources            WHERE organization_id = $1),
			(SELECT COUNT(*) FROM merge_suggestions
			  WHERE organization_id = $1 AND status = 'pending')`, orgID,
	).Scan(&s.TotalCanonicalEntities, &s.TotalRawRecords, &s.SourceFilesProcessed, &s.PendingMergeSuggestions)
	if err != nil {
		return s, fmt.Errorf("stats: %w", err)
	}

	// Share of raw records collapsed away by approved merges. 0 when nothing
	// has been deduplicated yet, which is the honest answer before review.
	if s.TotalRawRecords > 0 {
		rate := float64(s.TotalRawRecords-s.TotalCanonicalEntities) / float64(s.TotalRawRecords) * 100
		s.DedupRatePercent = math.Round(rate*10) / 10
	}

	rows, err := d.Pool.Query(ctx, `
		SELECT s.source_type, COUNT(DISTINCT s.id), COUNT(r.id)
		FROM sources s
		LEFT JOIN raw_records r ON r.source_id = s.id
		WHERE s.organization_id = $1
		GROUP BY s.source_type
		ORDER BY s.source_type`, orgID)
	if err != nil {
		return s, fmt.Errorf("stats by source type: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var st SourceTypeStat
		if err := rows.Scan(&st.SourceType, &st.FileCount, &st.RecordCount); err != nil {
			return s, err
		}
		s.BySourceType = append(s.BySourceType, st)
	}
	return s, rows.Err()
}
