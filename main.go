package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"event-data-hub/internal/ai"
	"event-data-hub/internal/auth"
	"event-data-hub/internal/db"
	"event-data-hub/internal/handlers"
)

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}

	// 1. Connect to PostgreSQL / Cloud SQL database
	database, err := db.Connect(ctx)
	if err != nil {
		log.Printf("Notice: Database connection: %v\n", err)
	} else {
		defer database.Close()
	}

	// 2. Initialize Gemini API & Embeddings client
	aiClient, err := ai.NewClient(ctx)
	if err != nil {
		log.Printf("Notice: Gemini client init notice: %v\n", err)
	}

	// 3. Initialize App Handler
	appHandler := handlers.NewAppHandler(database, aiClient)

	// 4. Register HTTP routes (net/http standard library)
	mux := http.NewServeMux()

	// Static files & HTMX templates
	fs := http.FileServer(http.Dir("./templates"))
	mux.Handle("/static/", http.StripPrefix("/static/", fs))

	// API Endpoints
	mux.HandleFunc("GET /api/drive/sources", appHandler.ListDriveSources)
	mux.HandleFunc("POST /api/upload", appHandler.UploadLocalSpreadsheet)
	mux.HandleFunc("POST /api/import/confirm", appHandler.ConfirmAndImportSchema)
	mux.HandleFunc("GET /api/entities/search", appHandler.SearchEntities)
	mux.HandleFunc("GET /api/entities/drawer", appHandler.GetEntityDetailDrawer)
	mux.HandleFunc("GET /api/merges", appHandler.ListMergeSuggestions)
	mux.HandleFunc("POST /api/merges/approve", appHandler.ApproveMerge)
	mux.HandleFunc("POST /api/merges/reject", appHandler.RejectMerge)
	mux.HandleFunc("GET /api/stats", appHandler.GetStats)

	// Root Handler
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./templates/index.html")
	})

	// Wrap with Firebase Auth middleware
	handlerWithMiddleware := auth.Middleware(mux)

	server := &http.Server{
		Addr:         "0.0.0.0:" + port,
		Handler:      handlerWithMiddleware,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Channel for graceful shutdown
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("🚀 Event Data Hub (Trung tâm Dữ liệu Sự kiện) running on port %s\n", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v\n", err)
		}
	}()

	<-stop
	log.Println("Shutting down server gracefully...")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Fatalf("Server forced to shutdown: %v\n", err)
	}

	log.Println("Server stopped successfully.")
}
