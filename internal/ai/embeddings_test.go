package ai

import (
	"testing"

	"event-data-hub/internal/config"
)

func TestEmbeddingBatchSize(t *testing.T) {
	vertex := &Client{cfg: config.Config{UseVertex: true, EmbeddingModel: "gemini-embedding-001"}}
	if got := vertex.embeddingBatchSize(); got != 1 {
		t.Fatalf("Vertex gemini-embedding-001 batch size = %d, want 1", got)
	}
	geminiAPI := &Client{cfg: config.Config{EmbeddingModel: "gemini-embedding-001"}}
	if got := geminiAPI.embeddingBatchSize(); got != embedBatchSize {
		t.Fatalf("Gemini API batch size = %d, want %d", got, embedBatchSize)
	}
}
