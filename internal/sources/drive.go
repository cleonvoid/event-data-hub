package sources

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

type DriveFile struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	MimeType     string `json:"mimeType"`
	ModifiedTime string `json:"modifiedTime"`
	IconLink     string `json:"iconLink"`
}

type DriveService struct {
	client *http.Client
}

func NewDriveService(client *http.Client) *DriveService {
	if client == nil {
		client = http.DefaultClient
	}
	return &DriveService{client: client}
}

// ListUserSpreadsheets queries Google Drive API for Sheets and XLSX files
func (s *DriveService) ListUserSpreadsheets(ctx context.Context, oauthToken string) ([]DriveFile, error) {
	if oauthToken == "" {
		// Return sample Drive spreadsheets when token is unprovided in preview mode
		return []DriveFile{
			{ID: "sheet_001", Name: "Danh_sach_Tham_gia_Hoi_thao_AI_2025.xlsx", MimeType: "application/vnd.google-apps.spreadsheet", ModifiedTime: "2025-06-15T10:00:00Z"},
			{ID: "sheet_002", Name: "Chuyengia_DienGia_TechConnect_2025.xlsx", MimeType: "application/vnd.google-apps.spreadsheet", ModifiedTime: "2025-07-20T14:30:00Z"},
			{ID: "sheet_003", Name: "Doi_tac_Dau_tu_Doi_moi_Sang_tao.csv", MimeType: "text/csv", ModifiedTime: "2025-08-01T09:15:00Z"},
		}, nil
	}

	req, err := http.NewRequestWithContext(ctx, "GET", "https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.spreadsheet'+or+mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'&fields=files(id,name,mimeType,modifiedTime,iconLink)", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+oauthToken)

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("drive API error status: %d", resp.StatusCode)
	}

	var result struct {
		Files []DriveFile `json:"files"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}

	return result.Files, nil
}
