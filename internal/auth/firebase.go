// Package auth verifies Firebase ID tokens.
//
// This replaces an earlier "middleware" that base64-decoded nothing, checked no
// signature, and fell through to a hardcoded org id on every request — a
// complete auth bypass. VerifyIDToken below checks the RS256 signature against
// Google's rotating public keys and validates issuer, audience and expiry.
package auth

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	firebase "firebase.google.com/go/v4"
	firebaseauth "firebase.google.com/go/v4/auth"
	"google.golang.org/api/option"

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

// sessionCookieName holds a Firebase *session cookie*, not an ID token.
//
// The earlier version stored the raw ID token under a fixed 50-minute MaxAge.
// That was wrong twice over: the client hands back a cached ID token that may
// have only minutes of life left, so cookie lifetime and token lifetime drifted
// apart; and an ID token cannot be invalidated, so signing out — or disabling
// the account outright — left the cookie authenticating until it expired on its
// own. Session cookies are minted server-side with a lifetime we choose and are
// checked against revocation on every request.
const sessionCookieName = "edh_session"

// legacyCookieName is cleared alongside the real one so a browser holding a
// cookie from the previous scheme does not keep presenting it.
const legacyCookieName = "edh_id_token"

// sessionTTL is what Firebase mints the cookie for and what the browser is told
// to keep it for — one value, so the two cannot drift. Firebase permits 5
// minutes to 14 days. Revocation is checked per request, so a longer session is
// no longer a lingering-access risk.
const sessionTTL = 5 * 24 * time.Hour

// EstablishSession exchanges a freshly obtained Firebase ID token for a session
// cookie stored HttpOnly and same-site.
func (m *Middleware) EstablishSession(w http.ResponseWriter, r *http.Request) {
	if m.cfg.AuthMode != "firebase" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	header := r.Header.Get("Authorization")
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		http.Error(w, "Thiếu Firebase ID token", http.StatusUnauthorized)
		return
	}
	tokenString := strings.TrimSpace(parts[1])
	if _, err := m.client.VerifyIDToken(r.Context(), tokenString); err != nil {
		http.Error(w, "Firebase ID token không hợp lệ", http.StatusUnauthorized)
		return
	}

	cookie, err := m.client.SessionCookie(r.Context(), tokenString, sessionTTL)
	if err != nil {
		// Minting calls the Identity Toolkit :createSessionCookie endpoint —
		// it does not sign locally — so the credentials need the Firebase Auth
		// admin permission firebaseauth.users.createSession, not a signing role.
		log.Printf("[auth] tạo session cookie thất bại: %v", err)
		http.Error(w, "Máy chủ không tạo được phiên đăng nhập. Tài khoản dịch vụ cần quyền "+
			"Firebase Authentication Admin (roles/firebaseauth.admin).",
			http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    cookie,
		Path:     "/",
		MaxAge:   int(sessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   secureRequest(r),
		SameSite: http.SameSiteStrictMode,
	})
	w.WriteHeader(http.StatusNoContent)
}

