package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"event-data-hub/internal/ai"
	"event-data-hub/internal/sources"
)

// stagedImport is a parsed sheet waiting for the user to confirm its mapping.
type stagedImport struct {
	OrganizationID string
	SourceName     string
	SourceType     string
	ExternalFileID string
	Grid           *sources.Grid
	Mapping        map[string]ai.FieldMapping
	MappingError   string
	CreatedAt      time.Time
}

const (
	stagingTTL     = 30 * time.Minute
	stagingMaxRows = 5000
)

// stagingStore is an in-process TTL map.
//
// Deliberately in-memory: a staged import is scoped to one user's single
// confirmation step and is worthless after it. The trade-off is that it does
// not survive a restart and does not work across multiple instances — for a
// multi-instance Cloud Run deployment this should move to Redis/Memorystore or
// a temporary table. Documented in README.md.
type stagingStore struct {
	mu    sync.Mutex
	items map[string]*stagedImport
}

func newStagingStore() *stagingStore {
	s := &stagingStore{items: map[string]*stagedImport{}}
	go s.reap()
	return s
}

func (s *stagingStore) put(item *stagedImport) (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)

	item.CreatedAt = time.Now()
	s.mu.Lock()
	s.items[token] = item
	s.mu.Unlock()
	return token, nil
}

// get enforces organisation ownership as well as existence, so a token leaked
// to another tenant is still useless.
func (s *stagingStore) get(token, orgID string) (*stagedImport, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.items[token]
	if !ok || item.OrganizationID != orgID || time.Since(item.CreatedAt) > stagingTTL {
		return nil, false
	}
	return item, true
}

func (s *stagingStore) delete(token string) {
	s.mu.Lock()
	delete(s.items, token)
	s.mu.Unlock()
}

func (s *stagingStore) reap() {
	for range time.Tick(5 * time.Minute) {
		s.mu.Lock()
		for token, item := range s.items {
			if time.Since(item.CreatedAt) > stagingTTL {
				delete(s.items, token)
			}
		}
		s.mu.Unlock()
	}
}
