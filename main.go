// Command event-data-hub serves the Go/HTMX build of Event Data Hub.
//
// It shares its Postgres schema (migrations/) with the Node build, so both can
// point at the same database.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"event-data-hub/internal/ai"
	"event-data-hub/internal/auth"
	"event-data-hub/internal/config"
	"event-data-hub/internal/db"
	"event-data-hub/internal/handlers"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("[fatal] %v", err)
	}
}

func run() error {
	cfg := config.Load()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// --- database -----------------------------------------------------------
	connectCtx, connectCancel := context.WithTimeout(ctx, 15*time.Second)
	database, err := db.Connect(connectCtx, cfg.DatabaseURL)
	connectCancel()
	if err != nil {
		return err
	}
	defer database.Close()

	migrateCtx, migrateCancel := context.WithTimeout(ctx, 60*time.Second)
	err = database.RunMigrations(migrateCtx)
	migrateCancel()
	if err != nil {
		return err
	}
	log.Println("[boot] database ready")

	// --- Gemini -------------------------------------------------------------
	// A missing API key is not fatal: the app still serves the dashboard and
	// search (keyword mode). Import is what actually requires it.
	var aiClient *ai.Client
	if c, err := ai.New(ctx, cfg); err != nil {
		if errors.Is(err, ai.ErrNotConfigured) {
			log.Println("[boot] GEMINI_API_KEY chưa được đặt — ánh xạ schema, đối chiếu hợp nhất " +
				"và tìm kiếm ngôn ngữ tự nhiên sẽ không hoạt động; nhập dữ liệu sẽ lỗi ở bước embedding.")
		} else {
			return err
		}
	} else {
		aiClient = c
		// Model ids change often; verifying once at boot turns a confusing
		// mid-demo 404 into a clear startup message.
		preflightCtx, preflightCancel := context.WithTimeout(ctx, 30*time.Second)
		err := aiClient.PreflightModel(preflightCtx)
		preflightCancel()
		if err != nil {
			log.Printf("[boot] model %q KHÔNG dùng được: %v", cfg.GeminiModel, err)
			log.Printf("[boot] đặt GEMINI_MODEL sang một model mà API key của bạn truy cập được")
		} else {
			log.Printf("[boot] Gemini model %q OK", cfg.GeminiModel)
		}
	}

	// --- templates ----------------------------------------------------------
	tpl, err := handlers.LoadTemplates()
	if err != nil {
		return err
	}

	// --- auth ---------------------------------------------------------------
	authMw, err := auth.New(ctx, cfg)
	if err != nil {
		return err
	}
	log.Printf("[boot] auth mode: %s", cfg.AuthMode)

	// --- routes -------------------------------------------------------------
	app := handlers.New(database, aiClient, cfg, tpl)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /app", app.Index)
	mux.HandleFunc("GET /fragments/entities", app.Entities)
	mux.HandleFunc("GET /fragments/entity", app.EntityDrawer)
	mux.HandleFunc("GET /fragments/sidebar", app.Stats)
	mux.HandleFunc("GET /fragments/merges", app.Merges)
	mux.HandleFunc("GET /fragments/drive", app.DriveList)
	mux.HandleFunc("POST /import/preview/upload", app.UploadPreview)
	mux.HandleFunc("POST /import/preview/drive", app.DrivePreview)
	mux.HandleFunc("POST /import/confirm", app.ImportConfirm)
	mux.HandleFunc("POST /merges/{id}/approve", app.ApproveMerge)
	mux.HandleFunc("POST /merges/{id}/reject", app.RejectMerge)

	// /healthz stays outside the auth middleware so Cloud Run can probe it.
	root := http.NewServeMux()
	root.HandleFunc("GET /healthz", app.Health)
	if cfg.AuthMode == "firebase" {
		root.HandleFunc("GET /{$}", app.Login)
		root.HandleFunc("POST /session", authMw.EstablishSession)
		root.HandleFunc("DELETE /session", authMw.ClearSession)
	} else {
		mux.HandleFunc("GET /{$}", app.Index)
	}
	root.Handle("/", authMw.Wrap(mux))

	server := &http.Server{
		Addr:              "0.0.0.0:" + cfg.Port,
		Handler:           root,
		ReadHeaderTimeout: 10 * time.Second,
		// Generous: an import performs embedding plus one Gemini adjudication
		// per candidate pair, which legitimately takes tens of seconds.
		ReadTimeout:  5 * time.Minute,
		WriteTimeout: 5 * time.Minute,
		IdleTimeout:  120 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	serverErr := make(chan error, 1)
	go func() {
		log.Printf("[boot] Event Data Hub listening on http://0.0.0.0:%s", cfg.Port)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	select {
	case err := <-serverErr:
		return err
	case sig := <-stop:
		log.Printf("[shutdown] %s received, closing", sig)
	}

	// Cloud Run allows 10s before SIGKILL.
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 9*time.Second)
	defer shutdownCancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return err
	}
	log.Println("[shutdown] stopped cleanly")
	return nil
}