// ClearSession revokes the account's refresh tokens before dropping the cookie.
// Deleting the browser's copy alone would leave any other copy of the session
// valid; revocation is what actually ends the session everywhere.
func (m *Middleware) ClearSession(w http.ResponseWriter, r *http.Request) {
	if m.cfg.AuthMode == "firebase" {
		if c, err := r.Cookie(sessionCookieName); err == nil {
			if token, err := m.client.VerifySessionCookie(r.Context(), c.Value); err == nil {
				if err := m.client.RevokeRefreshTokens(r.Context(), token.UID); err != nil {
					log.Printf("[auth] thu hồi refresh token thất bại cho %s: %v", token.UID, err)
				}
			}
		}
	}
	clearSessionCookies(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func clearSessionCookies(w http.ResponseWriter, r *http.Request) {
	for _, name := range []string{sessionCookieName, legacyCookieName} {
		http.SetCookie(w, &http.Cookie{
			Name: name, Value: "", Path: "/", MaxAge: -1,
			HttpOnly: true, Secure: secureRequest(r), SameSite: http.SameSiteStrictMode,
		})
	}
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
	// An explicit service account key is preferred. Verifying a token needs only
	// Google's public certificates, but minting and revoking sessions are
	// privileged Firebase Auth API calls (firebaseauth.users.createSession /
	// get / update). A Firebase-issued key carries them; bare application
	// default credentials do so only if the runtime service account holds
	// roles/firebaseauth.admin. Matches how the Node build reads the same
	// variable.
	// Pinned to ServiceAccount rather than the untyped WithCredentialsJSON, so
	// a credential file of some other type cannot be loaded by accident.
	var opts []option.ClientOption
	if json := strings.TrimSpace(cfg.FirebaseServiceAccountJSON); json != "" {
		opts = append(opts, option.WithAuthCredentialsJSON(option.ServiceAccount, []byte(json)))
	}
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: cfg.FirebaseProjectID}, opts...)
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

		// An explicit bearer token identifies an API client and is checked as an
		// ID token; browsers present the session cookie instead. Both paths
		// check revocation, so a signed-out or disabled account stops working
		// immediately rather than at token expiry.
		var token *firebaseauth.Token
		var err error

		header := r.Header.Get("Authorization")
		parts := strings.SplitN(header, " ", 2)
		if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
			if bearer := strings.TrimSpace(parts[1]); bearer != "" {
				token, err = m.client.VerifyIDTokenAndCheckRevoked(r.Context(), bearer)
			}
		}
		if token == nil && err == nil {
			cookie, cookieErr := r.Cookie(sessionCookieName)
			if cookieErr != nil || strings.TrimSpace(cookie.Value) == "" {
				m.unauthorized(w, r, "Chưa đăng nhập")
				return
			}
			token, err = m.client.VerifySessionCookieAndCheckRevoked(r.Context(), cookie.Value)
		}
		if err != nil || token == nil {
			m.unauthorized(w, r, "Phiên đăng nhập không hợp lệ hoặc đã hết hạn")
			return
		}

		email, _ := token.Claims["email"].(string)
		ctx := context.WithValue(r.Context(), userKey, User{
			UID:            token.UID,
			Email:          email,
			OrganizationID: deriveOrganizationID(token.Claims, token.UID),
		})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// unauthorized ends an unauthenticated request in a way the caller can act on.
//
// A bare 401 was a dead end: the login screen lives at "/" and nothing sent the
// user there, so returning after the session expired meant a plain-text error
// page on /app with no way forward, and an expired HTMX request swapped that
// same text into the modal host. Navigation now gets a redirect and HTMX gets
// HX-Redirect; genuine API clients still get the 401 they can handle.
func (m *Middleware) unauthorized(w http.ResponseWriter, r *http.Request, reason string) {
	clearSessionCookies(w, r)

	if r.Header.Get("HX-Request") == "true" {
		// 204, not 401: htmx is configured to swap error responses, and a
		// swapped error body would replace the redirect it should be following.
		w.Header().Set("HX-Redirect", "/")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept"), "text/html") {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	http.Error(w, reason, http.StatusUnauthorized)
}

var validOrganizationID = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,128}$`)

// deriveOrganizationID picks the tenant key. Organization membership is an
// authorization decision, so only an explicit custom claim may group users.
// Without one, each Firebase account gets an isolated personal organization.
func deriveOrganizationID(claims map[string]any, uid string) string {
	for _, key := range []string{"org_id", "organization_id"} {
		if v, ok := claims[key].(string); ok && strings.TrimSpace(v) != "" {
			if candidate := strings.TrimSpace(v); validOrganizationID.MatchString(candidate) {
				return candidate
			}
		}
	}
	return PersonalOrganizationID(uid)
}

// PersonalOrganizationID is the isolated tenant key for a Firebase account that
// carries no org_id claim. Exported so the tenant migration derives the same
// key the middleware will derive at login — if the two ever disagreed, migrated
// data would land in a tenant nobody can reach.
func PersonalOrganizationID(uid string) string {
	sum := sha256.Sum256([]byte(uid))
	return fmt.Sprintf("org_user_%x", sum[:12])
}

func secureRequest(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// FromContext returns the authenticated user. ok is false only if this is
// called outside the middleware, which is a programming error rather than an
// auth failure.
func FromContext(ctx context.Context) (User, bool) {
	u, ok := ctx.Value(userKey).(User)
	return u, ok
}
