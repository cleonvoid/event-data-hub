package handlers

import (
	"net/http"

	"event-data-hub/internal/db"
	"event-data-hub/internal/search"
)

const pageSize = 25

type entityListView struct {
	Entities    []db.CanonicalEntity
	Total       int
	Page        int
	TotalPages  int
	Query       string
	Explanation string
	Filters     []search.AppliedFilter
	Mode        string
}

// Index renders the whole page. Everything after this is an HTMX fragment.
func (a *App) Index(w http.ResponseWriter, r *http.Request) {
	user := a.user(r)
	ctx := r.Context()

	stats, err := a.DB.GetStats(ctx, user.OrganizationID)
	if err != nil {
		a.renderError(w, http.StatusInternalServerError, "Không tải được thống kê: "+err.Error())
		return
	}
	srcs, err := a.DB.ListSources(ctx, user.OrganizationID)
	if err != nil {
		a.renderError(w, http.StatusInternalServerError, "Không tải được danh sách nguồn: "+err.Error())
		return
	}
	merges, err := a.DB.ListPendingSuggestions(ctx, user.OrganizationID, 50)
	if err != nil {
		a.renderError(w, http.StatusInternalServerError, "Không tải được gợi ý hợp nhất: "+err.Error())
		return
	}
	list, err := a.entityList(r, "", 1)
	if err != nil {
		a.renderError(w, http.StatusInternalServerError, "Không tải được danh sách thực thể: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	a.render(w, "layout", map[string]any{
		"User":         user,
		"Stats":        stats,
		"Sources":      srcs,
		"Merges":       merges,
		"Entities":     list,
		"AIConfigured": a.AI != nil,
		"GeminiModel":  a.Cfg.GeminiModel,
		"AuthMode":     a.Cfg.AuthMode,
	})
}

// entityList runs the search pipeline: Gemini translates the query into
// whitelisted filters, search.Build turns those into parameterised SQL.
func (a *App) entityList(r *http.Request, query string, page int) (entityListView, error) {
	user := a.user(r)
	ctx := r.Context()

	if page < 1 {
		page = 1
	}
	view := entityListView{Page: page, Query: query, Mode: "all"}

	var predicate search.Predicate
	if query != "" {
		if a.AI != nil {
			plan, err := a.AI.TranslateNlSearch(ctx, query)
			if err != nil {
				// Search must keep working without Gemini. Same whitelist, same
				// parameterisation — only the filter selection is dumber.
				view.Mode = "keyword"
				view.Explanation = "Gemini không khả dụng, đang tìm theo từ khóa: " + query
				predicate = search.KeywordFallback(query, 2)
			} else {
				view.Mode = "gemini"
				view.Explanation = plan.Explanation
				predicate = search.Build(plan.Filters, plan.Logic, 2)
			}
		} else {
			view.Mode = "keyword"
			view.Explanation = "Chưa cấu hình Gemini, đang tìm theo từ khóa: " + query
			predicate = search.KeywordFallback(query, 2)
		}
		view.Filters = predicate.Applied
	}

	entities, total, err := a.DB.ListEntities(ctx, user.OrganizationID,
		predicate.SQL, predicate.Args, pageSize, (page-1)*pageSize)
	if err != nil {
		return view, err
	}

	view.Entities = entities
	view.Total = total
	view.TotalPages = (total + pageSize - 1) / pageSize
	if view.TotalPages < 1 {
		view.TotalPages = 1
	}
	return view, nil
}

// Entities serves the searchable table fragment.
func (a *App) Entities(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	page := atoiDefault(r.URL.Query().Get("page"), 1)

	list, err := a.entityList(r, query, page)
	if err != nil {
		a.renderError(w, http.StatusInternalServerError, "Tìm kiếm thất bại: "+err.Error())
		return
	}
	a.render(w, "entity_table", list)
}

// EntityDrawer serves the slide-in detail panel.
func (a *App) EntityDrawer(w http.ResponseWriter, r *http.Request) {
	user := a.user(r)
	id := r.URL.Query().Get("id")
	if id == "" {
		a.renderError(w, http.StatusBadRequest, "Thiếu mã thực thể")
		return
	}

	entity, err := a.DB.GetEntity(r.Context(), user.OrganizationID, id)
	if err != nil {
		a.renderError(w, http.StatusInternalServerError, "Không tải được thực thể: "+err.Error())
		return
	}
	if entity == nil {
		a.renderError(w, http.StatusNotFound, "Không tìm thấy thực thể")
		return
	}

	records, err := a.DB.GetRecordsForEntity(r.Context(), user.OrganizationID, id)
	if err != nil {
		a.renderError(w, http.StatusInternalServerError, "Không tải được bản ghi nguồn: "+err.Error())
		return
	}

	a.render(w, "entity_drawer", map[string]any{
		"Entity":          entity,
		"Records":         records,
		"DifferingFields": differingFields(records),
	})
}

// differingFields reports which canonical fields actually disagree across the
// merged records — what the drawer highlights so a reviewer can spot a bad merge.
func differingFields(records []db.RawRecord) map[string]bool {
	out := map[string]bool{}
	if len(records) < 2 {
		return out
	}
	fields := map[string]func(db.RawRecord) string{
		"FullName":     func(r db.RawRecord) string { return r.FullName },
		"Organization": func(r db.RawRecord) string { return r.Organization },
		"RoleTitle":    func(r db.RawRecord) string { return r.RoleTitle },
		"Email":        func(r db.RawRecord) string { return r.Email },
		"Phone":        func(r db.RawRecord) string { return r.Phone },
	}
	for name, get := range fields {
		seen := map[string]bool{}
		for _, rec := range records {
			if v := normaliseForCompare(get(rec)); v != "" {
				seen[v] = true
			}
		}
		if len(seen) > 1 {
			out[name] = true
		}
	}
	return out
}

func normaliseForCompare(s string) string {
	return trimLower(s)
}

// Stats serves the sidebar statistics fragment.
func (a *App) Stats(w http.ResponseWriter, r *http.Request) {
	user := a.user(r)
	stats, err := a.DB.GetStats(r.Context(), user.OrganizationID)
	if err != nil {
		a.renderError(w, http.StatusInternalServerError, "Không tải được thống kê: "+err.Error())
		return
	}
	srcs, err := a.DB.ListSources(r.Context(), user.OrganizationID)
	if err != nil {
		a.renderError(w, http.StatusInternalServerError, "Không tải được nguồn: "+err.Error())
		return
	}
	a.render(w, "sidebar_data", map[string]any{"Stats": stats, "Sources": srcs})
}
