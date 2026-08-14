package handlers

import (
	"net/http"
	"strings"

	"event-data-hub/internal/ai"
	"event-data-hub/internal/resolution"
	"event-data-hub/internal/sources"
)

const maxUploadBytes = 15 << 20

func trimLower(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// DriveList renders the Drive file picker fragment.
func (a *App) DriveList(w http.ResponseWriter, r *http.Request) {
	files, err := a.Google.ListSpreadsheets(r.Context(), googleAccessToken(r), r.URL.Query().Get("q"))
	if err != nil {
		a.renderError(w, http.StatusBadGateway,
			"Không truy cập được Google Drive: "+err.Error()+
				" — kiểm tra OAuth scope drive.readonly và spreadsheets.readonly (xem README).")
		return
	}
	a.render(w, "drive_list", map[string]any{"Files": files})
}

// UploadPreview parses an uploaded file and asks Gemini to propose a mapping.
// It never imports anything: the user must confirm first.
func (a *App) UploadPreview(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		a.renderError(w, http.StatusRequestEntityTooLarge, "Tệp quá lớn hoặc không hợp lệ (tối đa 15MB)")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		a.renderError(w, http.StatusBadRequest, "Chưa chọn tệp để tải lên")
		return
	}
	defer file.Close()

	grid, err := sources.ParseSpreadsheet(file)
	if err != nil {
		a.renderError(w, http.StatusBadRequest, err.Error())
		return
	}
	a.stageAndRenderMapping(w, r, header.Filename, "local_upload", "", grid)
}

// DrivePreview reads a Drive/Sheets file and asks Gemini to propose a mapping.
func (a *App) DrivePreview(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		a.renderError(w, http.StatusBadRequest, "Yêu cầu không hợp lệ")
		return
	}
	fileID := r.FormValue("file_id")
	mimeType := r.FormValue("mime_type")
	name := r.FormValue("name")
	if fileID == "" {
		a.renderError(w, http.StatusBadRequest, "Thiếu mã tệp Drive")
		return
	}

	token := googleAccessToken(r)
	var (
		grid       *sources.Grid
		err        error
		sourceType = "google_drive_xlsx"
	)
	if mimeType == sources.MimeGoogleSheet {
		sourceType = "google_sheets"
		grid, err = a.Google.ReadGoogleSheet(r.Context(), token, fileID)
	} else {
		grid, err = a.Google.ReadDriveXLSX(r.Context(), token, fileID)
	}
	if err != nil {
		a.renderError(w, http.StatusBadGateway, "Không đọc được bảng tính: "+err.Error())
		return
	}

	if name == "" {
		name = grid.Title
	}
	a.stageAndRenderMapping(w, r, name, sourceType, fileID, grid)
}

func (a *App) stageAndRenderMapping(w http.ResponseWriter, r *http.Request, name, sourceType, fileID string, grid *sources.Grid) {
	user := a.user(r)

	if len(grid.Headers) == 0 {
		a.renderError(w, http.StatusBadRequest, "Tệp không có dòng tiêu đề nào để phân tích")
		return
	}
	if len(grid.Rows) > stagingMaxRows {
		a.renderError(w, http.StatusRequestEntityTooLarge,
			"Tệp vượt giới hạn dòng mỗi lần nhập — vui lòng chia nhỏ tệp")
		return
	}

	sample := grid.Rows
	if len(sample) > 5 {
		sample = sample[:5]
	}

	staged := &stagedImport{
		OrganizationID: user.OrganizationID,
		SourceName:     name,
		SourceType:     sourceType,
		ExternalFileID: fileID,
		Grid:           grid,
	}

	// The mapping step is advisory — the user confirms it anyway. If Gemini is
	// unavailable we still show the confirmation UI with everything unmapped,
	// rather than blocking the import or silently guessing.
	if a.AI == nil {
		staged.MappingError = "Chưa cấu hình GEMINI_API_KEY"
		staged.Mapping = blankMapping(grid.Headers)
	} else if mapping, err := a.AI.InferSchemaMapping(r.Context(), grid.Headers, sample); err != nil {
		staged.MappingError = err.Error()
		staged.Mapping = blankMapping(grid.Headers)
	} else {
		staged.Mapping = mapping
	}

	token, err := a.staging.put(staged)
	if err != nil {
		a.renderError(w, http.StatusInternalServerError, "Không tạo được phiên nhập dữ liệu")
		return
	}

	a.render(w, "mapping_modal", map[string]any{
		"Token":        token,
		"SourceName":   staged.SourceName,
		"SheetTitle":   grid.Title,
		"Headers":      grid.Headers,
		"SampleRows":   sample,
		"TotalRows":    len(grid.Rows),
		"Mapping":      staged.Mapping,
		"MappingError": staged.MappingError,
		"Fields":       ai.CanonicalFields,
	})
}

