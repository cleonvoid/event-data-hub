// Command migrate-tenants re-keys data written under the old tenant scheme.
//
// Organization ids used to be derived from the signed-in user's email domain
// ("org_fpt.com"), so everyone sharing a domain shared a tenant. That was an
// authorization decision made from an attribute anyone with an address at the
// domain could present, so it was replaced by an isolated per-account key —
// org_user_<sha256(uid)> — with an explicit org_id custom claim as the only way
// to group users deliberately.
//
// Nothing re-pointed the existing rows, so after the change every query filters
// on a tenant key that matches nothing and previously imported data becomes
// invisible. This command moves that data to the personal tenant of whoever
// imported it.
//
//	go run ./cmd/migrate-tenants                       # list what can be migrated
//	go run ./cmd/migrate-tenants -orgs=org_fpt.com     # dry run for one tenant
//	go run ./cmd/migrate-tenants -orgs=org_fpt.com -apply
//
// Two properties make this safe to run against real data:
//
// Tenants are never guessed. An organization id that is not org_user_-shaped is
// not necessarily legacy — it may be a deliberate org_id custom claim grouping a
// real team, and silently dissolving that would be worse than doing nothing. So
// the command only ever touches tenants named explicitly with -orgs.
//
// Migration is atomic per entity graph. Approving a merge links one canonical
// entity to raw records from several sources, which may have different
// importers. Moving those sources to different tenants would leave an entity
// whose links, records and aggregate counts straddle a tenant boundary — the
// isolation the new scheme exists to provide, broken by the migration meant to
// preserve it. Sources that share an entity are therefore treated as one
// indivisible unit and always land in the same tenant.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	firebase "firebase.google.com/go/v4"
	firebaseauth "firebase.google.com/go/v4/auth"
	"github.com/jackc/pgx/v5"
	"google.golang.org/api/option"

	"event-data-hub/internal/auth"
	"event-data-hub/internal/config"
	"event-data-hub/internal/db"
)

func main() {
	orgs := flag.String("orgs", "", "comma-separated organization ids to migrate (required)")
	apply := flag.Bool("apply", false, "commit the migration; omit for a dry run")
	flag.Parse()

	if err := run(context.Background(), splitOrgs(*orgs), *apply); err != nil {
		log.Fatalf("[fatal] %v", err)
	}
}

func splitOrgs(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// queryer is satisfied by both *pgxpool.Pool and pgx.Tx. Discovery runs on the
// pool when it is only listing candidates, and inside the migration transaction
// when its results are about to be acted on.
type queryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// source is one importable unit of the old scheme.
type source struct {
	ID         string
	Name       string
	OrgID      string
	ImportedBy string
}

// component is a set of sources that share at least one canonical entity, and
// therefore must migrate together or not at all.
type component struct {
	Sources   []source
	TargetOrg string
	// Blocked explains why this component cannot move, empty when it can.
	Blocked string
}

func (c component) importers() []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range c.Sources {
		if e := strings.TrimSpace(s.ImportedBy); e != "" && !seen[e] {
			seen[e] = true
			out = append(out, e)
		}
	}
	sort.Strings(out)
	return out
}

func run(ctx context.Context, orgs []string, apply bool) error {
	cfg := config.Load()

	connectCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	database, err := db.Connect(connectCtx, cfg.DatabaseURL)
	cancel()
	if err != nil {
		return err
	}
	defer database.Close()

	if len(orgs) == 0 {
		return listCandidates(ctx, database, apply)
	}

	// A first read purely to learn which addresses need resolving. Its results
	// are never acted on — the transaction below re-reads everything — so it
	// racing a concurrent import is harmless.
	preview, err := loadSources(ctx, database.Pool, orgs)
	if err != nil {
		return err
	}
	if len(preview) == 0 {
		return fmt.Errorf("không có nguồn nào thuộc %s", strings.Join(orgs, ", "))
	}

	authClient, err := firebaseAuth(ctx, cfg)
	if err != nil {
		return err
	}
	owners := resolveOwners(ctx, authClient, preview)

	// The dry run performs the whole migration and rolls it back, so the counts
	// below are measured rather than predicted — including how many suggestions
	// have to be dropped, which cannot be worked out without applying the moves.
	sum, components, err := migrate(ctx, database, orgs, owners, apply)
	if err != nil {
		return err
	}
	report(components)

	ready := readyComponents(components)
	if len(ready) == 0 {
		return errors.New("không có nhóm nào đủ điều kiện di trú")
	}

	verb := "Sẽ di trú"
	if apply {
		verb = "Đã di trú"
	}
	fmt.Printf("\n%s %d nhóm (%d nguồn).\n", verb, len(ready), countSources(ready))
	sum.reportDropped(apply)
	if blocked := len(components) - len(ready); blocked > 0 {
		fmt.Printf("Bỏ qua %d nhóm (xem lý do ở trên).\n", blocked)
	}
	if !apply {
		fmt.Println("\nChạy thử (dry run) — đã hoàn tác. Thêm -apply để thực hiện.")
	}
	return nil
}

