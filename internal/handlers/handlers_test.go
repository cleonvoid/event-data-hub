package handlers

import (
	"html/template"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRenderErrorIsVisibleToHTMX(t *testing.T) {
	app := &App{Tpl: template.Must(template.New("error_banner").Parse(
		`{{define "error_banner"}}<p>{{.Message}}</p>{{end}}`,
	))}
	w := httptest.NewRecorder()
	app.renderError(w, http.StatusBadRequest, "mapping invalid")

	if w.Code != http.StatusBadRequest || w.Header().Get("HX-Reswap") != "innerHTML" || w.Header().Get("HX-Retarget") != "#modal-host" {
		t.Fatalf("status/HTMX headers: %d %#v", w.Code, w.Header())
	}
	if !strings.Contains(w.Body.String(), "mapping invalid") {
		t.Fatalf("error body missing: %s", w.Body.String())
	}
}

func TestTemplatesParse(t *testing.T) {
	t.Setenv("TEMPLATES_DIR", "../../templates")
	if _, err := LoadTemplates(); err != nil {
		t.Fatal(err)
	}
}