func blankMapping(headers []string) map[string]ai.FieldMapping {
	out := make(map[string]ai.FieldMapping, len(headers))
	for _, h := range headers {
		out[h] = ai.FieldMapping{
			CanonicalField: "ignore",
			Confidence:     0,
			Reasoning:      "Chưa có đề xuất từ Gemini",
		}
	}
	return out
}

// ImportConfirm runs the full pipeline after the user approves the mapping.
func (a *App) ImportConfirm(w http.ResponseWriter, r *http.Request) {
	user := a.user(r)

	if err := r.ParseForm(); err != nil {
		a.renderError(w, http.StatusBadRequest, "Yêu cầu không hợp lệ")
		return
	}
	token := r.FormValue("token")
	staged, ok := a.staging.get(token, user.OrganizationID)
	if !ok {
		a.renderError(w, http.StatusGone,
			"Phiên nhập dữ liệu đã hết hạn. Vui lòng chọn lại tệp.")
		return
	}

	if a.AI == nil {
		a.renderError(w, http.StatusServiceUnavailable,
			"Chưa cấu hình GEMINI_API_KEY — không thể tạo embedding cho bước hợp nhất.")
		return
	}

	// The confirmed mapping comes from the form, so validate it here rather
	// than trusting that it still matches what Gemini proposed.
	mapping := make(map[string]string, len(staged.Grid.Headers))
	mapped := 0
	hasIdentity := false
	for _, header := range staged.Grid.Headers {
		value := r.FormValue("map__" + header)
		if !ai.IsCanonicalField(value) {
			value = "ignore"
		}
		mapping[header] = value
		if value != "ignore" {
			mapped++
		}
		if value == "full_name" || value == "email" {
			hasIdentity = true
		}
	}
	if mapped == 0 {
		a.renderError(w, http.StatusBadRequest, "Cần ánh xạ ít nhất một cột sang trường chuẩn")
		return
	}
	if !hasIdentity {
		a.renderError(w, http.StatusBadRequest,
			"Cần ánh xạ ít nhất một cột sang \"Họ và tên\" hoặc \"Email\" để nhận diện được bản ghi")
		return
	}

	result, err := a.Resolver.Import(r.Context(), resolution.ImportInput{
		OrganizationID: user.OrganizationID,
		ImportedBy:     user.Email,
		SourceName:     staged.SourceName,
		SourceType:     staged.SourceType,
		ExternalFileID: staged.ExternalFileID,
		Headers:        staged.Grid.Headers,
		Rows:           staged.Grid.Rows,
		Mapping:        mapping,
	})
	if err != nil {
		a.renderError(w, http.StatusInternalServerError, "Nhập dữ liệu thất bại: "+err.Error())
		return
	}
	a.staging.delete(token)

	// HX-Trigger tells the sidebar, table and merge queue to refresh themselves.
	w.Header().Set("HX-Trigger", "edh:imported")
	a.render(w, "import_result", map[string]any{"Result": result, "SourceName": staged.SourceName})
}
