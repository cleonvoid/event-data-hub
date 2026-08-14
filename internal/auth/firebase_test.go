package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDeriveOrganizationID(t *testing.T) {
	t.Run("explicit valid claim groups users", func(t *testing.T) {
		got := deriveOrganizationID(map[string]any{"org_id": "innovation-center"}, "uid-1")
		if got != "innovation-center" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("missing claim isolates users", func(t *testing.T) {
		a := deriveOrganizationID(map[string]any{"email": "a@gmail.com"}, "uid-1")
		b := deriveOrganizationID(map[string]any{"email": "b@gmail.com"}, "uid-2")
		if a == b || !strings.HasPrefix(a, "org_user_") || !strings.HasPrefix(b, "org_user_") {
			t.Fatalf("expected distinct personal orgs, got %q and %q", a, b)
		}
	})

	t.Run("invalid claim cannot collide after sanitizing", func(t *testing.T) {
		got := deriveOrganizationID(map[string]any{"org_id": "org a"}, "uid-1")
		if got == "orga" {
			t.Fatal("invalid claim was silently rewritten into another tenant id")
		}
	})
}

// An expired session used to end at a bare text/plain 401 with no route back to
// the login screen at "/". Each caller now gets a recovery it can act on.
func TestUnauthorizedOffersARouteBack(t *testing.T) {
	var m Middleware

	t.Run("htmx gets HX-Redirect, not a swappable error body", func(t *testing.T) {
		r := httptest.NewRequest("GET", "http://example.test/fragments/entities", nil)
		r.Header.Set("HX-Request", "true")
		w := httptest.NewRecorder()
		m.unauthorized(w, r, "hết hạn")

		if got := w.Header().Get("HX-Redirect"); got != "/" {
			t.Fatalf("HX-Redirect = %q, want /", got)
		}
		if w.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204 so htmx does not swap the body", w.Code)
		}
	})

	t.Run("navigation is redirected to the login page", func(t *testing.T) {
		r := httptest.NewRequest("GET", "http://example.test/app", nil)
		r.Header.Set("Accept", "text/html,application/xhtml+xml")
		w := httptest.NewRecorder()
		m.unauthorized(w, r, "hết hạn")

		if w.Code != http.StatusSeeOther {
			t.Fatalf("status = %d, want 303", w.Code)
		}
		if got := w.Header().Get("Location"); got != "/" {
			t.Fatalf("Location = %q, want /", got)
		}
	})

	t.Run("api clients still get a 401 they can handle", func(t *testing.T) {
		r := httptest.NewRequest("POST", "http://example.test/import/confirm", nil)
		w := httptest.NewRecorder()
		m.unauthorized(w, r, "hết hạn")

		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", w.Code)
		}
	})

	t.Run("the stale cookie is always cleared", func(t *testing.T) {
		r := httptest.NewRequest("GET", "http://example.test/app", nil)
		w := httptest.NewRecorder()
		m.unauthorized(w, r, "hết hạn")

		var cleared int
		for _, c := range w.Result().Cookies() {
			if (c.Name == sessionCookieName || c.Name == legacyCookieName) && c.MaxAge < 0 {
				cleared++
			}
		}
		if cleared != 2 {
			t.Fatalf("cleared %d cookies, want both the session and legacy cookie", cleared)
		}
	})
}

func TestSecureRequest(t *testing.T) {
	r := httptest.NewRequest("GET", "http://example.test", nil)
	if secureRequest(r) {
		t.Fatal("plain HTTP marked secure")
	}
	r.Header.Set("X-Forwarded-Proto", "https")
	if !secureRequest(r) {
		t.Fatal("Cloud Run HTTPS proxy was not recognized")
	}
}
