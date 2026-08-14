// Package ai wraps the Gemini text and embedding APIs.
//
// Every call uses structured output (a response schema), not prose scraping,
// and every response is re-validated after parsing.
package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"google.golang.org/genai"

	"event-data-hub/internal/config"
)

var ErrNotConfigured = errors.New("GEMINI_API_KEY chưa được cấu hình")

type Client struct {
	text  *genai.Client
	embed *genai.Client
	cfg   config.Config
}

// New builds one client for generation and one for embeddings. They can point
// at different backends: generation always uses the Gemini API, while
// embeddings use Vertex AI when USE_VERTEX_EMBEDDINGS=true (Cloud Run gets
// credentials from ADC, so no API key is needed there).
func New(ctx context.Context, cfg config.Config) (*Client, error) {
	if cfg.GeminiAPIKey == "" && !(cfg.UseVertex && cfg.GCPProject != "") {
		return nil, ErrNotConfigured
	}

	c := &Client{cfg: cfg}

	if cfg.GeminiAPIKey != "" {
		tc, err := genai.NewClient(ctx, &genai.ClientConfig{
			APIKey:  cfg.GeminiAPIKey,
			Backend: genai.BackendGeminiAPI,
		})
		if err != nil {
			return nil, fmt.Errorf("gemini client: %w", err)
		}
		c.text = tc
		c.embed = tc
	}

	if cfg.UseVertex {
		if cfg.GCPProject == "" {
			return nil, errors.New("USE_VERTEX_EMBEDDINGS=true nhưng thiếu GOOGLE_CLOUD_PROJECT")
		}
		ec, err := genai.NewClient(ctx, &genai.ClientConfig{
			Backend:  genai.BackendVertexAI,
			Project:  cfg.GCPProject,
			Location: cfg.GCPLocation,
		})
		if err != nil {
			return nil, fmt.Errorf("vertex client: %w", err)
		}
		c.embed = ec
	}

	if c.text == nil {
		return nil, ErrNotConfigured
	}
	return c, nil
}

// PreflightModel makes one cheap call so a wrong GEMINI_MODEL surfaces at boot
// rather than as a confusing 404 mid-demo.
func (c *Client) PreflightModel(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	_, err := c.text.Models.GenerateContent(ctx, c.cfg.GeminiModel,
		genai.Text("Trả lời đúng một từ: OK"),
		&genai.GenerateContentConfig{Temperature: genai.Ptr(float32(0))})
	return err
}

var retryable = regexp.MustCompile(`\b(429|500|502|503|504|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED)\b`)

// generateJSON runs a structured-output call with retries on transient errors.
// Permanent failures (bad model id, bad key) return immediately — retrying
// those only makes a broken setup slower to diagnose.
func (c *Client) generateJSON(ctx context.Context, label, prompt string, schema *genai.Schema, out any) error {
	cfg := &genai.GenerateContentConfig{
		// Near-deterministic: these are extraction/classification tasks, and a
		// demo that answers differently each run is not debuggable.
		Temperature:      genai.Ptr(float32(0.1)),
		ResponseMIMEType: "application/json",
		ResponseSchema:   schema,
	}

	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		resp, err := c.text.Models.GenerateContent(ctx, c.cfg.GeminiModel, genai.Text(prompt), cfg)
		if err != nil {
			lastErr = fmt.Errorf("%s: %w", label, err)
			if !retryable.MatchString(err.Error()) {
				return lastErr
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(400*(1<<attempt)) * time.Millisecond):
			}
			continue
		}

		text := strings.TrimSpace(resp.Text())
		if text == "" {
			lastErr = fmt.Errorf("%s: mô hình trả về rỗng", label)
			continue
		}
		if err := json.Unmarshal([]byte(stripFence(text)), out); err != nil {
			return fmt.Errorf("%s: JSON không hợp lệ: %w", label, err)
		}
		return nil
	}
	return lastErr
}

// stripFence removes ```json fences some models still wrap around JSON output.
func stripFence(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			s = s[i+1:]
		}
		s = strings.TrimSuffix(strings.TrimSpace(s), "```")
	}
	return strings.TrimSpace(s)
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
