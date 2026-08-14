// Package normalize holds the text and value normalisation shared by import and
// entity resolution.
//
// Two different "normal forms" live here and they are not interchangeable:
//   - Identity()    keeps diacritics, and is what gets embedded. Vietnamese
//     diacritics carry meaning and the multilingual embedding model uses them.
//   - BlockingKey() strips diacritics and punctuation, for cheap exact-match
//     candidate blocking where "Trần Văn A" must equal "Tran Van A".
package normalize

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

var spaces = regexp.MustCompile(`\s+`)

func Cell(v any) string {
	if v == nil {
		return ""
	}
	return strings.TrimSpace(spaces.ReplaceAllString(fmt.Sprint(v), " "))
}

// StripDiacritics also handles đ/Đ, which NFD does not decompose.
func StripDiacritics(s string) string {
	s = strings.NewReplacer("đ", "d", "Đ", "D").Replace(s)
	t := transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)
	out, _, err := transform.String(t, s)
	if err != nil {
		return s
	}
	return out
}

// Vietnamese academic/professional prefixes are extremely common in this data
// ("PGS.TS. Nguyễn Văn Hoàng") and are noise for matching, so they are stripped
// from blocking keys but left in the display name.
var titlePrefix = regexp.MustCompile(`(?i)^(gs|pgs|ts|ths|th\.s|bs|ks|cn|ncs|prof|dr|mr|mrs|ms|ong|ba)\b[.\s]*`)

func StripTitles(name string) string {
	out := strings.TrimSpace(name)
	for i := 0; i < 4; i++ {
		next := strings.TrimSpace(titlePrefix.ReplaceAllString(out, ""))
		if next == out {
			break
		}
		out = next
	}
	if out == "" {
		return strings.TrimSpace(name)
	}
	return out
}

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

func BlockingKey(s string) string {
	v := strings.ToLower(StripDiacritics(StripTitles(Cell(s))))
	return strings.TrimSpace(nonAlnum.ReplaceAllString(v, " "))
}

var emailRe = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

func Email(s string) string {
	v := strings.ToLower(Cell(s))
	if emailRe.MatchString(v) {
		return v
	}
	return ""
}

var nonPhone = regexp.MustCompile(`[^\d+]`)

// Phone reduces to digits so "0912 345 678" and "+84912345678" compare equal.
func Phone(s string) string {
	v := nonPhone.ReplaceAllString(Cell(s), "")
	if v == "" {
		return ""
	}
	v = strings.TrimPrefix(v, "+")
	if strings.HasPrefix(v, "84") && len(v) > 9 {
		v = "0" + v[2:]
	}
	return v
}

// Identity is the string that gets embedded: name + organization + role, per
// the brief. Email is deliberately excluded — it is handled by exact blocking,
// where a typo comparison is far more reliable than cosine distance.
func Identity(fullName, organization, roleTitle string) string {
	parts := make([]string, 0, 3)
	for _, p := range []string{Cell(fullName), Cell(organization), Cell(roleTitle)} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 {
		return "(không rõ)"
	}
	return strings.Join(parts, " | ")
}

// excelEpoch is Excel's day 0, accounting for its 1900 leap-year bug.
var excelEpoch = time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)

var (
	isoRe    = regexp.MustCompile(`^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$`)
	dmyRe    = regexp.MustCompile(`^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$`)
	serialRe = regexp.MustCompile(`^\d{5}(\.\d+)?$`)
	vnRe     = regexp.MustCompile(`^(\d{1,2})\s*thang\s*(\d{1,2})\s*(?:nam\s*)?(\d{4})$`)
)

// EventDate parses the inconsistent date formats these spreadsheets contain.
// Returns nil when the value is unusable — callers store nil alongside the
// untouched original rather than guessing.
func EventDate(raw string) *time.Time {
	s := Cell(raw)
	if s == "" {
		return nil
	}

	if serialRe.MatchString(s) {
		f, err := strconv.ParseFloat(s, 64)
		if err == nil {
			return excelSerial(f)
		}
	}

	if m := isoRe.FindStringSubmatch(s); m != nil {
		return build(atoi(m[1]), atoi(m[2]), atoi(m[3]))
	}

	// Vietnamese convention is day-first, so 03/06/2025 is 3 June. When the
	// first component is > 12 it is unambiguously the day; when the SECOND is
	// > 12 the file must actually be month-first, so swap.
	if m := dmyRe.FindStringSubmatch(s); m != nil {
		day, month, year := atoi(m[1]), atoi(m[2]), atoi(m[3])
		if year < 100 {
			if year < 70 {
				year += 2000
			} else {
				year += 1900
			}
		}
		if month > 12 && day <= 12 {
			day, month = month, day
		}
		return build(year, month, day)
	}

	if m := vnRe.FindStringSubmatch(strings.ToLower(StripDiacritics(s))); m != nil {
		return build(atoi(m[3]), atoi(m[2]), atoi(m[1]))
	}

	for _, layout := range []string{time.RFC3339, "2006/01/02", "02 Jan 2006", "Jan 2, 2006"} {
		if t, err := time.Parse(layout, s); err == nil {
			u := t.UTC()
			return &u
		}
	}
	return nil
}

func excelSerial(serial float64) *time.Time {
	if serial < 1 || serial > 100000 {
		return nil
	}
	t := excelEpoch.AddDate(0, 0, int(serial))
	return &t
}

func build(year, month, day int) *time.Time {
	if year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31 {
		return nil
	}
	t := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	// Rejects impossible dates like 31/02 that time.Date silently rolls over.
	if int(t.Month()) != month || t.Day() != day {
		return nil
	}
	return &t
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
