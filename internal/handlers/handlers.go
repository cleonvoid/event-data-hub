package handlers

import (
	"encoding/json"
	"net/http"

	"event-data-hub/internal/ai"
	"event-data-hub/internal/db"
	"event-data-hub/internal/sources"
)

type AppHandler struct {
	DB           *db.DB
	AI           *ai.Client
	DriveService *sources.DriveService
}

func NewAppHandler(database *db.DB, aiClient *ai.Client) *AppHandler {
	return &AppHandler{
		DB:           database,
		AI:           aiClient,
		DriveService: sources.NewDriveService(nil),
	}
}

func RenderJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}
