package main

import "testing"

// Sources that share a canonical entity have to end up in one component. If
// they did not, an approved merge would leave an entity whose records and links
// straddle two tenants — the exact isolation failure the migration exists to
// avoid.
func TestUnionFindGroupsSharedSources(t *testing.T) {
	uf := newUnionFind([]string{"a", "b", "c", "d"})

	uf.union("a", "b") // a and b share an entity
	uf.union("c", "d") // so do c and d

	if uf.find("a") != uf.find("b") {
		t.Fatal("a and b share an entity but landed in different components")
	}
	if uf.find("c") != uf.find("d") {
		t.Fatal("c and d share an entity but landed in different components")
	}
	if uf.find("a") == uf.find("c") {
		t.Fatal("unrelated sources were merged into one component")
	}

	// Transitivity: a—b and b—c means all three are one indivisible unit.
	uf.union("b", "c")
	if uf.find("a") != uf.find("d") {
		t.Fatal("chained sharing did not merge the two components")
	}
}

func TestUnionFindIsDeterministic(t *testing.T) {
	first := newUnionFind([]string{"x", "y", "z"})
	first.union("z", "x")
	first.union("y", "z")

	second := newUnionFind([]string{"x", "y", "z"})
	second.union("y", "z")
	second.union("x", "y")

	// Same graph, different insertion order: repeated runs must group and name
	// components identically, or a dry run would not describe the -apply.
	if first.find("x") != second.find("x") || first.find("y") != second.find("y") {
		t.Fatalf("roots differ by union order: %q vs %q", first.find("x"), second.find("x"))
	}
}

func TestComponentImportersDeduplicates(t *testing.T) {
	c := component{Sources: []source{
		{ImportedBy: "an@example.test"},
		{ImportedBy: "an@example.test"},
		{ImportedBy: "binh@example.test"},
		{ImportedBy: ""}, // dev-mode rows carry no importer
	}}
	got := c.importers()
	if len(got) != 2 {
		t.Fatalf("importers() = %v, want the two distinct non-empty addresses", got)
	}
}

// Only fully-resolved components may be applied; a blocked one must never slip
// through with an empty target org and silently re-key rows to "".
func TestReadyComponentsExcludesBlocked(t *testing.T) {
	components := []component{
		{Sources: []source{{ID: "1"}}, TargetOrg: "org_user_aa"},
		{Sources: []source{{ID: "2"}}, Blocked: "không tra được tài khoản"},
		{Sources: []source{{ID: "3"}}}, // resolved to nothing
	}
	ready := readyComponents(components)
	if len(ready) != 1 || ready[0].TargetOrg != "org_user_aa" {
		t.Fatalf("readyComponents() = %#v, want only the resolved component", ready)
	}
	if countSources(ready) != 1 {
		t.Fatalf("countSources() = %d, want 1", countSources(ready))
	}
}
