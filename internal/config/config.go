// Package config centralises environment configuration. Nothing outside this
// package reads os.Getenv, so the full set of knobs is visible in one place.
package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Port        string
	DatabaseURL string

	GeminiAPIKey string
	GeminiModel  string

	EmbeddingModel string
	EmbeddingDim   int
	UseVertex      bool
	GCPProject     string
	GCPLocation    string

	AuthMode           string // "firebase" | "dev"
	FirebaseProjectID  string
	FirebaseAPIKey     string
	FirebaseAuthDomain string
	FirebaseAppID      string
	// FirebaseServiceAccountJSON supplies a signing key. Verifying a token needs
	// only Google's public certificates, but minting a session cookie is a
	// privileged call that must sign — so without this the runtime's default
	// credentials have to carry the Service Account Token Creator role.
	FirebaseServiceAccountJSON string
	DevOrgID                   string
	DevEmail                   string

	ResolutionTopN        int
	MinVectorSimilarity   float64
	MinCombinedConfidence float64

	IsProduction bool
}

func Load() Config {
	return Config{
		Port:        env("PORT", "8080"),
		DatabaseURL: env("DATABASE_URL", "postgres://postgres:postgrespassword@localhost:5433/event_data_hub?sslmode=disable"),

		GeminiAPIKey: env("GEMINI_API_KEY", ""),
		GeminiModel:  env("GEMINI_MODEL", "gemini-3.6-flash"),

		EmbeddingModel: env("EMBEDDING_MODEL", "gemini-embedding-001"),
		EmbeddingDim:   envInt("EMBEDDING_DIM", 768),
		UseVertex:      envBool("USE_VERTEX_EMBEDDINGS", false),
		GCPProject:     env("GOOGLE_CLOUD_PROJECT", ""),
		GCPLocation:    env("GOOGLE_CLOUD_LOCATION", "us-central1"),

		AuthMode:           env("AUTH_MODE", "dev"),
		FirebaseProjectID:  env("FIREBASE_PROJECT_ID", ""),
		FirebaseAPIKey:     env("VITE_FIREBASE_API_KEY", ""),
		FirebaseAuthDomain: env("VITE_FIREBASE_AUTH_DOMAIN", ""),
		FirebaseAppID:      env("VITE_FIREBASE_APP_ID", ""),

		FirebaseServiceAccountJSON: env("FIREBASE_SERVICE_ACCOUNT_JSON", ""),
		DevOrgID:                   env("DEV_ORG_ID", "org_local_dev"),
		DevEmail:                   env("DEV_EMAIL", "dev@localhost"),

		ResolutionTopN:        envInt("RESOLUTION_TOP_N", 5),
		MinVectorSimilarity:   envFloat("RESOLUTION_MIN_SIMILARITY", 0.89),
		MinCombinedConfidence: envFloat("RESOLUTION_MIN_COMBINED", 0.5),

		IsProduction: env("GO_ENV", "") == "production" || env("NODE_ENV", "") == "production" || env("K_SERVICE", "") != "",
	}
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v, err := strconv.Atoi(env(key, "")); err == nil {
		return v
	}
	return fallback
}

func envFloat(key string, fallback float64) float64 {
	if v, err := strconv.ParseFloat(env(key, ""), 64); err == nil {
		return v
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	switch strings.ToLower(env(key, "")) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return fallback
}
