package handlers

import (
	"fmt"
	"net/http"

	"event-data-hub/internal/auth"
	"event-data-hub/internal/sources"
)

func (h *AppHandler) ListDriveSources(w http.ResponseWriter, r *http.Request) {
	oauthToken := r.Header.Get("X-Google-OAuth-Token")
	files, err := h.DriveService.ListUserSpreadsheets(r.Context(), oauthToken)
	if err != nil {
		RenderJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	RenderJSON(w, http.StatusOK, map[string]interface{}{
		"status": "success",
		"files":  files,
	})
}

func (h *AppHandler) UploadLocalSpreadsheet(w http.ResponseWriter, r *http.Request) {
	err := r.ParseMultipartForm(10 << 20) // 10 MB max
	if err != nil {
		http.Error(w, "File too large", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Invalid file upload", http.StatusBadRequest)
		return
	}
	defer file.Close()

	sheetData, err := sources.ParseExcelReader(file)
	if err != nil {
		http.Error(w, fmt.Sprintf("Error parsing spreadsheet: %v", err), http.StatusBadRequest)
		return
	}

	orgID, _ := r.Context().Value(auth.UserOrgKey).(string)

	// Call Gemini for Schema mapping proposal
	sampleRows := sheetData.Rows
	if len(sampleRows) > 3 {
		sampleRows = sampleRows[:3]
	}

	var mappingResult interface{}
	if h.AI != nil {
		res, err := h.AI.InferSchemaMapping(r.Context(), sheetData.Headers, sampleRows)
		if err == nil {
			mappingResult = res
		}
	}

	RenderJSON(w, http.StatusOK, map[string]interface{}{
		"filename":       header.Filename,
		"sheet_name":     sheetData.SheetName,
		"headers":        sheetData.Headers,
		"total_rows":     len(sheetData.Rows),
		"sample_rows":    sampleRows,
		"org_id":         orgID,
		"schema_mapping": mappingResult,
	})
}
