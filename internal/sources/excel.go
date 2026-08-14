// Package sources reads spreadsheets from local uploads, Google Drive and the
// Google Sheets API into one common Grid shape.
package sources

import (
	"fmt"
	"io"
	"strings"

	"github.com/xuri/excelize/v2"
)

// Grid is a parsed sheet: a header row plus rectangular data rows.
type Grid struct {
	Title   string
	Headers []string
	Rows    [][]string
}

// ParseSpreadsheet reads the first sheet of an .xlsx/.csv stream.
func ParseSpreadsheet(r io.Reader) (*Grid, error) {
	f, err := excelize.OpenReader(r)
	if err != nil {
		return nil, fmt.Errorf("không đọc được tệp bảng tính: %w", err)
	}
	defer f.Close()

	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return nil, fmt.Errorf("tệp không chứa trang tính nào")
	}

	rows, err := f.GetRows(sheets[0])
	if err != nil {
		return nil, fmt.Errorf("không đọc được dòng dữ liệu: %w", err)
	}
	return GridFromRows(sheets[0], rows), nil
}

// GridFromRows normalises a ragged row set into a rectangle and gives blank or
// duplicate header cells stable synthetic names — both break a column→field
// mapping keyed by header name.
func GridFromRows(title string, rows [][]string) *Grid {
	if len(rows) == 0 {
		return &Grid{Title: title, Headers: []string{}, Rows: [][]string{}}
	}

	width := len(rows[0])
	for _, r := range rows {
		if len(r) > width {
			width = len(r)
		}
	}

	seen := map[string]int{}
	headers := make([]string, width)
	for i := 0; i < width; i++ {
		name := ""
		if i < len(rows[0]) {
			name = strings.TrimSpace(rows[0][i])
		}
		if name == "" {
			name = fmt.Sprintf("Cột %d", i+1)
		}
		count := seen[name]
		seen[name] = count + 1
		if count > 0 {
			name = fmt.Sprintf("%s (%d)", name, count+1)
		}
		headers[i] = name
	}

	data := make([][]string, 0, len(rows)-1)
	for _, r := range rows[1:] {
		padded := make([]string, width)
		nonEmpty := false
		for i := 0; i < width; i++ {
			if i < len(r) {
				padded[i] = r[i]
				if strings.TrimSpace(r[i]) != "" {
					nonEmpty = true
				}
			}
		}
		if nonEmpty {
			data = append(data, padded)
		}
	}

	return &Grid{Title: title, Headers: headers, Rows: data}
}
