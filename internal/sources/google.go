package sources

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Google Drive + Sheets clients.
//
// These call the real REST APIs with the signed-in user's OAuth access token.
// There is deliberately no sample-data fallback: an unconfigured or
// unauthorised call fails with a clear message rather than quietly returning
// fake filenames that look like a working import.

const (
	driveFilesEndpoint = "https://www.googleapis.com/drive/v3/files"
	sheetsEndpoint     = "https://sheets.googleapis.com/v4/spreadsheets"

	MimeGoogleSheet = "application/vnd.google-apps.spreadsheet"
	MimeXLSX        = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
)

type DriveFile struct {
	ID           string
	Name         string
	MimeType     string
	ModifiedTime time.Time
	Owner        string
}

// IsNativeSheet reports whether the file is a Google Sheet (read via the Sheets
// API) rather than a binary .xlsx (downloaded and parsed with excelize).
func (f DriveFile) IsNativeSheet() bool { return f.MimeType == MimeGoogleSheet }

func (f DriveFile) ModifiedDisplay() string { return f.ModifiedTime.Format("02/01/2006") }

type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("Google API %d: %s", e.Status, e.Message) }

type GoogleClient struct {
	HTTP *http.Client
}

func NewGoogleClient() *GoogleClient {
	return &GoogleClient{HTTP: &http.Client{Timeout: 60 * time.Second}}
}