// listCandidates runs when no tenant was named. It never migrates anything: the
// operator has to confirm which of these are genuinely legacy, because an
// org_id custom claim produces an id indistinguishable from an old domain key.
func listCandidates(ctx context.Context, d *db.DB, apply bool) error {
	rows, err := d.Pool.Query(ctx, `
		SELECT organization_id, count(*), COALESCE(string_agg(DISTINCT imported_by, ', '), '')
		FROM sources
		WHERE organization_id NOT LIKE 'org\_user\_%'
		GROUP BY organization_id
		ORDER BY organization_id`)
	if err != nil {
		return fmt.Errorf("đọc danh sách tổ chức: %w", err)
	}
	defer rows.Close()

	found := false
	fmt.Println("Các tổ chức chưa dùng khóa org_user_:")
	for rows.Next() {
		var org, importers string
		var n int
		if err := rows.Scan(&org, &n, &importers); err != nil {
			return err
		}
		found = true
		fmt.Printf("  %-30s %3d nguồn   %s\n", org, n, importers)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if !found {
		fmt.Println("  (không có)")
		return nil
	}

	fmt.Println("\nMột org_id đặt qua custom claim cũng có dạng này và KHÔNG nên di trú.")
	fmt.Println("Chọn rõ tổ chức cần xử lý:  -orgs=org_a,org_b")
	if apply {
		return errors.New("-apply cần đi kèm -orgs")
	}
	return nil
}

func loadSources(ctx context.Context, d queryer, orgs []string) ([]source, error) {
	rows, err := d.Query(ctx, `
		SELECT id, name, organization_id, COALESCE(imported_by, '')
		FROM sources
		WHERE organization_id = ANY($1)
		ORDER BY imported_at, id`, orgs)
	if err != nil {
		return nil, fmt.Errorf("đọc danh sách nguồn: %w", err)
	}
	defer rows.Close()

	var out []source
	for rows.Next() {
		var s source
		if err := rows.Scan(&s.ID, &s.Name, &s.OrgID, &s.ImportedBy); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// buildComponents groups the selected sources into indivisible units.
//
// A pair reaching a source outside the selection means the entity graph extends
// into a tenant the operator did not name. Migrating half of it would create the
// cross-tenant entity this command exists to avoid, so the whole component is
// blocked and the operator is told which tenant to include.
func buildComponents(ctx context.Context, d queryer, selected []source) ([]component, error) {
	index := map[string]source{}
	ids := make([]string, 0, len(selected))
	for _, s := range selected {
		index[s.ID] = s
		ids = append(ids, s.ID)
	}

	rows, err := d.Query(ctx, `
		SELECT DISTINCT a.source_id, b.source_id
		FROM raw_to_canonical la
		JOIN raw_records a ON a.id = la.raw_record_id
		JOIN raw_to_canonical lb ON lb.canonical_entity_id = la.canonical_entity_id
		JOIN raw_records b ON b.id = lb.raw_record_id
		WHERE a.source_id <> b.source_id
		  AND a.source_id = ANY($1)`, ids)
	if err != nil {
		return nil, fmt.Errorf("tìm thực thể dùng chung: %w", err)
	}
	defer rows.Close()

	uf := newUnionFind(ids)
	outside := map[string][]string{} // root -> external source ids
	for rows.Next() {
		var a, b string
		if err := rows.Scan(&a, &b); err != nil {
			return nil, err
		}
		if _, ok := index[b]; !ok {
			outside[a] = append(outside[a], b)
			continue
		}
		uf.union(a, b)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	grouped := map[string][]source{}
	for _, s := range selected {
		root := uf.find(s.ID)
		grouped[root] = append(grouped[root], s)
	}
	// External neighbours block whichever component their in-selection partner
	// ended up in, which is only known after every union has been applied.
	blockedRoots := map[string][]string{}
	for inside, external := range outside {
		root := uf.find(inside)
		blockedRoots[root] = append(blockedRoots[root], external...)
	}

	roots := make([]string, 0, len(grouped))
	for root := range grouped {
		roots = append(roots, root)
	}
	sort.Strings(roots)

	out := make([]component, 0, len(roots))
	for _, root := range roots {
		c := component{Sources: grouped[root]}
		if external := blockedRoots[root]; len(external) > 0 {
			orgs, err := orgsForSources(ctx, d, external)
			if err != nil {
				return nil, err
			}
			c.Blocked = "thực thể dùng chung với tổ chức chưa được chọn: " + strings.Join(orgs, ", ")
		}
		out = append(out, c)
	}
	return out, nil
}

func orgsForSources(ctx context.Context, d queryer, sourceIDs []string) ([]string, error) {
	rows, err := d.Query(ctx, `
		SELECT DISTINCT organization_id FROM sources WHERE id = ANY($1) ORDER BY 1`, sourceIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var org string
		if err := rows.Scan(&org); err != nil {
			return nil, err
		}
		out = append(out, org)
	}
	return out, rows.Err()
}

// resolveOwners maps each importer address to its personal tenant key.
//
// Deliberately done before the migration transaction opens. Every lookup is a
// network round trip to Firebase, and holding a transaction — which by then also
// holds an advisory lock and a serializable snapshot — open across them would
// block the running app for as long as Firebase takes to answer.
//
// An address that does not resolve is simply absent from the map; assignTargets
// turns that into a blocked component with a reason.
func resolveOwners(ctx context.Context, client *firebaseauth.Client, sources []source) map[string]string {
	owners := map[string]string{}
	for _, s := range sources {
		email := strings.TrimSpace(s.ImportedBy)
		if email == "" {
			continue
		}
		key := strings.ToLower(email)
		if _, done := owners[key]; done {
			continue
		}
		user, err := client.GetUserByEmail(ctx, email)
		if err != nil {
			continue
		}
		owners[key] = auth.PersonalOrganizationID(user.UID)
	}
	return owners
}

// assignTargets picks each component's owner from the pre-resolved map. Pure —
// no I/O — so it is safe to call inside the migration transaction on the
// freshly-read component set.
//
// Sources are ordered by import time, so the first importer in a component is
// the one who introduced the data.
func assignTargets(components []component, owners map[string]string) {
	for i := range components {
		c := &components[i]
		if c.Blocked != "" {
			continue
		}
		// The earliest source, not the alphabetically-first importer.
		var owner string
		for _, s := range c.Sources {
			if e := strings.TrimSpace(s.ImportedBy); e != "" {
				owner = e
				break
			}
		}
		if owner == "" {
			c.Blocked = "không có imported_by"
			continue
		}
		orgID, ok := owners[strings.ToLower(owner)]
		if !ok {
			// Either the lookup failed, or this source appeared after the
			// pre-resolution pass — a concurrent import. Re-running picks it up.
			c.Blocked = fmt.Sprintf("không tra được tài khoản Firebase cho %s", owner)
			continue
		}
		c.TargetOrg = orgID
	}
}

func report(components []component) {
	fmt.Printf("%d nhóm dữ liệu không thể tách rời:\n\n", len(components))
	for _, c := range components {
		importers := c.importers()
		fmt.Printf("  Nhóm %d nguồn", len(c.Sources))
		if len(importers) > 1 {
			fmt.Printf("  ⚠ dữ liệu đã gộp giữa %d người: %s", len(importers), strings.Join(importers, ", "))
		}
		fmt.Println()
		for _, s := range c.Sources {
			fmt.Printf("    %-40s %-28s %s\n", truncate(s.Name, 40), s.ImportedBy, s.OrgID)
		}
		if c.Blocked != "" {
			fmt.Printf("    → BỎ QUA: %s\n", c.Blocked)
		} else {
			fmt.Printf("    → %s\n", c.TargetOrg)
			if len(importers) > 1 {
				fmt.Printf("      (toàn bộ nhóm về một chủ sở hữu; tách ra sẽ làm thực thể nằm giữa hai tổ chức)\n")
			}
		}
		fmt.Println()
	}
}

func readyComponents(components []component) []component {
	var out []component
	for _, c := range components {
		if c.Blocked == "" && c.TargetOrg != "" {
			out = append(out, c)
		}
	}
	return out
}

func countSources(components []component) int {
	n := 0
	for _, c := range components {
		n += len(c.Sources)
	}
	return n
}

// summary is what a run actually did, measured inside the transaction.
type summary struct {
	// DroppedSuggestions counts merge_suggestions removed because the entity and
	// the candidate record ended up in different tenants, keyed by status.
	DroppedSuggestions map[string]int
}

func (s summary) reportDropped(applied bool) {
	if len(s.DroppedSuggestions) == 0 {
		return
	}
	statuses := make([]string, 0, len(s.DroppedSuggestions))
	total := 0
	for status, n := range s.DroppedSuggestions {
		statuses = append(statuses, status)
		total += n
	}
	sort.Strings(statuses)

	verb := "Sẽ xoá"
	if applied {
		verb = "Đã xoá"
	}
	fmt.Printf("%s %d gợi ý hợp nhất nằm giữa hai tổ chức:\n", verb, total)
	for _, status := range statuses {
		fmt.Printf("    %-10s %d\n", status, s.DroppedSuggestions[status])
	}
	fmt.Println("    (một gợi ý 'pending' như vậy nếu được duyệt sẽ kéo bản ghi của " +
		"tổ chức khác sang; 'rejected' không còn tác dụng vì hai bên đã khác tổ chức)")
}

// migrate discovers what to move and moves it, all inside one transaction, then
// refuses to commit unless the result is free of cross-tenant references.
//
// Discovery is deliberately *inside* the transaction. Reading the sources and
// computing components on pool connections first would leave a window in which
// the running app could import a new source or approve a merge, and the
// migration would then act on a snapshot that no longer described the database —
// re-linking an entity whose component had since grown, or silently leaving a
// newly-imported source behind in the legacy tenant.
//
// Concurrent writes are blocked rather than detected. SERIALIZABLE would not
// abort a concurrent import: detecting that needs a read-write dependency cycle,
// and an INSERT reading nothing this transaction wrote never forms one, so the
// new row would just be invisible and left behind in the legacy tenant. Instead
// SHARE ROW EXCLUSIVE holds off INSERT/UPDATE/DELETE for the few seconds the
// migration runs while still allowing reads, so the app keeps serving pages and
// only imports wait. It also self-conflicts, so two migrations cannot interleave.
//
// The lock is taken before any query, and the transaction stays at READ
// COMMITTED, because both halves matter. A REPEATABLE READ or SERIALIZABLE
// snapshot is fixed by the *first query* in the transaction — which would be
// earlier than the moment LOCK TABLE is granted — so an import committing in
// that window would be excluded from the snapshot even though the lock later
// waited for it. Under READ COMMITTED each statement takes a fresh snapshot, so
// every read below happens after the lock is held and sees a settled database.
//
// The work always runs; commit decides whether it is kept. A dry run is
// therefore a real migration that is rolled back, which is the only way to
// report exact numbers and the only way to prove the integrity gate passes
// before anyone commits.
func migrate(
	ctx context.Context, d *db.DB, orgs []string, owners map[string]string, commit bool,
) (summary, []component, error) {
	var sum summary

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return sum, nil, fmt.Errorf("begin: %w", err)
	}
	// Rollback is a no-op once committed, and discards everything otherwise.
	defer func() { _ = tx.Rollback(ctx) }()

	// First statement in the transaction, before anything reads: every table the
	// migration re-keys, so no import or merge approval can land between
	// discovery and the last UPDATE. Released with the transaction.
	if _, err := tx.Exec(ctx, `
		LOCK TABLE sources, raw_records, canonical_entities, raw_to_canonical, merge_suggestions
		IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		return sum, nil, fmt.Errorf("khoá bảng: %w", err)
	}

	selected, err := loadSources(ctx, tx, orgs)
	if err != nil {
		return sum, nil, err
	}
	if len(selected) == 0 {
		return sum, nil, fmt.Errorf("không có nguồn nào thuộc %s", strings.Join(orgs, ", "))
	}
	components, err := buildComponents(ctx, tx, selected)
	if err != nil {
		return sum, nil, err
	}
	assignTargets(components, owners)

	ready := readyComponents(components)
	if len(ready) == 0 {
		return sum, components, nil
	}

	if err := applyComponents(ctx, tx, ready); err != nil {
		return sum, components, err
	}

	// Everything this run is responsible for, and nothing else.
	var migrated []string
	for _, c := range ready {
		for _, s := range c.Sources {
			migrated = append(migrated, s.ID)
		}
	}

	dropped, err := dropCrossTenantSuggestions(ctx, tx, migrated)
	if err != nil {
		return sum, components, err
	}
	sum.DroppedSuggestions = dropped

	if err := verifyNoCrossTenantRows(ctx, tx, migrated); err != nil {
		return sum, components, err
	}
	if !commit {
		return sum, components, nil
	}
	return sum, components, tx.Commit(ctx)
}

func applyComponents(ctx context.Context, tx pgx.Tx, components []component) error {
	for _, c := range components {
		ids := make([]string, 0, len(c.Sources))
		for _, s := range c.Sources {
			ids = append(ids, s.ID)
		}

		// Entities first: the subquery reads raw_records.source_id, which the
		// later statements do not change, but ordering it first keeps the
		// intent obvious — the entity follows its records, not its old org.
		if _, err := tx.Exec(ctx, `
				UPDATE canonical_entities SET organization_id = $2
				WHERE id IN (
					SELECT l.canonical_entity_id
					FROM raw_to_canonical l
					JOIN raw_records r ON r.id = l.raw_record_id
					WHERE r.source_id = ANY($1))`, ids, c.TargetOrg); err != nil {
			return fmt.Errorf("canonical_entities: %w", err)
		}
		if _, err := tx.Exec(ctx, `
				UPDATE merge_suggestions SET organization_id = $2
				WHERE canonical_entity_id IN (
					SELECT l.canonical_entity_id
					FROM raw_to_canonical l
					JOIN raw_records r ON r.id = l.raw_record_id
					WHERE r.source_id = ANY($1))`, ids, c.TargetOrg); err != nil {
			return fmt.Errorf("merge_suggestions: %w", err)
		}
		if _, err := tx.Exec(ctx, `
				UPDATE raw_to_canonical l SET organization_id = $2
				FROM raw_records r
				WHERE r.id = l.raw_record_id AND r.source_id = ANY($1)`, ids, c.TargetOrg); err != nil {
			return fmt.Errorf("raw_to_canonical: %w", err)
		}
		if _, err := tx.Exec(ctx, `
				UPDATE raw_records SET organization_id = $2 WHERE source_id = ANY($1)`,
			ids, c.TargetOrg); err != nil {
			return fmt.Errorf("raw_records: %w", err)
		}
		if _, err := tx.Exec(ctx, `
				UPDATE sources SET organization_id = $2 WHERE id = ANY($1)`,
			ids, c.TargetOrg); err != nil {
			return fmt.Errorf("sources: %w", err)
		}
	}
	return nil
}

// dropCrossTenantSuggestions removes merge_suggestions whose canonical entity
// and candidate raw record no longer share a tenant, returning counts by status.
//
// These are created by the split itself. Components are closed over *approved*
// links (raw_to_canonical), so an approved suggestion's record always travels
// with its entity — but a pending one names a record that is not linked yet and
// is free to sit in another component. Left in place, approving it would link a
// record owned by one tenant to an entity owned by another, quietly moving data
// across the boundary the migration exists to draw.
//
// Rejected pairs go too. They are the negative signal that stops a pair being
// re-proposed, but candidate retrieval filters on organization_id, so a pair
// split across tenants can never be proposed again anyway.
//
// Scoped to the migrated sources. A cross-tenant suggestion elsewhere in the
// database was not created by this run — it may predate it or belong to a tenant
// the operator deliberately left alone — and deleting it would be destroying
// data outside the scope that -orgs asked for.
func dropCrossTenantSuggestions(ctx context.Context, tx pgx.Tx, sourceIDs []string) (map[string]int, error) {
	rows, err := tx.Query(ctx, `
		DELETE FROM merge_suggestions ms
		USING canonical_entities c, raw_records r
		WHERE c.id = ms.canonical_entity_id
		  AND r.id = ms.candidate_raw_record_id
		  AND c.organization_id <> r.organization_id
		  AND (r.source_id = ANY($1) OR `+entityTouchesScope+`)
		RETURNING ms.status`, sourceIDs)
	if err != nil {
		return nil, fmt.Errorf("xoá gợi ý liên tổ chức: %w", err)
	}
	defer rows.Close()

	out := map[string]int{}
	for rows.Next() {
		var status string
		if err := rows.Scan(&status); err != nil {
			return nil, err
		}
		out[status]++
	}
	return out, rows.Err()
}

// entityTouchesScope is true when a suggestion's canonical entity is backed by
// any raw record from the migrated sources. Suggestions reach across components,
// so scoping them by the candidate record alone would miss the ones this run is
// responsible for.
const entityTouchesScope = `
	EXISTS (
		SELECT 1 FROM raw_to_canonical sl
		JOIN raw_records sr ON sr.id = sl.raw_record_id
		WHERE sl.canonical_entity_id = ms.canonical_entity_id
		  AND sr.source_id = ANY($1))`

// verifyNoCrossTenantRows is the gate that makes -apply safe to trust. Each
// check counts rows whose tenant disagrees with the row it hangs off; any hit
// means a query filtered by organization_id would see a partial object, so the
// whole transaction is rolled back rather than committed half-right.
//
// Every check is scoped to the migrated sources, for the same reason the delete
// is: a pre-existing inconsistency in a tenant nobody asked to touch is not this
// run's doing, and aborting on it would make an unrelated tenant's bad data
// permanently block a migration that is itself correct.
func verifyNoCrossTenantRows(ctx context.Context, tx pgx.Tx, sourceIDs []string) error {
	checks := []struct {
		what string
		sql  string
	}{
		{"raw_records lệch tổ chức với sources", `
			SELECT count(*) FROM raw_records r
			JOIN sources s ON s.id = r.source_id
			WHERE r.organization_id <> s.organization_id
			  AND r.source_id = ANY($1)`},
		{"raw_to_canonical lệch tổ chức với canonical_entities", `
			SELECT count(*) FROM raw_to_canonical l
			JOIN canonical_entities c ON c.id = l.canonical_entity_id
			JOIN raw_records lr ON lr.id = l.raw_record_id
			WHERE l.organization_id <> c.organization_id
			  AND lr.source_id = ANY($1)`},
		{"canonical_entities lệch tổ chức với bản ghi liên kết", `
			SELECT count(*) FROM raw_to_canonical l
			JOIN canonical_entities c ON c.id = l.canonical_entity_id
			JOIN raw_records r ON r.id = l.raw_record_id
			WHERE c.organization_id <> r.organization_id
			  AND r.source_id = ANY($1)`},
		{"merge_suggestions lệch tổ chức với thực thể", `
			SELECT count(*) FROM merge_suggestions ms
			JOIN canonical_entities c ON c.id = ms.canonical_entity_id
			WHERE ms.organization_id <> c.organization_id
			  AND ` + entityTouchesScope},
		// The one that matters most: a suggestion whose candidate belongs to
		// another tenant is an approve button that moves data across the
		// boundary. dropCrossTenantSuggestions should have removed every one.
		{"gợi ý có bản ghi ứng viên thuộc tổ chức khác", `
			SELECT count(*) FROM merge_suggestions ms
			JOIN canonical_entities c ON c.id = ms.canonical_entity_id
			JOIN raw_records r ON r.id = ms.candidate_raw_record_id
			WHERE c.organization_id <> r.organization_id
			  AND (r.source_id = ANY($1) OR ` + entityTouchesScope + `)`},
	}
	for _, check := range checks {
		var n int
		if err := tx.QueryRow(ctx, check.sql, sourceIDs).Scan(&n); err != nil {
			return fmt.Errorf("kiểm tra %q: %w", check.what, err)
		}
		if n > 0 {
			return fmt.Errorf("huỷ di trú: %d dòng %s", n, check.what)
		}
	}
	return nil
}

func firebaseAuth(ctx context.Context, cfg config.Config) (*firebaseauth.Client, error) {
	if cfg.FirebaseProjectID == "" {
		return nil, errors.New("cần FIREBASE_PROJECT_ID để tra cứu tài khoản theo email")
	}
	var opts []option.ClientOption
	if json := strings.TrimSpace(cfg.FirebaseServiceAccountJSON); json != "" {
		opts = append(opts, option.WithAuthCredentialsJSON(option.ServiceAccount, []byte(json)))
	}
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: cfg.FirebaseProjectID}, opts...)
	if err != nil {
		return nil, fmt.Errorf("khởi tạo Firebase: %w", err)
	}
	return app.Auth(ctx)
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// --- union-find ------------------------------------------------------------

type unionFind struct{ parent map[string]string }

func newUnionFind(ids []string) *unionFind {
	uf := &unionFind{parent: make(map[string]string, len(ids))}
	for _, id := range ids {
		uf.parent[id] = id
	}
	return uf
}

func (u *unionFind) find(id string) string {
	for u.parent[id] != id {
		u.parent[id] = u.parent[u.parent[id]] // path halving
		id = u.parent[id]
	}
	return id
}

func (u *unionFind) union(a, b string) {
	ra, rb := u.find(a), u.find(b)
	if ra == rb {
		return
	}
	// Deterministic root so repeated runs group identically.
	if ra < rb {
		u.parent[rb] = ra
	} else {
		u.parent[ra] = rb
	}
}
