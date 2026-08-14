// Package search holds the whitelist that makes natural-language search safe.
//
// A language model chooses a column id and an operator id from these tables. It
// never produces SQL. Each id maps to a FIXED SQL fragment defined here in Go
// source, so no model-authored string is ever concatenated into a query; only
// bound $n parameters carry model-derived data.
//
// Adding a column here is the ONLY way to widen what search can reach.
package search

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type ValueType string

const (
	TypeText   ValueType = "text"
	TypeNumber ValueType = "number"
)

type ColumnKind string

const (
	KindEntity    ColumnKind = "entity"
	KindEvent     ColumnKind = "event"
	KindAggregate ColumnKind = "aggregate"
)

type ColumnDef struct {
	Kind ColumnKind
	// Fixed SQL fragment. Never contains anything derived from user/model input.
	SQL   string
	Type  ValueType
	Label string
}

var columns = map[string]ColumnDef{
	"display_name":         {KindEntity, "c.display_name", TypeText, "Tên hiển thị"},
	"primary_organization": {KindEntity, "c.primary_organization", TypeText, "Đơn vị"},
	"primary_role":         {KindEntity, "c.primary_role", TypeText, "Chức danh"},
	"primary_email":        {KindEntity, "c.primary_email", TypeText, "Email"},
	"event_name":           {KindEvent, "r.event_name", TypeText, "Tên sự kiện"},
	"event_year":           {KindEvent, "EXTRACT(YEAR FROM r.event_date)", TypeNumber, "Năm sự kiện"},
	"event_count":          {KindAggregate, EventCountSubquery, TypeNumber, "Số sự kiện"},
}

type OperatorDef struct {
	// Template with exactly two substitutions: {col} and {param}.
	Template string
	Allowed  []ValueType
	Label    string
}

var operators = map[string]OperatorDef{
	"contains":   {"{col} ILIKE {param}", []ValueType{TypeText}, "chứa"},
	"equals":     {"{col} = {param}", []ValueType{TypeText, TypeNumber}, "bằng"},
	"not_equals": {"{col} <> {param}", []ValueType{TypeText, TypeNumber}, "khác"},
	"gt":         {"{col} > {param}", []ValueType{TypeNumber}, "lớn hơn"},
	"gte":        {"{col} >= {param}", []ValueType{TypeNumber}, "từ"},
	"lt":         {"{col} < {param}", []ValueType{TypeNumber}, "nhỏ hơn"},
	"lte":        {"{col} <= {param}", []ValueType{TypeNumber}, "đến"},
}

// EventCountSubquery counts distinct events for an entity, correlated to c.id.
const EventCountSubquery = `(
	SELECT COUNT(DISTINCT r.event_name)
	FROM raw_to_canonical l JOIN raw_records r ON r.id = l.raw_record_id
	WHERE l.canonical_entity_id = c.id
	  AND r.event_name IS NOT NULL AND r.event_name <> ''
)`

func ColumnIDs() []string {
	ids := make([]string, 0, len(columns))
	for k := range columns {
		ids = append(ids, k)
	}
	sort.Strings(ids)
	return ids
}

func OperatorIDs() []string {
	ids := make([]string, 0, len(operators))
	for k := range operators {
		ids = append(ids, k)
	}
	sort.Strings(ids)
	return ids
}

// Filter is a single model-proposed predicate. Untrusted until Build validates it.
type Filter struct {
	Column   string `json:"column"`
	Operator string `json:"operator"`
	Value    string `json:"value"`
}

// AppliedFilter is a filter that survived validation, for display back to the user.
type AppliedFilter struct {
	Filter
	ColumnLabel   string
	OperatorLabel string
}

type Rejected struct {
	Filter Filter
	Reason string
}

type Predicate struct {
	// SQL boolean expression, empty when nothing valid survived.
	SQL      string
	Args     []any
	Applied  []AppliedFilter
	Rejected []Rejected
}

// Build turns model-proposed filters into a parameterised SQL predicate.
// startIndex is the first $n to use — callers bind organization_id as $1, so
// this is normally 2.
func Build(filters []Filter, logic string, startIndex int) Predicate {
	if logic != "OR" {
		logic = "AND"
	}

	var (
		clauses []string
		p       Predicate
	)
	paramIndex := startIndex

	for _, f := range filters {
		col, ok := columns[f.Column]
		if !ok {
			p.Rejected = append(p.Rejected, Rejected{f, "Cột không nằm trong danh sách cho phép"})
			continue
		}
		op, ok := operators[f.Operator]
		if !ok {
			p.Rejected = append(p.Rejected, Rejected{f, "Toán tử không nằm trong danh sách cho phép"})
			continue
		}
		if !allowsType(op.Allowed, col.Type) {
			p.Rejected = append(p.Rejected, Rejected{f,
				fmt.Sprintf("Toán tử %q không dùng được với cột kiểu %s", f.Operator, col.Type)})
			continue
		}

		value := strings.TrimSpace(f.Value)
		if value == "" {
			p.Rejected = append(p.Rejected, Rejected{f, "Giá trị rỗng"})
			continue
		}

		var bound any
		if col.Type == TypeNumber {
			n, err := strconv.ParseFloat(value, 64)
			if err != nil {
				p.Rejected = append(p.Rejected, Rejected{f, fmt.Sprintf("%q không phải là số", value)})
				continue
			}
			bound = n
		} else if f.Operator == "contains" {
			// Wildcards are added here, server-side, after escaping any the
			// model supplied so it cannot widen the match itself.
			bound = "%" + escapeLike(value) + "%"
		} else {
			bound = value
		}

		placeholder := fmt.Sprintf("$%d", paramIndex)
		paramIndex++
		p.Args = append(p.Args, bound)
		p.Applied = append(p.Applied, AppliedFilter{
			Filter:        Filter{Column: f.Column, Operator: f.Operator, Value: value},
			ColumnLabel:   col.Label,
			OperatorLabel: op.Label,
		})

		comparison := strings.NewReplacer("{col}", col.SQL, "{param}", placeholder).Replace(op.Template)

		// Event-scoped columns live on raw_records (one row per appearance), so
		// they are wrapped in EXISTS against this entity's linked records.
		// Wrapping rather than joining keeps one output row per entity and lets
		// OR-combined predicates stay independent.
		if col.Kind == KindEvent {
			clauses = append(clauses, fmt.Sprintf(`EXISTS (
				SELECT 1 FROM raw_to_canonical l
				JOIN raw_records r ON r.id = l.raw_record_id
				WHERE l.canonical_entity_id = c.id AND %s)`, comparison))
		} else {
			clauses = append(clauses, "("+comparison+")")
		}
	}

	if len(clauses) > 0 {
		p.SQL = strings.Join(clauses, "\n  "+logic+" ")
	}
	return p
}

// KeywordFallback builds the same shape of predicate without a model, for when
// Gemini is unavailable. Same whitelist, same parameterisation.
func KeywordFallback(q string, startIndex int) Predicate {
	return Build([]Filter{
		{"display_name", "contains", q},
		{"primary_organization", "contains", q},
		{"primary_role", "contains", q},
		{"primary_email", "contains", q},
	}, "OR", startIndex)
}

func allowsType(allowed []ValueType, t ValueType) bool {
	for _, a := range allowed {
		if a == t {
			return true
		}
	}
	return false
}

// escapeLike neutralises LIKE metacharacters in a model-supplied value.
func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}
