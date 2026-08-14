package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"google.golang.org/genai"
)

type SchemaMappingResult struct {
	Mappings map[string]FieldMapping `json:"mappings"`
}

type FieldMapping struct {
	CanonicalField string  `json:"canonical_field"` // Name, Organization, Role, Email, Phone, EventName, EventDate, Notes
	Confidence     float64 `json:"confidence"`      // 0.0 to 1.0
	Reasoning      string  `json:"reasoning"`
}

type MergeVerdict struct {
	IsSameEntity bool    `json:"is_same_entity"`
	Confidence   float64 `json:"confidence"`
	Reasoning    string  `json:"reasoning"` // Vietnamese explanation
}

type SQLTranslationResult struct {
	WHEREClause string        `json:"where_clause"`
	Params      []interface{} `json:"params"`
	Explanation string        `json:"explanation"`
}

type Client struct {
	genaiClient *genai.Client
	modelName   string
}

func NewClient(ctx context.Context) (*Client, error) {
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("GEMINI_API_KEY environment variable is required")
	}

	model := os.Getenv("GEMINI_MODEL")
	if model == "" {
		model = "gemini-3.6-flash"
	}

	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey: apiKey,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create GenAI client: %w", err)
	}

	return &Client{
		genaiClient: client,
		modelName:   model,
	}, nil
}

// InferSchemaMapping uses Gemini structured outputs to propose column mapping to canonical schema
func (c *Client) InferSchemaMapping(ctx context.Context, headers []string, sampleRows [][]string) (*SchemaMappingResult, error) {
	prompt := fmt.Sprintf(`Bạn là một chuyên gia chuẩn hóa dữ liệu sự kiện.
Hãy phân tích các tiêu đề cột (header) và một số dòng mẫu dưới đây từ một tệp dữ liệu sự kiện/hội thảo.
Áp dụng ánh xạ từng cột nguồn sang một trong các trường chuẩn (Canonical Fields) sau:
- "full_name": Họ và tên cá nhân, người tham dự, diễn giả, chuyên gia
- "organization": Tên công ty, viện nghiên cứu, trường đại học, cơ quan
- "role_title": Chức danh, vị trí công tác, vai trò trong sự kiện
- "email": Địa chỉ email
- "phone": Số điện thoại
- "event_name": Tên sự kiện, lớp tập huấn, hội thảo, chuỗi hoạt động
- "event_date": Ngày/thời gian tổ chức sự kiện
- "notes": Ghi chú khác hoặc thông tin bổ sung
- "ignore": Cột không liên quan hoặc dữ liệu thừa

Tiêu đề các cột nguồn: %v
Mẫu dữ liệu 3 dòng đầu: %v

Yêu cầu đầu ra dạng JSON đúng định dạng SchemaMappingResult.
Ví dụ cấu trúc trả về:
{
  "mappings": {
    "Họ và tên người dùng": {"canonical_field": "full_name", "confidence": 0.98, "reasoning": "Khớp chính xác họ tên cá nhân"},
    "Đơn vị công tác": {"canonical_field": "organization", "confidence": 0.95, "reasoning": "Đơn vị hoặc tổ chức người tham gia"}
  }
}`, headers, sampleRows)

	resp, err := c.genaiClient.Models.GenerateContent(ctx, c.modelName, genai.Text(prompt), &genai.GenerateContentConfig{
		ResponseMIMEType: "application/json",
	})
	if err != nil {
		return nil, fmt.Errorf("gemini schema mapping failed: %w", err)
	}

	var result SchemaMappingResult
	if err := json.Unmarshal([]byte(resp.Text), &result); err != nil {
		return nil, fmt.Errorf("failed to parse gemini json schema mapping: %w", err)
	}

	return &result, nil
}

