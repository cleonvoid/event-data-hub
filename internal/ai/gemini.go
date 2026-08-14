package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"google.golang.org/genai"

	"event-data-hub/internal/search"
)

// CanonicalFields is the target schema the importer maps every source column onto.
var CanonicalFields = []string{
	"full_name", "organization", "role_title", "email",
	"phone", "event_name", "event_date", "notes", "ignore",
}

func IsCanonicalField(s string) bool {
	for _, f := range CanonicalFields {
		if f == s {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// 1. Schema inference
// ---------------------------------------------------------------------------

type FieldMapping struct {
	CanonicalField string  `json:"canonical_field"`
	Confidence     float64 `json:"confidence"`
	Reasoning      string  `json:"reasoning"`
}

func (f FieldMapping) ConfidencePercent() int { return int(f.Confidence*100 + 0.5) }

// The response is an ARRAY, not an object keyed by column name: Gemini's
// response schema follows the OpenAPI subset, which cannot express "object with
// arbitrary string keys". Declaring a bare OBJECT with no properties (as the
// original did) constrains nothing at all; an array of records with an
// enum-constrained canonical_field is genuinely enforced.
func schemaMappingResponseSchema() *genai.Schema {
	return &genai.Schema{
		Type: genai.TypeObject,
		Properties: map[string]*genai.Schema{
			"mappings": {
				Type: genai.TypeArray,
				Items: &genai.Schema{
					Type: genai.TypeObject,
					Properties: map[string]*genai.Schema{
						"source_column":   {Type: genai.TypeString, Description: "Tên cột nguồn, sao chép chính xác"},
						"canonical_field": {Type: genai.TypeString, Enum: CanonicalFields},
						"confidence":      {Type: genai.TypeNumber, Description: "0.0 đến 1.0"},
						"reasoning":       {Type: genai.TypeString, Description: "Lý do ngắn gọn bằng tiếng Việt"},
					},
					Required: []string{"source_column", "canonical_field", "confidence", "reasoning"},
				},
			},
		},
		Required: []string{"mappings"},
	}
}

func (c *Client) InferSchemaMapping(ctx context.Context, headers []string, sampleRows [][]string) (map[string]FieldMapping, error) {
	headersJSON, _ := json.Marshal(headers)
	limit := len(sampleRows)
	if limit > 5 {
		limit = 5
	}
	samplesJSON, _ := json.Marshal(sampleRows[:limit])

	prompt := fmt.Sprintf(`Bạn là chuyên gia chuẩn hóa dữ liệu sự kiện của một trung tâm đổi mới sáng tạo Việt Nam.

Nhiệm vụ: ánh xạ MỖI cột nguồn dưới đây sang đúng MỘT trường chuẩn.

Các trường chuẩn cho phép:
- "full_name": họ và tên cá nhân (người tham dự, diễn giả, chuyên gia)
- "organization": tên công ty, viện, trường, cơ quan, đơn vị công tác
- "role_title": chức danh, vị trí công tác, vai trò trong sự kiện
- "email": địa chỉ thư điện tử
- "phone": số điện thoại
- "event_name": tên sự kiện, hội thảo, lớp tập huấn
- "event_date": ngày/thời gian tổ chức
- "notes": ghi chú, thông tin bổ sung không thuộc các nhóm trên
- "ignore": cột vô nghĩa (số thứ tự, cột trống, cột kỹ thuật)

Quy tắc quan trọng:
1. Dùng CẢ tên cột VÀ dữ liệu mẫu để quyết định. Tên cột tiếng Việt thường viết tắt hoặc không dấu.
2. Cột số thứ tự ("STT", "No.", "#") luôn là "ignore".
3. confidence phản ánh mức chắc chắn thật: đặt thấp (< 0.6) khi bạn phải đoán.
4. Trả về đúng %d phần tử, mỗi cột nguồn một phần tử, theo thứ tự đã cho.

Tên các cột nguồn: %s
Dữ liệu mẫu (mỗi mảng là một dòng, cùng thứ tự cột): %s`,
		len(headers), headersJSON, samplesJSON)

	var parsed struct {
		Mappings []struct {
			SourceColumn   string  `json:"source_column"`
			CanonicalField string  `json:"canonical_field"`
			Confidence     float64 `json:"confidence"`
			Reasoning      string  `json:"reasoning"`
		} `json:"mappings"`
	}
	if err := c.generateJSON(ctx, "InferSchemaMapping", prompt, schemaMappingResponseSchema(), &parsed); err != nil {
		return nil, err
	}

	byColumn := make(map[string]FieldMapping, len(parsed.Mappings))
	for _, m := range parsed.Mappings {
		if m.SourceColumn == "" {
			continue
		}
		field := m.CanonicalField
		if !IsCanonicalField(field) {
			field = "notes"
		}
		reasoning := m.Reasoning
		if strings.TrimSpace(reasoning) == "" {
			reasoning = "Không có giải thích"
		}
		byColumn[m.SourceColumn] = FieldMapping{
			CanonicalField: field,
			Confidence:     clamp01(m.Confidence),
			Reasoning:      reasoning,
		}
	}

	// Anchor to the real header list: the model can skip or rename a column, and
	// the confirmation UI must show every column exactly once.
	result := make(map[string]FieldMapping, len(headers))
	for _, h := range headers {
		if m, ok := byColumn[h]; ok {
			result[h] = m
			continue
		}
		if m, ok := findLoosely(byColumn, h); ok {
			result[h] = m
			continue
		}
		result[h] = FieldMapping{
			CanonicalField: "ignore",
			Confidence:     0,
			Reasoning:      "Mô hình không đề xuất được ánh xạ — vui lòng chọn thủ công.",
		}
	}
	return result, nil
}

func findLoosely(m map[string]FieldMapping, header string) (FieldMapping, bool) {
	norm := func(s string) string { return strings.Join(strings.Fields(strings.ToLower(s)), " ") }
	target := norm(header)
	for k, v := range m {
		if norm(k) == target {
			return v, true
		}
	}
	return FieldMapping{}, false
}

// ---------------------------------------------------------------------------
// 2. Merge adjudication (Stage 2)
// ---------------------------------------------------------------------------

type MergeVerdict struct {
	IsSameEntity bool    `json:"is_same_entity"`
	Confidence   float64 `json:"confidence"`
	Reasoning    string  `json:"reasoning"`
}

// MergeRecord is the new raw record being resolved.
type MergeRecord struct {
	Type, Name, Org, Role, Email, Phone, Event string
}

// MergeEntity is one Stage 1 candidate.
type MergeEntity struct {
	ID, Type, Name, Org, Role, Email, Phone string
	VectorSimilarity                        float64
}

// Verdicts come back as an array, one per candidate, from a SINGLE call.
//
// The earlier design made one request per (entity, record) pair, so a 4-row
// file with 5 retrieved candidates each cost ~20 requests — enough to exhaust
// the Gemini free tier's daily quota on a single spreadsheet. Adjudicating a
// record's whole shortlist in one request cuts that by the candidate count and
// gives the model better context: it sees the alternatives and picks between
// them instead of judging each in isolation.
func mergeVerdictSchema() *genai.Schema {
	return &genai.Schema{
		Type: genai.TypeObject,
		Properties: map[string]*genai.Schema{
			"verdicts": {
				Type: genai.TypeArray,
				Items: &genai.Schema{
					Type: genai.TypeObject,
					Properties: map[string]*genai.Schema{
						"candidate_index": {Type: genai.TypeInteger, Description: "Số thứ tự ứng viên đã cho"},
						"is_same_entity":  {Type: genai.TypeBoolean},
						"confidence":      {Type: genai.TypeNumber, Description: "0.0 đến 1.0"},
						"reasoning":       {Type: genai.TypeString, Description: "Một câu tiếng Việt nêu bằng chứng cụ thể"},
					},
					Required: []string{"candidate_index", "is_same_entity", "confidence", "reasoning"},
				},
			},
		},
		Required: []string{"verdicts"},
	}
}

// AdjudicateMergeBatch judges a record against its whole shortlist in one
// request and returns verdicts keyed by candidate entity id.
func (c *Client) AdjudicateMergeBatch(ctx context.Context, record MergeRecord, candidates []MergeEntity) (map[string]MergeVerdict, error) {
	if len(candidates) == 0 {
		return map[string]MergeVerdict{}, nil
	}

	var block strings.Builder
	for i, cand := range candidates {
		if i > 0 {
			block.WriteString("\n\n")
		}
		fmt.Fprintf(&block, `[%d]
- Loại: %q
- Tên: %q
- Đơn vị: %q
- Chức danh: %q
- Email: %q
- Điện thoại: %q
- Độ tương đồng vector giai đoạn 1: %.3f`,
			i, cand.Type, cand.Name, cand.Org, cand.Role, cand.Email, cand.Phone, cand.VectorSimilarity)
	}

	prompt := fmt.Sprintf(`Bạn là hệ thống phân giải trùng lặp thực thể (entity resolution) cho dữ liệu sự kiện Việt Nam.

Cho MỘT bản ghi nguồn mới và %d thực thể chuẩn ứng viên, hãy xác định với TỪNG ứng viên
xem có phải CÙNG MỘT CÁ NHÂN HOẶC TỔ CHỨC ngoài đời thực với bản ghi nguồn hay không.

BẢN GHI NGUỒN MỚI:
- Loại: %q
- Tên: %q
- Đơn vị: %q
- Chức danh: %q
- Email: %q
- Điện thoại: %q
- Sự kiện: %q

CÁC THỰC THỂ CHUẨN ỨNG VIÊN:
%s

Hướng dẫn đánh giá (theo đặc thù dữ liệu Việt Nam):
- Email trùng khớp hoàn toàn là bằng chứng RẤT MẠNH cho cùng một người.
- Số điện thoại trùng (bỏ qua khoảng trắng, +84 tương đương 0) là bằng chứng RẤT MẠNH.
- Biến thể tên hợp lệ: có/không dấu ("Trần Văn A" và "Tran Van A"), viết tắt
  ("Nguyễn Văn Hoàng" và "N. V. Hoàng"), có/không học hàm học vị ("PGS.TS.").
- Tên đơn vị viết tắt hoặc song ngữ ("Tập đoàn FPT" và "FPT Corp") là bằng chứng vừa phải.
- CẢNH BÁO: tên phổ biến ở Việt Nam (Nguyễn Văn A, Trần Thị B) trùng nhau mà
  KHÔNG có email/điện thoại/đơn vị trùng thì KHÔNG đủ kết luận. Hãy trả về false.
- Cùng họ tên nhưng khác đơn vị VÀ khác email thì nhiều khả năng là hai người khác nhau.
- Tối đa MỘT ứng viên được phép là true. Nếu nhiều ứng viên cùng giống, chọn ứng viên
  có bằng chứng mạnh nhất và đặt false cho các ứng viên còn lại.

Trả về đúng %d phần tử, mỗi ứng viên một phần tử, candidate_index khớp số trong ngoặc vuông.
confidence là mức chắc chắn của bạn về kết luận (dù kết luận là true hay false).
reasoning phải nêu bằng chứng cụ thể đã dùng, viết bằng tiếng Việt, tối đa 2 câu.`,
		len(candidates),
		record.Type, record.Name, record.Org, record.Role, record.Email, record.Phone, record.Event,
		block.String(), len(candidates))

	var parsed struct {
		Verdicts []struct {
			CandidateIndex int     `json:"candidate_index"`
			IsSameEntity   bool    `json:"is_same_entity"`
			Confidence     float64 `json:"confidence"`
			Reasoning      string  `json:"reasoning"`
		} `json:"verdicts"`
	}
	if err := c.generateJSON(ctx, "AdjudicateMergeBatch", prompt, mergeVerdictSchema(), &parsed); err != nil {
		return nil, err
	}

	out := make(map[string]MergeVerdict, len(parsed.Verdicts))
	for _, v := range parsed.Verdicts {
		// A hallucinated or out-of-range index is dropped rather than mapped
		// onto the wrong entity — a mis-keyed verdict would propose a nonsense
		// merge.
		if v.CandidateIndex < 0 || v.CandidateIndex >= len(candidates) {
			continue
		}
		reasoning := v.Reasoning
		if strings.TrimSpace(reasoning) == "" {
			reasoning = "Mô hình không nêu lý do."
		}
		out[candidates[v.CandidateIndex].ID] = MergeVerdict{
			IsSameEntity: v.IsSameEntity,
			Confidence:   clamp01(v.Confidence),
			Reasoning:    reasoning,
		}
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// 3. Natural language -> structured filters (NOT raw SQL)
// ---------------------------------------------------------------------------

// SAFETY MODEL — read before changing.
//
// The model never authors SQL. It returns {column, operator, value} triples
// where column and operator are constrained to enums in the response schema
// itself, so it cannot emit an unlisted identifier. internal/search then
// re-validates each triple against the whitelist, maps the column id to a FIXED
// SQL fragment defined in Go source, and binds every value as a $n parameter.
// No model-authored string ever reaches the query text.

type NlSearchPlan struct {
	Filters     []search.Filter `json:"filters"`
	Logic       string          `json:"logic"`
	Explanation string          `json:"explanation"`
}

func nlSearchSchema() *genai.Schema {
	return &genai.Schema{
		Type: genai.TypeObject,
		Properties: map[string]*genai.Schema{
			"filters": {
				Type: genai.TypeArray,
				Items: &genai.Schema{
					Type: genai.TypeObject,
					Properties: map[string]*genai.Schema{
						"column":   {Type: genai.TypeString, Enum: search.ColumnIDs()},
						"operator": {Type: genai.TypeString, Enum: search.OperatorIDs()},
						"value":    {Type: genai.TypeString, Description: "Giá trị so sánh, luôn ở dạng chuỗi"},
					},
					Required: []string{"column", "operator", "value"},
				},
			},
			"logic":       {Type: genai.TypeString, Enum: []string{"AND", "OR"}},
			"explanation": {Type: genai.TypeString, Description: "Một câu tiếng Việt giải thích cách lọc"},
		},
		Required: []string{"filters", "logic", "explanation"},
	}
}

func (c *Client) TranslateNlSearch(ctx context.Context, userQuery string) (NlSearchPlan, error) {
	prompt := fmt.Sprintf(`Bạn là bộ dịch câu hỏi tự nhiên (tiếng Việt hoặc tiếng Anh) sang bộ lọc dữ liệu có cấu trúc.

Người dùng đang tìm kiếm trong danh bạ thực thể chuẩn (cá nhân/tổ chức) tổng hợp từ các sự kiện.

Các cột được phép lọc:
- "display_name": tên hiển thị của người/tổ chức
- "primary_organization": đơn vị công tác chính
- "primary_role": chức danh chính
- "primary_email": địa chỉ email
- "event_name": tên sự kiện mà thực thể đã tham gia
- "event_year": năm diễn ra sự kiện đã tham gia (số, ví dụ 2025)
- "event_count": số lượng sự kiện khác nhau đã tham gia (số)

Các toán tử được phép:
- "contains": chứa chuỗi con, không phân biệt hoa thường (chỉ dùng cho cột văn bản)
- "equals" / "not_equals": bằng / khác chính xác
- "gt" / "gte" / "lt" / "lte": lớn hơn / lớn hơn bằng / nhỏ hơn / nhỏ hơn bằng (chỉ cho cột số)

Quy tắc:
1. Với cột văn bản hầu như luôn dùng "contains".
2. Chỉ dùng gt/gte/lt/lte với "event_year" và "event_count".
3. "chuyên gia AI" nên tách thành nhiều bộ lọc contains trên primary_role.
4. "năm 2025" thành event_year equals "2025".
5. Nếu câu hỏi mơ hồ hoặc chỉ là một từ khóa, tạo các bộ lọc "contains" trên
   display_name và primary_organization với logic "OR".
6. logic áp dụng cho TẤT CẢ bộ lọc. Dùng "AND" khi các điều kiện phải cùng đúng.
7. Không bao giờ để mảng filters rỗng.

Câu hỏi người dùng: %q`, userQuery)

	var plan NlSearchPlan
	if err := c.generateJSON(ctx, "TranslateNlSearch", prompt, nlSearchSchema(), &plan); err != nil {
		return NlSearchPlan{}, err
	}
	if plan.Logic != "OR" {
		plan.Logic = "AND"
	}
	if strings.TrimSpace(plan.Explanation) == "" {
		plan.Explanation = fmt.Sprintf("Tìm kiếm cho: %q", userQuery)
	}
	return plan, nil
}
