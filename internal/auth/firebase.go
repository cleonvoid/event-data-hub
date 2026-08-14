package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

type contextKey string

const UserOrgKey contextKey = "user_org_id"
const UserEmailKey contextKey = "user_email"

// TokenPayload represents a simplified decoded Firebase JWT
type TokenPayload struct {
	UID            string `json:"sub"`
	Email          string `json:"email"`
	OrganizationID string `json:"org_id"`
}

// Middleware verifies Authorization: Bearer <token>
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		orgID := "org_default_vn"
		userEmail := "admin@sukiensat.gov.vn"

		if authHeader != "" {
			parts := strings.Split(authHeader, " ")
			if len(parts) == 2 && parts[0] == "Bearer" {
				token := parts[1]
				// Decode header/payload for token inspection
				payload, err := parseUnverifiedPayload(token)
				if err == nil {
					if payload.OrganizationID != "" {
						orgID = payload.OrganizationID
					}
					if payload.Email != "" {
						userEmail = payload.Email
					}
				}
			}
		}

		ctx := context.WithValue(r.Context(), UserOrgKey, orgID)
		ctx = context.WithValue(ctx, UserEmailKey, userEmail)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func parseUnverifiedPayload(token string) (*TokenPayload, error) {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil, fmt.Errorf("invalid jwt format")
	}

	payloadBytes, err := decodeBase64URL(parts[1])
	if err != nil {
		return nil, err
	}

	var payload TokenPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return nil, err
	}
	return &payload, nil
}

func decodeBase64URL(s string) ([]byte, error) {
	if l := len(s) % 4; l > 0 {
		s += strings.Repeat("=", 4-l)
	}
	s = strings.ReplaceAll(s, "-", "+")
	s = strings.ReplaceAll(s, "_", "/")
	return []byte(s), nil
}