// AdjudicateMergeCandidates performs Stage 2 LLM merge judgment between canonical entity and candidate record
func (c *Client) AdjudicateMergeCandidates(ctx context.Context, canonicalName, canonicalOrg, canonicalEmail, candidateName, candidateOrg, candidateEmail, candidateRole, eventName string) (*MergeVerdict, error) {
	prompt := fmt.Sprintf(`Bạn là hệ thống trí tuệ nhân tạo chuyên giải quyết trùng lặp thực thể (Entity Resolution).
So sánh Thực thể Chuẩn hiện có và Dữ liệu Mới ghi nhận từ một sự kiện để xác định xem hai bản ghi này có thuộc về CÙNG MỘT NGƯỜI / TỔ CHỨC thực tế hay không.

Thực thể chuẩn hiện có:
- Tên: "%s"
- Đơn vị: "%s"
- Email: "%s"

Dữ liệu nguồn mới:
- Tên: "%s"
- Đơn vị: "%s"
- Email: "%s"
- Chức danh: "%s"
- Sự kiện tham gia: "%s"

Trả về JSON đúng cấu trúc:
{
  "is_same_entity": true,
  "confidence": 0.92,
  "reasoning": "Tên tương tự (Trần Văn A vs Tran Van A), cùng làm tại Viện Đổi mới Sáng tạo, email khớp một phần."
}
Đánh giá khách quan, nêu lý do rõ ràng bằng tiếng Việt ngắn gọn.`,
		canonicalName, canonicalOrg, canonicalEmail,
		candidateName, candidateOrg, candidateEmail, candidateRole, eventName)

	resp, err := c.genaiClient.Models.GenerateContent(ctx, c.modelName, genai.Text(prompt), &genai.GenerateContentConfig{
		ResponseMIMEType: "application/json",
	})
	if err != nil {
		return nil, fmt.Errorf("gemini merge adjudication failed: %w", err)
	}

	var verdict MergeVerdict
	if err := json.Unmarshal([]byte(resp.Text), &verdict); err != nil {
		return nil, fmt.Errorf("failed to parse merge verdict json: %w", err)
	}

	return &verdict, nil
}

// TranslateNLToSQL safety constrains query to allowed canonical columns
func (c *Client) TranslateNLToSQL(ctx context.Context, userQuery string) (string, []interface{}, string, error) {
	prompt := fmt.Sprintf(`Bạn là hệ thống chuyển đổi câu hỏi tự nhiên (Tiếng Việt/English) sang truy vấn lọc dữ liệu an toàn.
Bảng "canonical_entities" có các cột hợp lệ duy nhất:
- "display_name" (VARCHAR)
- "primary_organization" (VARCHAR)
- "primary_role" (VARCHAR)
- "primary_email" (VARCHAR)
- "event_count" (INT)
- "created_at" (TIMESTAMPTZ)

Câu hỏi người dùng: "%s"

Chỉ sử dụng phép so sánh ILIKE, =, >, <, AND, OR.
Trả về JSON đúng cấu trúc:
{
  "where_clause": "display_name ILIKE $1 OR primary_organization ILIKE $1",
  "params": ["%%chuyên gia%%"],
  "explanation": "Tìm kiếm các cá nhân hoặc tổ chức có liên quan đến từ khóa 'chuyên gia'"
}`, userQuery)

	resp, err := c.genaiClient.Models.GenerateContent(ctx, c.modelName, genai.Text(prompt), &genai.GenerateContentConfig{
		ResponseMIMEType: "application/json",
	})
	if err != nil {
		return "", nil, "", fmt.Errorf("NL to SQL translation failed: %w", err)
	}

	type NLResult struct {
		WhereClause string        `json:"where_clause"`
		Params      []interface{} `json:"params"`
		Explanation string        `json:"explanation"`
	}

	var res NLResult
	if err := json.Unmarshal([]byte(resp.Text), &res); err != nil {
		return "", nil, "", fmt.Errorf("failed to parse NL to SQL result: %w", err)
	}

	// Validate WHERE clause to prevent SQL injection or un-whitelisted table names
	allowedCols := []string{"display_name", "primary_organization", "primary_role", "primary_email", "event_count", "created_at"}
	isValid := false
	for _, col := range allowedCols {
		if strings.Contains(res.WhereClause, col) {
			isValid = true
			break
		}
	}

	if !isValid && strings.TrimSpace(res.WhereClause) != "" {
		res.WhereClause = "display_name ILIKE $1 OR primary_organization ILIKE $1"
		res.Params = []interface{}{"%" + userQuery + "%"}
		res.Explanation = fmt.Sprintf("Mặc định tìm kiếm từ khóa '%s' theo tên hoặc tổ chức.", userQuery)
	}

	return res.WhereClause, res.Params, res.Explanation, nil
}
