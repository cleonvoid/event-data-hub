// Package resolution implements the two-stage entity resolution pipeline.
//
//	Stage 1  pgvector cosine retrieval over canonical entities → top-N candidates.
//	         O(log n) via the HNSW index instead of O(n²) pairwise comparison.
//	Stage 2  Gemini adjudicates ONLY that shortlist and returns a structured
//	         verdict plus a human-readable reason.
//
// Nothing here merges automatically. Every surviving candidate becomes a
// merge_suggestion a person has to approve or reject.
package resolution

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"event-data-hub/internal/ai"
	"event-data-hub/internal/config"
	"event-data-hub/internal/db"
	"event-data-hub/internal/normalize"
)

// autoRejectConfidence is the bar above which the model's "not a match" is
// trusted enough to record a permanent negative signal without asking a human.
// Below it the pair is still shown for review, because an uncertain no is
// exactly the case a person should look at.
const autoRejectConfidence = 0.75

type Service struct {
	DB  *db.DB
	AI  *ai.Client
	Cfg config.Config
}

// CombineConfidence blends the two stages into one score.
//
// Weighting rationale: the vector only ever saw "name | organization | role",
// so it is a recall device — good at surfacing candidates, weak at deciding.
// The LLM additionally sees email and phone, which are the actual identifying
// evidence in this data, so it carries the larger weight. The vector term is
// kept because a high-similarity pair the model is lukewarm about should still
// rank above a low-similarity one it is equally lukewarm about.
func CombineConfidence(vectorSimilarity, llmConfidence float64, llmVerdict bool) float64 {
	// The model's confidence is in its verdict; convert to P(same entity).
	pSame := llmConfidence
	if !llmVerdict {
		pSame = 1 - llmConfidence
	}
	v := vectorSimilarity
	if v < 0 {
		v = 0
	}
	if v > 1 {
		v = 1
	}
	return 0.35*v + 0.65*pSame
}

type ParsedRow struct {
	RowNumber      int
	RawData        map[string]string
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
}

// ParseRows applies the user-confirmed mapping to the sheet rows.
//
// Multiple source columns may map to the same canonical field (two "Ghi chú"
// columns, say); their values are joined rather than one silently winning. The
// full original row is preserved in RawData regardless of mapping.
func ParseRows(headers []string, rows [][]string, mapping map[string]string, fallbackEventName string) []ParsedRow {
	out := make([]ParsedRow, 0, len(rows))

	for i, row := range rows {
		rawData := make(map[string]string, len(headers))
		collected := map[string][]string{}

		for c, header := range headers {
			var value string
			if c < len(row) {
				value = normalize.Cell(row[c])
			}
			rawData[header] = value

			target := mapping[header]
			if target == "" || target == "ignore" || !ai.IsCanonicalField(target) || value == "" {
				continue
			}
			collected[target] = append(collected[target], value)
		}

		take := func(field string) string {
			return joinValues(collected[field])
		}

		fullName := take("full_name")
		email := normalize.Email(take("email"))

		// A row with neither a name nor an email identifies nobody — skip it
		// rather than manufacturing a placeholder entity.
		if fullName == "" && email == "" {
			continue
		}

		organization := take("organization")
		roleTitle := take("role_title")
		eventDateRaw := take("event_date")
		eventName := take("event_name")
		if eventName == "" {
			eventName = fallbackEventName
		}

		out = append(out, ParsedRow{
			RowNumber:      i + 1,
			RawData:        rawData,
			FullName:       fullName,
			Organization:   organization,
			RoleTitle:      roleTitle,
			Email:          email,
			Phone:          normalize.Phone(take("phone")),
			EventName:      eventName,
			EventDate:      normalize.EventDate(eventDateRaw),
			EventDateRaw:   eventDateRaw,
			Notes:          take("notes"),
			NormalizedText: normalize.Identity(fullName, organization, roleTitle),
		})
	}
	return out
}

func joinValues(v []string) string {
	switch len(v) {
	case 0:
		return ""
	case 1:
		return v[0]
	default:
		out := v[0]
		for _, s := range v[1:] {
			out += " / " + s
		}
		return out
	}
}

type ImportInput struct {
	OrganizationID string
	ImportedBy     string
	SourceName     string
	SourceType     string
	ExternalFileID string
	Headers        []string
	Rows           [][]string
	Mapping        map[string]string
}

type ImportResult struct {
	SourceID           string
	ImportedRecords    int
	SkippedRows        int
	NewEntities        int
	SuggestionsCreated int
	AutoRejected       int
	GeminiCalls        int
}

