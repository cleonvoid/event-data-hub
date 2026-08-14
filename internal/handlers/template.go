package handlers

import (
	"fmt"
	"html/template"
	"os"
	"path/filepath"
)

// FuncMap holds the small helpers the templates need. Keeping logic here rather
// than in the HTML keeps the templates readable and testable.
var FuncMap = template.FuncMap{
	"add": func(a, b int) int { return a + b },
	"sub": func(a, b int) int { return a - b },

	// dict builds a map inline so one template can pass several values to another.
	"dict": func(values ...any) (map[string]any, error) {
		if len(values)%2 != 0 {
			return nil, fmt.Errorf("dict: cần số lượng tham số chẵn")
		}
		out := make(map[string]any, len(values)/2)
		for i := 0; i < len(values); i += 2 {
			key, ok := values[i].(string)
			if !ok {
				return nil, fmt.Errorf("dict: khóa phải là chuỗi")
			}
			out[key] = values[i+1]
		}
		return out, nil
	},

	"sourceLabel": func(t string) string {
		switch t {
		case "google_sheets":
			return "Google Sheets"
		case "google_drive_xlsx":
			return "Drive (.xlsx)"
		case "local_upload":
			return "Tải lên"
		default:
			return t
		}
	},

	"fieldLabel": func(f string) string {
		switch f {
		case "FullName":
			return "Họ và tên"
		case "Organization":
			return "Đơn vị"
		case "RoleTitle":
			return "Chức danh"
		case "Email":
			return "Email"
		case "Phone":
			return "Điện thoại"
		default:
			return f
		}
	},

	"fieldOptionLabel": func(f string) string {
		switch f {
		case "full_name":
			return "Họ và tên"
		case "organization":
			return "Đơn vị / Công ty"
		case "role_title":
			return "Chức danh / Vai trò"
		case "email":
			return "Địa chỉ Email"
		case "phone":
			return "Số điện thoại"
		case "event_name":
			return "Tên sự kiện"
		case "event_date":
			return "Ngày diễn ra"
		case "notes":
			return "Ghi chú"
		case "ignore":
			return "Bỏ qua cột này"
		default:
			return f
		}
	},

	// sampleFor finds the first non-empty sample value for a column, so the
	// mapping UI shows real data rather than an empty cell that happened to be
	// first.
	"sampleFor": func(rows [][]string, idx int) string {
		for _, row := range rows {
			if idx < len(row) && row[idx] != "" {
				return fmt.Sprintf("Mẫu: “%s”", row[idx])
			}
		}
		return "Không có dữ liệu mẫu"
	},
}

// LoadTemplates parses every .html in the templates directory.
func LoadTemplates() (*template.Template, error) {
	dir, err := templatesDir()
	if err != nil {
		return nil, err
	}
	tpl, err := template.New("").Funcs(FuncMap).ParseGlob(filepath.Join(dir, "*.html"))
	if err != nil {
		return nil, fmt.Errorf("parse templates in %s: %w", dir, err)
	}
	return tpl, nil
}

func templatesDir() (string, error) {
	candidates := []string{os.Getenv("TEMPLATES_DIR"), "templates", filepath.Join("..", "templates")}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if info, err := os.Stat(c); err == nil && info.IsDir() {
			return c, nil
		}
	}
	return "", fmt.Errorf("templates directory not found (set TEMPLATES_DIR)")
}
