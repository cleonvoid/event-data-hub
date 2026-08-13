# Event Data Hub (Trung tâm Dữ liệu Sự kiện)

Hệ thống chuẩn hóa dữ liệu sự kiện và hợp nhất thực thể (Entity Resolution) đa nguồn, phát triển bằng ngôn ngữ **Go (Golang)**, **HTMX**, **PostgreSQL (pgvector)** và hệ sinh thái **Google Cloud (Gemini AI, Vertex AI Embeddings, Google Drive/Sheets API, Firebase Auth, Cloud Run)**.

---

## 🌟 Đặt vấn đề & Giải pháp

Một tổ chức tổ chức hàng trăm hội thảo, khóa tập huấn, sự kiện kết nối đầu tư mỗi năm. Mỗi tệp dữ liệu danh sách tham dự thu thập về có **cấu trúc cột khác nhau**, định dạng ngày tháng không đồng nhất, tên cá nhân hoặc công ty xuất hiện nhiều lần ở các sự kiện khác nhau dưới dạng biến thể (ví dụ: *PGS.TS. Nguyễn Văn Hoàng*, *N. V. Hoàng*, *Hoang Nguyen VinAI*).

**Event Data Hub** giải quyết vấn đề này qua quy trình 5 bước tự động hóa:
1. **Kết nối Nguồn**: Đọc tệp `.xlsx`/`.csv` tải lên hoặc duyệt trực tiếp từ **Google Drive / Google Sheets API**.
2. **AI Schema Mapping**: Sử dụng **Gemini AI (Structured Output Mode)** phân tích dòng tiêu đề và đề xuất ánh xạ sang **Schema Chuẩn** (Họ tên, Đơn vị, Chức danh, Email, SĐT, Sự kiện, Ngày, Ghi chú) cùng độ tin cậy và lý do.
3. **Lưu trữ Thô & Vectorization**: Lưu toàn bộ bản ghi thô không ghi đè, tự động tạo **Text Embedding** (Vertex AI / Gemini Embedding) lưu vào cột `vector` trong PostgreSQL.
4. **Hợp nhất Thực thể 2 Giai đoạn (Two-Stage Entity Resolution)**:
   - **Giai đoạn 1 — Candidate Retrieval**: Sử dụng `pgvector` Cosine Similarity tìm nhanh N ứng viên tương đồng nhất trong DB (tránh O(N²)).
   - **Giai đoạn 2 — LLM Adjudication**: Gửi các cặp ứng viên cho Gemini AI đánh giá chuyên sâu và trả về kết quả JSON với lý do bằng tiếng Việt.
5. **Duyệt Hợp nhất & Truy vấn Tự nhiên (NL-to-SQL)**: Giao diện phê duyệt trực quan side-by-side, tích hợp tìm kiếm tiếng Việt bằng AI Gemini sang truy vấn SQL an toàn.

---

## 🏗️ Cấu trúc Thư mục Dự án

```
.
├── main.go                     # Entrypoint server Go standard library net/http
├── internal/
│   ├── ai/                     # Gemini AI (google.golang.org/genai) & Vertex AI Embeddings
│   ├── auth/                   # Middleware xác thực Firebase ID Token
│   ├── db/                     # Quản lý kết nối pgx/v5 & truy vấn SQL thô với pgvector
│   ├── handlers/               # HTTP Handlers (Sources, Mapping, Entities, Merges, Stats)
│   └── sources/                # Google Drive/Sheets API client & excelize parser
├── templates/                  # Giao diện HTMX & HTML partials
├── migrations/                 # File SQL migration (pgvector extension, tables, vector index)
├── server.ts                   # Express + Vite Node preview server cho AI Studio
├── Dockerfile                  # Cloud Run multi-stage build container
├── docker-compose.yml          # Môi trường PostgreSQL + pgvector local dev
├── metadata.json               # Cấu hình applet AI Studio
└── README.md                   # Hướng dẫn chi tiết
```

---

## 🔑 Biến Môi trường (Environment Variables)

| Biến Môi trường | Mô tả | Mặc định |
|---|---|---|
| `PORT` | Cổng HTTP lắng nghe | `3000` |
| `DATABASE_URL` | Chuỗi kết nối PostgreSQL / Cloud SQL | `postgres://postgres:postgrespassword@localhost:5432/event_data_hub?sslmode=disable` |
| `GEMINI_API_KEY` | Khóa API Gemini | *(Bắt buộc)* |
| `GEMINI_MODEL` | Model Gemini mặc định | `gemini-3.6-flash` |
| `GCP_PROJECT_ID` | Google Cloud Project ID | `your-gcp-project-id` |

---

## 🚀 Hướng dẫn Khởi chạy Local (Docker Compose)

### 1. Khởi động PostgreSQL có sẵn `pgvector`:
```bash
docker-compose up -d postgres
```

### 2. Chạy ứng dụng Go:
```bash
export GEMINI_API_KEY="your_api_key_here"
export DATABASE_URL="postgres://postgres:postgrespassword@localhost:5432/event_data_hub?sslmode=disable"
go run main.go
```

Truy cập: `http://localhost:3000`

---

## ☁️ Hướng dẫn Deploy lên Cloud Run & Cloud SQL

### Step 1: Bật các Google Cloud APIs cần thiết:
```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  aiplatform.googleapis.com \
  generativelanguage.googleapis.com \
  drive.googleapis.com \
  sheets.googleapis.com
```

### Step 2: Tạo Cloud SQL Postgres Instance & Kích hoạt `pgvector`:
```bash
gcloud sql instances create event-hub-db --database-version=POSTGRES_16 --tier=db-custom-2-7680 --region=asia-southeast1
gcloud sql databases create event_data_hub --instance=event-hub-db
```

### Step 3: Build & Deploy Container lên Cloud Run:
```bash
gcloud builds submit --tag gcr.io/$GCP_PROJECT_ID/event-data-hub
gcloud run deploy event-data-hub \
  --image gcr.io/$GCP_PROJECT_ID/event-data-hub \
  --platform managed \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --add-cloudsql-instances $GCP_PROJECT_ID:asia-southeast1:event-hub-db \
  --set-env-vars GEMINI_API_KEY=$GEMINI_API_KEY,DATABASE_URL="postgres://user:password@/event_data_hub?host=/cloudsql/$GCP_PROJECT_ID:asia-southeast1:event-hub-db"
```

---

## 🛡️ Tính An toàn & Bảo mật

- **Nguyên tắc dữ liệu thô**: Không bao giờ xóa hoặc ghi đè dữ liệu thô. Mọi bản ghi hợp nhất thực thể là derived view.
- **An toàn NL-to-SQL**: Mọi câu hỏi tự nhiên được Gemini chuyển sang truy vấn chỉ được sử dụng các cột đã định nghĩa trong whitelist (`displayName`, `primaryOrganization`, `primaryEmail`, v.v.) và được ràng buộc bằng Parameterized Query (`$1`, `$2`), tuyệt đối không thực thi chuỗi SQL tự do từ LLM.
- **Duyệt hợp nhất minh bạch**: Toàn bộ quyết định gộp thực thể bắt buộc qua sự xác nhận của người dùng (Human-in-the-loop).