func (s *Service) Import(ctx context.Context, in ImportInput) (ImportResult, error) {
	var res ImportResult

	fallbackEventName := trimExtension(in.SourceName)
	parsed := ParseRows(in.Headers, in.Rows, in.Mapping, fallbackEventName)
	res.SkippedRows = len(in.Rows) - len(parsed)

	if len(parsed) == 0 {
		return res, fmt.Errorf("không có dòng nào chứa họ tên hoặc email hợp lệ — vui lòng kiểm tra lại ánh xạ cột")
	}

	// Embed everything up front, in batches. This is the slow step, so doing it
	// once beats interleaving it with per-row database work.
	texts := make([]string, len(parsed))
	for i, p := range parsed {
		texts[i] = p.NormalizedText
	}
	embeddings, err := s.AI.EmbedTexts(ctx, texts)
	if err != nil {
		return res, fmt.Errorf("tạo embedding thất bại: %w", err)
	}

	mappingJSON, err := json.Marshal(in.Mapping)
	if err != nil {
		return res, err
	}

	// The source row and all raw records land in one transaction: a
	// half-imported file is worse than a failed one.
	recordIDs := make([]string, len(parsed))
	err = s.DB.WithTx(ctx, func(tx pgx.Tx) error {
		sourceID, err := s.DB.CreateSource(ctx, tx, db.Source{
			OrganizationID: in.OrganizationID,
			Name:           in.SourceName,
			SourceType:     in.SourceType,
			ExternalFileID: in.ExternalFileID,
		}, in.ImportedBy, mappingJSON)
		if err != nil {
			return fmt.Errorf("tạo nguồn: %w", err)
		}
		res.SourceID = sourceID

		for i, p := range parsed {
			rawJSON, err := json.Marshal(p.RawData)
			if err != nil {
				return err
			}
			id, err := s.DB.InsertRawRecord(ctx, tx, db.NewRawRecord{
				SourceID:       sourceID,
				OrganizationID: in.OrganizationID,
				RowNumber:      p.RowNumber,
				RawDataJSON:    rawJSON,
				FullName:       p.FullName,
				Organization:   p.Organization,
				RoleTitle:      p.RoleTitle,
				Email:          p.Email,
				Phone:          p.Phone,
				EventName:      p.EventName,
				EventDate:      p.EventDate,
				EventDateRaw:   p.EventDateRaw,
				Notes:          p.Notes,
				NormalizedText: p.NormalizedText,
				Embedding:      embeddings[i],
			})
			if err != nil {
				return fmt.Errorf("lưu bản ghi dòng %d: %w", p.RowNumber, err)
			}
			recordIDs[i] = id
		}
		return nil
	})
	if err != nil {
		return res, err
	}
	res.ImportedRecords = len(parsed)

	// Resolution runs outside the import transaction and sequentially: each
	// record must be able to match entities seeded by earlier records in the
	// same file, which is the common case when one sheet lists a person twice.
	for i, p := range parsed {
		outcome, err := s.resolveRecord(ctx, in.OrganizationID, recordIDs[i], p, embeddings[i])
		if err != nil {
			return res, err
		}
		res.NewEntities += outcome.newEntities
		res.SuggestionsCreated += outcome.suggestions
		res.AutoRejected += outcome.autoRejected
		res.GeminiCalls += outcome.geminiCalls
	}

	return res, nil
}

type resolveOutcome struct {
	newEntities  int
	suggestions  int
	autoRejected int
	geminiCalls  int
}

