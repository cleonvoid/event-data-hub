// Package handlers serves the HTMX UI: full pages on navigation, HTML
// fragments for every partial update.
package handlers

import (
	"encoding/json"
	"html/template"
	"log"
	"net/http"
	"strconv"
	"strings"

	"event-data-hub/internal/ai"
	"event-data-hub/internal/auth"
	"event-data-hub/internal/config"
	"event-data-hub/internal/db"
	"event-data-hub/internal/resolution"
	"event-data-hub/internal/sources"
)

type App struct {
	DB       *db.DB
	AI       *ai.Client
	Google   *sources.GoogleClient
	Resolver *resolution.Service
	Cfg      config.Config
	Tpl      *template.Template

	// staging holds parsed sheets between the preview step and the user's
	// confirmation, keyed by a random token. Sheet rows are far too large to
	// round-trip through a hidden form field, and re-fetching from Drive on
	// confirm would double the API calls.
	staging *stagingStore
}

func New(database *db.DB, aiClient *ai.Client, cfg config.Config, tpl *template.Template) *App {
	return &App{
		DB:     database,
		AI:     aiClient,
		Google: sources.NewGoogleClient(),
		Resolver: &resolution.Service{
			DB:  database,
			AI:  aiClient,
			Cfg: cfg,
		},
		Cfg:     cfg,
		Tpl:     tpl,
		staging: newStagingStore(),
	}
}

func (a *App) user(r *http.Request) auth.User {
	u, _ := auth.FromContext(r.Context())
	return u
}

// render writes a named template as an HTML fragment.
func (a *App) render(w http.ResponseWriter, name string, data any) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := a.Tpl.ExecuteTemplate(w, name, data); err != nil {
		// The response may be partially written by now, so this cannot become a
		// clean 500 — log it so the failure is not silent.
		log.Printf("[render] template %s: %v", name, err)
	}
}

// renderError returns an inline error banner. HTMX swaps it into the target, so
// failures appear where the user was looking instead of vanishing into console.
func (a *App) renderError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("HX-Retarget", "#modal-host")
	w.Header().Set("HX-Reswap", "innerHTML")
	w.WriteHeader(status)
	if err := a.Tpl.ExecuteTemplate(w, "error_banner", map[string]any{"Message": message}); err != nil {
		log.Printf("[render] error_banner: %v", err)
	}
}

// jsonResponse is used only by /api/health, which is machine-facing.
func jsonResponse(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *App) Health(w http.ResponseWriter, r *http.Request) {
	jsonResponse(w, http.StatusOK, map[string]any{
		"status":            "ok",
		"authMode":          a.Cfg.AuthMode,
		"aiConfigured":      a.AI != nil,
		"geminiModel":       a.Cfg.GeminiModel,
		"embeddingModel":    a.Cfg.EmbeddingModel,
		"embeddingProvider": embeddingProvider(a.Cfg),
	})
}

func embeddingProvider(cfg config.Config) string {
	if cfg.UseVertex {
		return "vertex-ai"
	}
	return "gemini-api"
}

// googleAccessToken reads the per-request OAuth token. It is a different
// credential from the Firebase ID token: the ID token proves who the user is to
// us, this authorises us to call Drive/Sheets as them. Never stored.
func googleAccessToken(r *http.Request) string {
	if v := r.Header.Get("X-Google-Access-Token"); v != "" {
		return v
	}
	return r.FormValue("google_access_token")
}

func atoiDefault(s string, def int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
		return n
	}
	return def
}
