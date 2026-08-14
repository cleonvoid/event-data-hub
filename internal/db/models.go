package db

import "time"

type Source struct {
	ID             string
	OrganizationID string
	Name           string
	SourceType     string
	ExternalFileID string
	ImportedAt     time.Time
	RecordsCount   int
}

type RawRecord struct {
	ID             string
	SourceID       string
	SourceName     string
	SourceType     string
	OrganizationID string
	RowNumber      int
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
	CreatedAt      time.Time
}

// EventDateDisplay renders the parsed date, falling back to the untouched
// original when the source format could not be parsed.
func (r RawRecord) EventDateDisplay() string {
	if r.EventDate != nil {
		return r.EventDate.Format("02/01/2006")
	}
	if r.EventDateRaw != "" {
		return r.EventDateRaw + " (chưa nhận dạng)"
	}
	return ""
}

type CanonicalEntity struct {
	ID                  string
	OrganizationID      string
	EntityType          string
	DisplayName         string
	PrimaryEmail        string
	PrimaryPhone        string
	PrimaryOrganization string
	PrimaryRole         string
	// Derived at query time from raw_to_canonical, never stored.
	EventCount      int
	SourceFileCount int
	RecordCount     int
	CreatedAt       time.Time
}

type MergeSuggestion struct {
	ID                   string
	OrganizationID       string
	CanonicalEntityID    string
	CandidateRawRecordID string
	VectorSimilarity     float64
	LLMConfidence        float64
	CombinedConfidence   float64
	LLMVerdict           bool
	Reasoning            string
	Status               string
	CreatedAt            time.Time

	Entity CanonicalEntity
	Record RawRecord
}

// Percent helpers keep arithmetic out of the templates.
func (m MergeSuggestion) CombinedPercent() int { return int(m.CombinedConfidence*100 + 0.5) }
func (m MergeSuggestion) VectorPercent() int   { return int(m.VectorSimilarity*100 + 0.5) }
func (m MergeSuggestion) LLMPercent() int      { return int(m.LLMConfidence*100 + 0.5) }

type SourceTypeStat struct {
	SourceType  string
	FileCount   int
	RecordCount int
}

type Stats struct {
	TotalCanonicalEntities  int
	TotalRawRecords         int
	DedupRatePercent        float64
	SourceFilesProcessed    int
	PendingMergeSuggestions int
	BySourceType            []SourceTypeStat
}

// CandidateEntity is a Stage 1 retrieval hit.
type CandidateEntity struct {
	Entity      CanonicalEntity
	Similarity  float64
	ViaBlocking bool
}
