package handlers

import (
	"net/http"

	"event-data-hub/internal/auth"
)

func (h *AppHandler) GetStats(w http.ResponseWriter, r *http.Request) {
	orgID, _ := r.Context().Value(auth.UserOrgKey).(string)

	stats, err := h.DB.GetStats(r.Context(), orgID)
	if err != nil {
		RenderJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	RenderJSON(w, http.StatusOK, stats)
}
