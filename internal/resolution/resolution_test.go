package resolution

import (
	"testing"

	"event-data-hub/internal/sources"
)

func TestParseRowsPreservesRawAndSupportsOrganizations(t *testing.T) {
	headers := []string{"Tên", "Đơn vị", "Ghi chú"}
	rows := [][]string{
		{"  Nguyễn   Văn A  ", "FPT", "  giữ nguyên  "},
		{"", "VietAI", "organization only"},
		{"", "", "raw only"},
	}
	mapping := map[string]string{"Tên": "full_name", "Đơn vị": "organization", "Ghi chú": "notes"}

	got := ParseRows(headers, rows, mapping, "Sự kiện mẫu", nil)
	if len(got) != 3 {
		t.Fatalf("stored %d rows, want all 3", len(got))
	}
	if got[0].RawData["Tên"] != rows[0][0] || got[0].RawData["Ghi chú"] != rows[0][2] {
		t.Fatalf("raw row changed: %#v", got[0].RawData)
	}
	if got[0].FullName != "Nguyễn Văn A" || got[0].EntityType != "person" || !got[0].Resolvable {
		t.Fatalf("person normalization failed: %#v", got[0])
	}
	if got[1].EntityType != "organization" || !got[1].Resolvable || got[1].Organization != "VietAI" {
		t.Fatalf("organization row not resolvable: %#v", got[1])
	}
	if got[2].Resolvable {
		t.Fatalf("raw-only row should be stored without an entity: %#v", got[2])
	}
	if got[0].RowNumber != 2 || got[2].RowNumber != 4 {
		t.Fatalf("spreadsheet row numbers wrong: %d..%d", got[0].RowNumber, got[2].RowNumber)
	}
}

// A blank line in the sheet is dropped before ParseRows sees it, so positions
// stop matching source lines and only the grid's own numbering is right.
func TestParseRowsUsesGridRowNumbersAcrossBlankLines(t *testing.T) {
	grid := sources.GridFromRows("Sheet1", [][]string{
		{"Tên"},
		{"A"},
		{"   "}, // blank separator: line 3 in the file, dropped from Rows
		{"B"},
	})
	if len(grid.Rows) != 2 {
		t.Fatalf("blank row not dropped: %#v", grid.Rows)
	}

	got := ParseRows(grid.Headers, grid.Rows, map[string]string{"Tên": "full_name"}, "Sự kiện mẫu", grid.RowNumbers)
	if len(got) != 2 {
		t.Fatalf("parsed %d rows, want 2", len(got))
	}
	if got[0].RowNumber != 2 {
		t.Fatalf("first row = line %d, want 2", got[0].RowNumber)
	}
	// Position 1, but line 4 in the file — i+2 would have said 3.
	if got[1].RowNumber != 4 {
		t.Fatalf("row after the blank line = %d, want 4", got[1].RowNumber)
	}
}
