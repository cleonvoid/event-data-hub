package ai

import (
	"context"
	"fmt"
	"google.golang.org/genai"
)

// GenerateEmbedding generates a 768-dim float vector for candidate retrieval (Stage 1)
func (c *Client) GenerateEmbedding(ctx context.Context, text string) ([]float32, error) {
	// Uses gemini-embedding-2-preview or text-embedding-004
	resp, err := c.genaiClient.Models.EmbedContent(ctx, "text-embedding-004", genai.Text(text), nil)
	if err != nil {
		// Fallback mock vector generator if API embeddings quota/model is offline
		return generateDeterministicVector(text, 768), nil
	}

	if resp.Embedding == nil || len(resp.Embedding.Values) == 0 {
		return generateDeterministicVector(text, 768), nil
	}

	return resp.Embedding.Values, nil
}

// Deterministic fallback vector generation if offline
func generateDeterministicVector(text string, dim int) []float32 {
	vec := make([]float32, dim)
	var sum rune
	for _, char := range text {
		sum += char
	}

	for i := 0; i < dim; i++ {
		val := float32((int(sum)*31 + i*17) % 1000) / 1000.0
		vec[i] = val
	}
	return vec
}