func (g *GoogleClient) do(ctx context.Context, rawURL, accessToken string) (*http.Response, error) {
	if strings.TrimSpace(accessToken) == "" {
		return nil, &APIError{http.StatusUnauthorized, "Thiếu Google OAuth access token để truy cập Drive/Sheets"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := g.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()

		message := strings.TrimSpace(string(body))
		var parsed struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(body, &parsed) == nil && parsed.Error.Message != "" {
			message = parsed.Error.Message
		}
		if len(message) > 400 {
			message = message[:400]
		}
		return nil, &APIError{resp.StatusCode, message}
	}
	return resp, nil
}

// ListSpreadsheets paginates fully. The earlier version read only the first
// page, so anyone with more than 100 files silently could not see the rest.
func (g *GoogleClient) ListSpreadsheets(ctx context.Context, accessToken, search string) ([]DriveFile, error) {
	clauses := []string{
		fmt.Sprintf("(mimeType='%s' or mimeType='%s')", MimeGoogleSheet, MimeXLSX),
		"trashed=false",
	}
	if s := strings.TrimSpace(search); s != "" {
		// Escaped for the Drive query language: backslashes then single quotes.
		safe := strings.ReplaceAll(s, `\`, `\\`)
		safe = strings.ReplaceAll(safe, `'`, `\'`)
		clauses = append(clauses, fmt.Sprintf("name contains '%s'", safe))
	}

	var out []DriveFile
	pageToken := ""

	for page := 0; page < 5; page++ {
		params := url.Values{}
		params.Set("q", strings.Join(clauses, " and "))
		params.Set("fields", "nextPageToken, files(id,name,mimeType,modifiedTime,owners(displayName))")
		params.Set("orderBy", "modifiedTime desc")
		params.Set("pageSize", "100")
		params.Set("supportsAllDrives", "true")
		params.Set("includeItemsFromAllDrives", "true")
		params.Set("corpora", "user")
		if pageToken != "" {
			params.Set("pageToken", pageToken)
		}

		resp, err := g.do(ctx, driveFilesEndpoint+"?"+params.Encode(), accessToken)
		if err != nil {
			return nil, err
		}

		var body struct {
			NextPageToken string `json:"nextPageToken"`
			Files         []struct {
				ID           string `json:"id"`
				Name         string `json:"name"`
				MimeType     string `json:"mimeType"`
				ModifiedTime string `json:"modifiedTime"`
				Owners       []struct {
					DisplayName string `json:"displayName"`
				} `json:"owners"`
			} `json:"files"`
		}
		err = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("giải mã danh sách Drive: %w", err)
		}

		for _, f := range body.Files {
			modified, _ := time.Parse(time.RFC3339, f.ModifiedTime)
			owner := ""
			if len(f.Owners) > 0 {
				owner = f.Owners[0].DisplayName
			}
			out = append(out, DriveFile{
				ID: f.ID, Name: f.Name, MimeType: f.MimeType,
				ModifiedTime: modified, Owner: owner,
			})
		}

		pageToken = body.NextPageToken
		if pageToken == "" {
			break
		}
	}
	return out, nil
}

// ReadGoogleSheet reads a native Google Sheet's first tab through the Sheets API.
func (g *GoogleClient) ReadGoogleSheet(ctx context.Context, accessToken, spreadsheetID string) (*Grid, error) {
	metaURL := fmt.Sprintf("%s/%s?fields=properties(title),sheets(properties(title))",
		sheetsEndpoint, url.PathEscape(spreadsheetID))
	resp, err := g.do(ctx, metaURL, accessToken)
	if err != nil {
		return nil, err
	}
	var meta struct {
		Properties struct {
			Title string `json:"title"`
		} `json:"properties"`
		Sheets []struct {
			Properties struct {
				Title string `json:"title"`
			} `json:"properties"`
		} `json:"sheets"`
	}
	err = json.NewDecoder(resp.Body).Decode(&meta)
	resp.Body.Close()
	if err != nil {
		return nil, fmt.Errorf("giải mã metadata bảng tính: %w", err)
	}
	if len(meta.Sheets) == 0 {
		return nil, &APIError{http.StatusBadRequest, "Bảng tính không có trang tính nào"}
	}
	firstTab := meta.Sheets[0].Properties.Title

	// UNFORMATTED_VALUE keeps dates as Excel serial numbers, which
	// normalize.EventDate handles precisely. FORMATTED_VALUE would hand back
	// locale-dependent strings instead.
	valuesURL := fmt.Sprintf("%s/%s/values/%s?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER",
		sheetsEndpoint, url.PathEscape(spreadsheetID), url.PathEscape(firstTab))
	resp, err = g.do(ctx, valuesURL, accessToken)
	if err != nil {
		return nil, err
	}
	var values struct {
		Values [][]any `json:"values"`
	}
	err = json.NewDecoder(resp.Body).Decode(&values)
	resp.Body.Close()
	if err != nil {
		return nil, fmt.Errorf("giải mã dữ liệu bảng tính: %w", err)
	}

	rows := make([][]string, len(values.Values))
	for i, row := range values.Values {
		cells := make([]string, len(row))
		for j, cell := range row {
			cells[j] = cellToString(cell)
		}
		rows[i] = cells
	}

	title := meta.Properties.Title
	if title == "" {
		title = firstTab
	}
	return GridFromRows(title, rows), nil
}

// ReadDriveXLSX downloads a binary .xlsx from Drive and parses it through the
// same code path as a local upload.
func (g *GoogleClient) ReadDriveXLSX(ctx context.Context, accessToken, fileID string) (*Grid, error) {
	dl := fmt.Sprintf("%s/%s?alt=media&supportsAllDrives=true", driveFilesEndpoint, url.PathEscape(fileID))
	resp, err := g.do(ctx, dl, accessToken)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// 60MB ceiling so a hostile or accidental huge file cannot exhaust memory.
	data, err := io.ReadAll(io.LimitReader(resp.Body, 60<<20))
	if err != nil {
		return nil, fmt.Errorf("tải tệp từ Drive: %w", err)
	}
	return ParseSpreadsheet(bytes.NewReader(data))
}

// cellToString renders a Sheets JSON value. Numbers arrive as float64; integral
// ones are printed without a trailing ".0" so Excel serial dates and ID columns
// survive the round trip intact.
func cellToString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		return strconv.FormatBool(t)
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return fmt.Sprint(t)
	}
}