// resolveRecord resolves one freshly-inserted raw record.
//
// Order matters: candidate retrieval happens BEFORE the record's own seed
// entity is created, so the record can never match itself.
func (s *Service) resolveRecord(ctx context.Context, orgID, recordID string, p ParsedRow, embedding []float32) (resolveOutcome, error) {
	var out resolveOutcome

	// ---- Stage 1: vector retrieval + deterministic identifier blocking ----
	byVector, err := s.DB.FindCandidatesByVector(ctx, orgID, recordID, embedding, s.Cfg.ResolutionTopN)
	if err != nil {
		return out, err
	}
	byIdentifier, err := s.DB.FindCandidatesByIdentifier(ctx, orgID, recordID, p.Email, p.Phone)
	if err != nil {
		return out, err
	}

	candidates := map[string]db.CandidateEntity{}
	for _, c := range byVector {
		if c.Similarity >= s.Cfg.MinVectorSimilarity {
			candidates[c.Entity.ID] = c
		}
	}
	// Identifier matches bypass the similarity floor: an exact email match is
	// stronger evidence than any cosine score.
	for _, c := range byIdentifier {
		candidates[c.Entity.ID] = c
	}

	// ---- Stage 2: one batched LLM call for the whole shortlist ----
	shortlist := make([]db.CandidateEntity, 0, len(candidates))
	for _, c := range candidates {
		shortlist = append(shortlist, c)
	}
	// Deterministic order so candidate_index is stable and logs are comparable.
	sort.Slice(shortlist, func(i, j int) bool {
		if shortlist[i].Similarity != shortlist[j].Similarity {
			return shortlist[i].Similarity > shortlist[j].Similarity
		}
		return shortlist[i].Entity.ID < shortlist[j].Entity.ID
	})

	verdicts := map[string]ai.MergeVerdict{}
	if len(shortlist) > 0 {
		entities := make([]ai.MergeEntity, len(shortlist))
		for i, c := range shortlist {
			entities[i] = ai.MergeEntity{
				ID:               c.Entity.ID,
				Name:             c.Entity.DisplayName,
				Org:              c.Entity.PrimaryOrganization,
				Role:             c.Entity.PrimaryRole,
				Email:            c.Entity.PrimaryEmail,
				Phone:            c.Entity.PrimaryPhone,
				VectorSimilarity: c.Similarity,
			}
		}

		out.geminiCalls++
		v, err := s.AI.AdjudicateMergeBatch(ctx, ai.MergeRecord{
			Name:  p.FullName,
			Org:   p.Organization,
			Role:  p.RoleTitle,
			Email: p.Email,
			Phone: p.Phone,
			Event: p.EventName,
		}, entities)
		if err != nil {
			// A failed adjudication must not abort the whole import. Those pairs
			// get no suggestion row, so they are reconsidered on a later import.
			log.Printf("[resolution] stage 2 failed for record %s: %v", recordID, err)
		} else {
			verdicts = v
		}
	}

	for _, candidate := range shortlist {
		verdict, ok := verdicts[candidate.Entity.ID]
		if !ok {
			continue
		}

		combined := CombineConfidence(candidate.Similarity, verdict.Confidence, verdict.IsSameEntity)
		confidentlyNotAMatch := !verdict.IsSameEntity && verdict.Confidence >= autoRejectConfidence

		if confidentlyNotAMatch {
			// Persist as an already-rejected row. The unique (entity, record)
			// index means this pair is never proposed again, and no Gemini call
			// is ever spent on it again either.
			if _, err := s.DB.InsertMergeSuggestion(ctx, db.NewMergeSuggestion{
				OrganizationID:       orgID,
				CanonicalEntityID:    candidate.Entity.ID,
				CandidateRawRecordID: recordID,
				VectorSimilarity:     candidate.Similarity,
				LLMConfidence:        verdict.Confidence,
				CombinedConfidence:   combined,
				LLMVerdict:           false,
				Reasoning:            verdict.Reasoning,
			}); err != nil {
				return out, err
			}
			if err := s.DB.MarkAutoRejected(ctx, candidate.Entity.ID, recordID); err != nil {
				return out, err
			}
			out.autoRejected++
			continue
		}

		if combined < s.Cfg.MinCombinedConfidence {
			continue
		}

		inserted, err := s.DB.InsertMergeSuggestion(ctx, db.NewMergeSuggestion{
			OrganizationID:       orgID,
			CanonicalEntityID:    candidate.Entity.ID,
			CandidateRawRecordID: recordID,
			VectorSimilarity:     candidate.Similarity,
			LLMConfidence:        verdict.Confidence,
			CombinedConfidence:   combined,
			LLMVerdict:           verdict.IsSameEntity,
			Reasoning:            verdict.Reasoning,
		})
		if err != nil {
			return out, err
		}
		if inserted {
			out.suggestions++
		}
	}

	// ---- Always seed the record's own canonical entity ----
	// Every raw record belongs to exactly one entity from the moment it lands.
	// A pending suggestion does not change that; approving one later moves the
	// record onto the target and removes this now-empty seed. That keeps the
	// dedup statistic honest — it only improves when a human approves a merge.
	displayName := p.FullName
	if displayName == "" {
		displayName = p.Email
	}
	if displayName == "" {
		displayName = "(không rõ)"
	}

	err = s.DB.WithTx(ctx, func(tx pgx.Tx) error {
		entityID, err := s.DB.CreateCanonicalEntity(ctx, tx, db.CanonicalEntity{
			OrganizationID:      orgID,
			EntityType:          "person",
			DisplayName:         displayName,
			PrimaryEmail:        p.Email,
			PrimaryPhone:        p.Phone,
			PrimaryOrganization: p.Organization,
			PrimaryRole:         p.RoleTitle,
		}, embedding)
		if err != nil {
			return err
		}
		return s.DB.LinkRecordToEntity(ctx, tx, recordID, entityID, orgID, "seed")
	})
	if err != nil {
		return out, err
	}
	out.newEntities++

	return out, nil
}

// Approve applies a merge and refreshes the target entity's centroid so Stage 1
// retrieval improves as the entity accumulates name variants.
func (s *Service) Approve(ctx context.Context, orgID, suggestionID, decidedBy string) error {
	entityID, err := s.DB.ApproveMerge(ctx, orgID, suggestionID, decidedBy)
	if err != nil {
		return err
	}
	vectors, err := s.DB.GetEmbeddingsForEntity(ctx, entityID)
	if err != nil {
		return err
	}
	if len(vectors) == 0 {
		return nil
	}
	c, err := ai.Centroid(vectors)
	if err != nil {
		return err
	}
	return s.DB.UpdateEntityCentroid(ctx, entityID, c)
}

func trimExtension(name string) string {
	for i := len(name) - 1; i >= 0 && i > len(name)-8; i-- {
		if name[i] == '.' {
			return name[:i]
		}
		if name[i] == '/' || name[i] == '\\' {
			break
		}
	}
	return name
}
