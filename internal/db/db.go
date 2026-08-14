// Package db owns the Postgres connection pool, migrations, and every SQL
// statement in the app. Raw pgx with explicit SQL — no ORM, no query builder.
package db

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type DB struct {
	Pool *pgxpool.Pool

	// iterativeScan records whether the server's pgvector supports
	// hnsw.iterative_scan (0.8.0+). Stage 1 retrieval filters candidates with
	// quals the HNSW index cannot evaluate, and pgvector applies those *after*
	// the approximate scan has already picked its ~ef_search tuples. Without
	// iterative scan a heavily filtered query can come back empty even though
	// matching rows exist. Detected once, after migrations have created the
	// extension.
	iterativeScan bool
}

// Connect opens the pool and verifies it. Unlike the previous version this
// returns an error when the database is unreachable instead of handing back a
// half-alive handle that panics on first use.
func Connect(ctx context.Context, dsn string) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	cfg.MaxConns = 10

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect to postgres: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return &DB{Pool: pool}, nil
}

func (d *DB) Close() {
	if d != nil && d.Pool != nil {
		d.Pool.Close()
	}
}

// WithTx runs fn inside a transaction, rolling back on error.
func (d *DB) WithTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	return tx.Commit(ctx)
}

// RunMigrations applies every *.up.sql in migrations/ that has not run yet.
// The same files are shared with the Node app, so both stay on one schema.
func (d *DB) RunMigrations(ctx context.Context) error {
	if _, err := d.Pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	applied := map[string]bool{}
	rows, err := d.Pool.Query(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		applied[v] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	dir, err := migrationsDir()
	if err != nil {
		return err
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read migrations dir %s: %w", dir, err)
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".up.sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	for _, name := range files {
		version := strings.TrimSuffix(name, ".up.sql")
		if applied[version] {
			continue
		}
		sqlBytes, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		err = d.WithTx(ctx, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, string(sqlBytes)); err != nil {
				return fmt.Errorf("apply %s: %w", name, err)
			}
			_, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, version)
			return err
		})
		if err != nil {
			return err
		}
		fmt.Printf("[db] applied migration %s\n", version)
	}

	d.detectIterativeScan(ctx)
	return nil
}

// detectIterativeScan resolves the capability once, from the installed pgvector
// version.
//
// Deliberately not probed via pg_settings: pgvector registers its GUCs in the
// module's _PG_init, which Postgres runs lazily the first time a session touches
// a vector type. On a freshly opened pooled connection — exactly what this
// probe gets — hnsw.iterative_scan is therefore absent from pg_settings even on
// 0.8.6, which would report the feature as missing. pg_extension is a catalog
// table and answers correctly on a cold connection.
func (d *DB) detectIterativeScan(ctx context.Context) {
	var version string
	err := d.Pool.QueryRow(ctx,
		`SELECT extversion FROM pg_extension WHERE extname = 'vector'`).Scan(&version)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		fmt.Println("[db] pgvector extension not found")
		return
	case err != nil:
		fmt.Printf("[db] could not read pgvector version: %v\n", err)
		return
	}

	d.iterativeScan = versionAtLeast(version, 0, 8)
	if d.iterativeScan {
		fmt.Printf("[db] pgvector %s — iterative scan enabled for candidate retrieval\n", version)
	} else {
		fmt.Printf("[db] pgvector %s predates iterative scan (0.8.0+); "+
			"falling back to a wider ef_search for candidate retrieval\n", version)
	}
}

// versionAtLeast compares the leading major.minor of an extension version such
// as "0.8.6". Unparseable input reports false, which selects the conservative
// fallback rather than a setting the server may not honour.
func versionAtLeast(version string, major, minor int) bool {
	parts := strings.SplitN(version, ".", 3)
	if len(parts) < 2 {
		return false
	}
	gotMajor, err := strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil {
		return false
	}
	gotMinor, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil {
		return false
	}
	if gotMajor != major {
		return gotMajor > major
	}
	return gotMinor >= minor
}

func migrationsDir() (string, error) {
	candidates := []string{
		os.Getenv("MIGRATIONS_DIR"),
		"migrations",
		filepath.Join("..", "migrations"),
	}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if info, err := os.Stat(c); err == nil && info.IsDir() {
			return c, nil
		}
	}
	return "", fmt.Errorf("migrations directory not found (set MIGRATIONS_DIR)")
}

// vectorLiteral renders a []float32 as pgvector's text input format. Passing it
// as a string with an explicit ::vector cast avoids needing pgx type
// registration on every pooled connection.
func vectorLiteral(v []float32) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, f := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, "%g", f)
	}
	b.WriteByte(']')
	return b.String()
}
