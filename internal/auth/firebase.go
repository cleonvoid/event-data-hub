// Package auth verifies Firebase ID tokens.
//
// This replaces an earlier "middleware" that base64-decoded nothing, checked no
// signature, and fell through to a hardcoded org id on every request — a
// complete auth bypass. VerifyIDToken below checks the RS256 signature against
// Google's rotating public keys and validates issuer, audience and expiry.
package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	firebase "firebase.google.com/go/v4"
	firebaseauth "firebase.google.com/go/v4/auth"

	"event-data-hub/internal/config"
)

type ctxKey string

const userKey ctxKey = "edh_user"

type User struct {
	UID            string
	Email          string
	OrganizationID string
}

type Middleware struct {
	cfg    config.Config
	client *firebaseauth.Client
}

// New prepares the middleware. In firebase mode it initialises the Admin SDK;
// VerifyIDToken only needs the project id, since it fetches Google's public
// signing certificates over HTTPS.
func New(ctx context.Context, cfg config.Config) (*Middleware, error) {
	if cfg.AuthMode == "dev" {
		if cfg.IsProduction {
			return nil, errors.New("AUTH_MODE=dev bị từ chối khi chạy production; đặt AUTH_MODE=firebase và FIREBASE_PROJECT_ID")
		}
		return &Middleware{cfg: cfg}, nil
	}

	if cfg.FirebaseProjectID == "" {
		return nil, errors.New("AUTH_MODE=firebase cần FIREBASE_PROJECT_ID")
	}
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: cfg.FirebaseProjectID})
	if err != nil {
		return nil, fmt.Errorf("khởi tạo Firebase: %w", err)
	}
	client, err := app.Auth(ctx)
	if err != nil {
		return nil, fmt.Errorf("khởi tạo Firebase Auth: %w", err)
	}
	return &Middleware{cfg: cfg, client: client}, nil
}

// Wrap rejects unauthenticated requests with 401 instead of falling through.
func (m *Middleware) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if m.cfg.AuthMode == "dev" {
			ctx := context.WithValue(r.Context(), userKey, User{
				UID:            "dev-user",
				Email:          m.cfg.DevEmail,
				OrganizationID: m.cfg.DevOrgID,
			})
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		header := r.Header.Get("Authorization")
		parts := strings.SplitN(header, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || strings.TrimSpace(parts[1]) == "" {
			http.Error(w, "Thiếu Firebase ID token (Authorization: Bearer <token>)", http.StatusUnauthorized)
			return
		}

		token, err := m.client.VerifyIDToken(r.Context(), strings.TrimSpace(parts[1]))
		if err != nil {
			// 401 rather than 500: the client should re-authenticate.
			http.Error(w, "Firebase ID token không hợp lệ: "+err.Error(), http.StatusUnauthorized)
			return
		}

		email, _ := token.Claims["email"].(string)
		ctx := context.WithValue(r.Context(), userKey, User{
			UID:            token.UID,
			Email:          email,
			OrganizationID: deriveOrganizationID(token.Claims, email),
		})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

var orgSanitize = regexp.MustCompile(`[^a-z0-9.-]`)

// deriveOrganizationID picks the tenant key. A custom claim wins; otherwise
// everyone on the same email domain shares an organization, which is the right
// default for the public-sector users in the brief.
func deriveOrganizationID(claims map[string]any, email string) string {
	for _, key := range []string{"org_id", "organization_id"} {
		if v, ok := claims[key].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	if at := strings.LastIndex(email, "@"); at >= 0 && at+1 < len(email) {
		domain := orgSanitize.ReplaceAllString(strings.ToLower(email[at+1:]), "")
		if domain != "" {
			return "org_" + domain
		}
	}
	return "org_unknown"
}

// FromContext returns the authenticated user. ok is false only if this is
// called outside the middleware, which is a programming error rather than an
// auth failure.
func FromContext(ctx context.Context) (User, bool) {
	u, ok := ctx.Value(userKey).(User)
	return u, ok
}
