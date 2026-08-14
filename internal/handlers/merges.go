package handlers

import (
	"errors"
	"net/http"

	"event-data-hub/internal/db"
)

// Merges renders the review queue fragment.
func (a *App) Merges(w http.ResponseWriter, r *http.Request) {
	user := a.user(r)
	suggestions, err := a.DB.ListPendingSuggestions(r.Context(), user.OrganizationID, 50)
	if err != nil {
		a.renderError(w, http.StatusInternalServerError, "Không tải được gợi ý hợp nhất: "+err.Error())
		return
	}
	a.render(w, "merge_list", map[string]any{"Merges": suggestions})
}

// ApproveMerge links the candidate record to the chosen entity. Human-approved
// only — nothing in the pipeline merges on its own.
func (a *App) ApproveMerge(w http.ResponseWriter, r *http.Request) {
	a.decideMerge(w, r, true)
}

// RejectMerge persists the negative signal so the pair is never suggested again.
func (a *App) RejectMerge(w http.ResponseWriter, r *http.Request) {
	a.decideMerge(w, r, false)
}

func (a *App) decideMerge(w http.ResponseWriter, r *http.Request, approve bool) {
	user := a.user(r)

	if err := r.ParseForm(); err != nil {
		a.renderError(w, http.StatusBadRequest, "Yêu cầu không hợp lệ")
		return
	}
	id := r.PathValue("id")
	if id == "" {
		id = r.FormValue("id")
	}
	if id == "" {
		a.renderError(w, http.StatusBadRequest, "Thiếu mã gợi ý")
		return
	}

	var err error
	if approve {
		err = a.Resolver.Approve(r.Context(), user.OrganizationID, id, user.Email)
	} else {
		err = a.DB.RejectMerge(r.Context(), user.OrganizationID, id, user.Email)
	}

	switch {
	case errors.Is(err, db.ErrNotFound):
		a.renderError(w, http.StatusNotFound, "Không tìm thấy gợi ý hợp nhất")
		return
	case errors.Is(err, db.ErrConflict):
		// Someone else decided it first, or a double-click. Re-render the queue
		// so the UI converges on the real state instead of showing a stale card.
		a.renderError(w, http.StatusConflict, "Gợi ý này đã được xử lý trước đó")
		return
	case err != nil:
		a.renderError(w, http.StatusInternalServerError, "Xử lý thất bại: "+err.Error())
		return
	}

	// Re-render the whole queue and tell the rest of the page to refresh.
	suggestions, err := a.DB.ListPendingSuggestions(r.Context(), user.OrganizationID, 50)
	if err != nil {
		a.renderError(w, http.StatusInternalServerError, "Không tải lại được danh sách: "+err.Error())
		return
	}
	w.Header().Set("HX-Trigger", "edh:merged")
	a.render(w, "merge_list", map[string]any{"Merges": suggestions})
}
