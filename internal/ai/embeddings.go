package ai

import (
	"context"
	"fmt"
	"math"

	"google.golang.org/genai"
)

const embedBatchSize = 16

// EmbedTexts returns one unit-normalised vector per input.
//
// There is deliberately NO fallback vector generator. An earlier version
// synthesised a vector from a character sum whenever the API failed, which made
// entity resolution silently degrade to noise while still appearing to work.
// Embedding failure now propagates.
func (c *Client) EmbedTexts(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}

	dim := int32(c.cfg.EmbeddingDim)
	out := make([][]float32, 0, len(texts))

	for start := 0; start < len(texts); start += embedBatchSize {
		end := start + embedBatchSize
		if end > len(texts) {
			end = len(texts)
		}
		batch := texts[start:end]

		contents := make([]*genai.Content, len(batch))
		for i, t := range batch {
			contents[i] = genai.NewContentFromText(t, genai.RoleUser)
		}

		resp, err := c.embed.Models.EmbedContent(ctx, c.cfg.EmbeddingModel, contents,
			&genai.EmbedContentConfig{
				OutputDimensionality: &dim,
				// Dedup compares records against each other symmetrically, which
				// is what SEMANTIC_SIMILARITY is for (not RETRIEVAL_*).
				TaskType: "SEMANTIC_SIMILARITY",
			})
		if err != nil {
			return nil, fmt.Errorf("embed batch [%d:%d): %w", start, end, err)
		}
		if len(resp.Embeddings) != len(batch) {
			return nil, fmt.Errorf("embed batch size mismatch: sent %d, got %d", len(batch), len(resp.Embeddings))
		}

		for _, e := range resp.Embeddings {
			if len(e.Values) == 0 {
				return nil, fmt.Errorf("embedding API trả về vector rỗng")
			}
			if len(e.Values) != c.cfg.EmbeddingDim {
				return nil, fmt.Errorf(
					"embedding dimension mismatch: model trả về %d, schema cần VECTOR(%d); "+
						"đặt EMBEDDING_DIM và migration về cùng một giá trị",
					len(e.Values), c.cfg.EmbeddingDim)
			}
			out = append(out, Normalize(e.Values))
		}
	}
	return out, nil
}

// Normalize scales a vector to unit length so cosine distance in pgvector and
// the centroid arithmetic below stay meaningful.
func Normalize(v []float32) []float32 {
	var sum float64
	for _, f := range v {
		sum += float64(f) * float64(f)
	}
	mag := math.Sqrt(sum)
	if mag == 0 {
		out := make([]float32, len(v))
		copy(out, v)
		return out
	}
	out := make([]float32, len(v))
	for i, f := range v {
		out[i] = float32(float64(f) / mag)
	}
	return out
}

// Centroid is the element-wise mean of unit vectors, re-normalised. Used to
// keep a canonical entity's embedding representative as it absorbs name variants.
func Centroid(vectors [][]float32) ([]float32, error) {
	if len(vectors) == 0 {
		return nil, fmt.Errorf("centroid cần ít nhất một vector")
	}
	dim := len(vectors[0])
	acc := make([]float64, dim)
	for _, v := range vectors {
		if len(v) != dim {
			return nil, fmt.Errorf("centroid: vector khác số chiều (%d vs %d)", len(v), dim)
		}
		for i, f := range v {
			acc[i] += float64(f)
		}
	}
	out := make([]float32, dim)
	for i := range acc {
		out[i] = float32(acc[i] / float64(len(vectors)))
	}
	return Normalize(out), nil
}
