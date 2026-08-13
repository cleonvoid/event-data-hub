package sources

import (
	"fmt"
	"io"

	"github.com/qax-os/excelize/v2"
)

type ExcelSheetData struct {
	SheetName string     `json:"sheet_name"`
	Headers   []string   `json:"headers"`
	Rows      [][]string `json:"rows"`
}

// ParseExcelReader parses an uploaded .xlsx file stream
func ParseExcelReader(r io.Reader) (*ExcelSheetData, error) {
	f, err := excelize.OpenReader(r)
	if err != nil {
		return nil, fmt.Errorf("failed to parse excel file: %w", err)
	}
	defer f.Close()

	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return nil, fmt.Errorf("excel file contains no sheets")
	}

	activeSheet := sheets[0]
	rows, err := f.GetRows(activeSheet)
	if err != nil {
		return nil, fmt.Errorf("failed to read sheet rows: %w", err)
	}

	if len(rows) == 0 {
		return &ExcelSheetData{SheetName: activeSheet, Headers: []string{}, Rows: [][]string{}}, nil
	}

	headers := rows[0]
	dataRows := rows[1:]

	return &ExcelSheetData{
		SheetName: activeSheet,
		Headers:   headers,
		Rows:      dataRows,
	}, nil
}
