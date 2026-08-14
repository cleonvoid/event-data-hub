package db

import (
	"strings"
	"testing"
)

// The 0.8.0 boundary decides whether Stage 1 retrieval gets iterative scan, so
// a misparse here silently reinstates the candidate loss it exists to prevent.
func TestVersionAtLeast(t *testing.T) {
	cases := []struct {
		version string
		want    bool
	}{
		{"0.8.6", true},  // what pgvector/pgvector:pg18 ships
		{"0.8.0", true},  // the boundary itself
		{"0.10.0", true}, // minor compared numerically, not lexically
		{"1.0.0", true},
		{"0.7.4", false},
		{"0.5.1", false},
		{"", false},
		{"garbage", false},
		{"0", false}, // no minor component
	}
	for _, c := range cases {
		if got := versionAtLeast(c.version, 0, 8); got != c.want {
			t.Errorf("versionAtLeast(%q, 0, 8) = %v, want %v", c.version, got, c.want)
		}
	}
}

// Older servers have no iterative scan, so the only available mitigation is a
// wider ef_search — the two paths must not be collapsed into one.
func TestVectorScanSettings(t *testing.T) {
	withIterative := vectorScanSettings(true)
	if len(withIterative) != 2 {
		t.Fatalf("got %d settings, want iterative_scan plus ef_search: %v", len(withIterative), withIterative)
	}
	if !contains(withIterative, "strict_order") {
		t.Errorf("expected strict_order (ORDER BY + LIMIT needs exact ordering), got %v", withIterative)
	}

	fallback := vectorScanSettings(false)
	if contains(fallback, "iterative_scan") {
		t.Errorf("fallback must not set a GUC the server predates: %v", fallback)
	}
	if !contains(fallback, "ef_search = 400") {
		t.Errorf("fallback must widen ef_search well past the default 40, got %v", fallback)
	}
}

func contains(stmts []string, substr string) bool {
	for _, s := range stmts {
		if strings.Contains(s, substr) {
			return true
		}
	}
	return false
}
