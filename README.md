# Event Data Hub — Trung tâm Chuẩn hóa & Hợp nhất Dữ liệu Sự kiện

Chuẩn hóa dữ liệu sự kiện và hợp nhất thực thể (entity resolution) từ hàng trăm bảng tính rời rạc, mỗi tệp một cấu trúc cột khác nhau.

Kho mã chứa **hai bản triển khai chạy trên cùng một cơ sở dữ liệu và cùng bộ migration**:

| | Bản Node/React | Bản Go/HTMX |
|---|---|---|
| Điểm vào | `server.ts` + `src/` | `main.go` + `internal/` + `templates/` |
| Chạy | `npm run dev` → cổng 3000 | `go run .` → cổng 8080 |
| Giao diện | React SPA (Vite) | HTML render phía máy chủ + HTMX |
| Triển khai | Google AI Studio / Cloud Run | Cloud Run qua `Dockerfile` |

> Bản Node là bản mà Google AI Studio dựng và host. Bản Go bám sát yêu cầu "Go standard library + HTMX" trong đề bài. Cả hai dùng chung `migrations/`, nên có thể trỏ vào cùng một database và chuyển qua lại.

---

## 1. Chạy nhanh (local)

> **Nâng cấp từ Postgres 16 lên 18.** `docker-compose.yml` nay dùng ảnh `pg18-trixie` và volume `pgdata18`. Cluster do pg16 tạo ra **không** đọc được bằng 18, nên dữ liệu cũ vẫn nằm nguyên trong volume cũ và cluster 18 khởi tạo rỗng — không mất gì, nhưng cũng không tự chuyển sang.
>
> **Nếu container pg16 vẫn đang chạy** (chưa `docker compose up` với file mới), dump trực tiếp — cách gọn nhất:
>
> ```bash
> docker exec event_data_hub_db pg_dump -U postgres event_data_hub > edh-pg16.sql
> ```
>
> **Nếu đã chuyển sang pg18 rồi**, phải dựng tạm một container pg16 trỏ vào volume cũ. Không được để hai postmaster cùng mở một thư mục dữ liệu, nên **dừng container hiện tại trước**. Tên volume có tiền tố là tên thư mục dự án (mặc định `event-data-hub_pgdata`) — kiểm tra bằng `docker volume ls`:
>
> ```bash
> docker compose down                       # dừng cluster 18 đang chạy
> docker volume ls | grep pgdata            # xác nhận tên volume cũ
>
> docker run -d --name edh_pg16_dump \
>   -v event-data-hub_pgdata:/var/lib/postgresql/data \
>   -e POSTGRES_PASSWORD=postgrespassword \
>   pgvector/pgvector:pg16
> until docker exec edh_pg16_dump pg_isready -U postgres; do sleep 1; done
> docker exec edh_pg16_dump pg_dump -U postgres event_data_hub > edh-pg16.sql
> docker rm -f edh_pg16_dump
> ```
>
> Rồi nạp lại vào cluster 18:
>
> ```bash
> docker compose up -d postgres
> docker exec -i event_data_hub_db psql -U postgres -d event_data_hub < edh-pg16.sql
> ```
>
> Muốn ở lại pg16 thì đổi `image:` về `pgvector/pgvector:pg16`, bỏ dòng `PGDATA` và trả volume về `pgdata`.

```bash
# 1. Khởi động Postgres kèm pgvector (cổng host 5433 để tránh đụng Postgres sẵn có)
docker compose up -d postgres

# 2. Cấu hình môi trường
cp .env.example .env
#    → mở .env và điền GEMINI_API_KEY (lấy tại https://aistudio.google.com/apikey)

# 3a. Chạy bản Node/React
npm install
npm run dev            # http://localhost:3000

# 3b. hoặc chạy bản Go/HTMX
go run .               # http://localhost:8080
```

Cả hai bản **tự áp dụng migration khi khởi động**. Không cần chạy migrate thủ công.

Muốn có sẵn dữ liệu để xem tính năng hợp nhất:

```bash
npm run seed
```

Lệnh này nhập hai bảng tính cố ý "bẩn" (tiếng Việt có dấu / không dấu, tên viết tắt, tên đơn vị song ngữ, hai định dạng ngày) qua **đúng đường đi thật** — embedding thật, truy hồi vector thật, Gemini đối chiếu thật — rồi để lại vài gợi ý hợp nhất chờ bạn duyệt.

---

## 2. Biến môi trường

| Biến | Bắt buộc | Mặc định | Mô tả |
|---|---|---|---|
| `PORT` | | `3000` (Node) / `8080` (Go) | Cloud Run tự đưa vào |
| `DATABASE_URL` | ✓ | `postgres://postgres:postgrespassword@localhost:5433/event_data_hub` | Chuỗi kết nối Postgres |
| `GEMINI_API_KEY` | ✓ | — | Dùng cho ánh xạ schema, đối chiếu hợp nhất, NL search, và embedding khi không dùng Vertex |
| `GEMINI_MODEL` | | `gemini-3.6-flash` | Được kiểm tra một lần lúc khởi động; nếu 404 log sẽ báo rõ |
| `EMBEDDING_MODEL` | | `gemini-embedding-001` | |
| `EMBEDDING_DIM` | | `768` | **Phải khớp** `VECTOR(n)` trong migration |
| `USE_VERTEX_EMBEDDINGS` | | `false` | `true` → dùng Vertex AI qua ADC (không cần API key) |
| `GOOGLE_CLOUD_PROJECT` | khi dùng Vertex | — | |
| `GOOGLE_CLOUD_LOCATION` | | `us-central1` | |
| `AUTH_MODE` | | `dev` | `dev` bỏ qua đăng nhập; **bị từ chối khi `NODE_ENV=production`** |
| `DEV_ORG_ID` | | `org_local_dev` | Tổ chức dùng ở chế độ dev |
| `FIREBASE_PROJECT_ID` | khi `AUTH_MODE=firebase` | — | |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | khi `AUTH_MODE=firebase` | — | Khoá tài khoản dịch vụ Firebase để tạo/thu hồi session cookie. Bỏ trống thì ADC phải có `roles/firebaseauth.admin`, nếu không sẽ không đăng nhập được |
| `VITE_FIREBASE_*` | khi bật đăng nhập | — | Cấu hình Firebase phía trình duyệt |
| `RESOLUTION_TOP_N` | | `5` | Số ứng viên Stage 1 lấy về mỗi bản ghi |
| `RESOLUTION_MIN_SIMILARITY` | | `0.89` | Ngưỡng cosine trước khi tốn một lượt gọi Gemini |
| `RESOLUTION_MIN_COMBINED` | | `0.5` | Ngưỡng điểm tổng hợp trước khi hiện gợi ý |

---

## 3. Kiến trúc hợp nhất thực thể hai giai đoạn

Đây là phần lõi kỹ thuật.

**Giai đoạn 1 — truy hồi bằng vector.** Mỗi bản ghi thô được chuẩn hóa thành chuỗi `họ tên | đơn vị | chức danh`, embedding bằng `gemini-embedding-001` (768 chiều, đã chuẩn hóa về độ dài 1), rồi tìm top-N thực thể gần nhất bằng `pgvector` với chỉ mục **HNSW** và toán tử cosine `<=>`. Nhờ vậy hệ thống **không cần so sánh O(n²)** từng cặp.

> Dùng HNSW thay vì IVFFlat: IVFFlat cần dữ liệu để huấn luyện danh sách, nên chỉ mục tạo lúc migration trên bảng rỗng sẽ suy biến thành quét toàn bảng. HNSW dựng tăng dần và đúng ngay từ bản ghi đầu tiên.

Bổ sung một bước **blocking tất định** theo email/số điện thoại trùng khớp chính xác. Lý do: vector chỉ "nhìn thấy" tên + đơn vị + chức danh, nên một người đổi cả nơi làm việc lẫn chức danh sẽ bị bỏ sót dù dữ liệu có sẵn định danh không thể nhầm.

**Giai đoạn 2 — Gemini phán quyết.** Chỉ những ứng viên trong danh sách rút gọn mới được gửi cho Gemini (structured output, có `responseSchema`), trả về `{is_same_entity, confidence, reasoning}` với lý do bằng tiếng Việt.

**Điểm tổng hợp** — xem `combineConfidence()` (`server/resolution.ts`) và `CombineConfidence()` (`internal/resolution/resolution.go`):

```
p_same   = verdict ? confidence : 1 - confidence
combined = 0.35 × cosine_similarity + 0.65 × p_same
```

Vector được đánh trọng số thấp hơn vì nó là công cụ **tăng độ phủ** — giỏi gợi ra ứng viên, yếu khi ra quyết định. Gemini nhìn thêm cả email và số điện thoại, tức bằng chứng định danh thật sự, nên chiếm trọng số lớn hơn.

**Không bao giờ tự động gộp.** Mọi ứng viên còn lại đều trở thành gợi ý chờ người dùng duyệt.

### Ngân sách gọi Gemini

Giai đoạn 2 gọi Gemini **một lần cho mỗi bản ghi**, không phải mỗi cặp: toàn bộ danh sách ứng viên rút gọn của một bản ghi được đưa vào cùng một request và mô hình trả về mảng phán quyết theo từng ứng viên.

Số liệu đo thực tế trên bộ seed (8 dòng, 2 tệp):

| | Gọi mỗi cặp (thiết kế cũ) | Gọi theo lô (hiện tại) |
|---|---|---|
| Tệp 1 (4 dòng) | 6 | **3** |
| Tệp 2 (4 dòng) | 19 | **4** |

Điều này quan trọng vì **hạn mức Gemini free tier là 20 request/ngày/model**. Thiết kế cũ dùng hết hạn mức chỉ với một bảng tính. Hạn mức tính riêng cho từng model, nên đổi `GEMINI_MODEL` sẽ cho một hạn mức mới.

Mặc định là `gemini-3.5-flash`. `gemini-3.6-flash` cũng hợp lệ (đã kiểm chứng) và có thể dùng nếu bạn muốn model mới hơn.

**Tín hiệu phủ định.** Bảng `merge_suggestions` có chỉ mục duy nhất trên `(canonical_entity_id, candidate_raw_record_id)`. Khi người dùng từ chối, bản ghi vẫn ở lại với `status='rejected'`; Stage 1 loại trừ mọi cặp đã có bản ghi bằng `NOT EXISTS`, nên **cặp đã bị từ chối không bao giờ được đề xuất lại** và cũng không tốn thêm lượt gọi Gemini.

### Vì sao mỗi bản ghi có danh tính tạo một thực thể riêng

Khi nhập, mỗi bản ghi xác định được cá nhân hoặc tổ chức được gắn với đúng một thực thể chuẩn (`link_method='seed'`). Dòng chưa đủ danh tính vẫn được lưu nguyên bản nhưng chưa gắn thực thể. Gợi ý đang chờ không thay đổi liên kết; khi bạn phê duyệt, bản ghi được chuyển sang thực thể đích và thực thể "seed" rỗng bị xóa.

Nhờ vậy **tỷ lệ hợp nhất là con số trung thực**: nó chỉ cải thiện khi có người thật sự phê duyệt, chứ không phải một con số đẹp có sẵn.

---

## 4. An toàn cho tìm kiếm ngôn ngữ tự nhiên

Câu hỏi tiếng Việt/tiếng Anh được Gemini dịch sang bộ lọc — **mô hình không bao giờ viết SQL**.

1. `responseSchema` ràng buộc `column` và `operator` bằng **enum**, nên mô hình không thể sinh ra định danh ngoài danh sách.
2. Máy chủ **kiểm tra lại** từng bộ lọc theo whitelist (`server/search-schema.ts`, `internal/search/search.go`) — phòng thủ nhiều lớp, không tin vào ràng buộc schema.
3. Mỗi `column` được ánh xạ sang **một đoạn SQL cố định viết sẵn trong mã nguồn**. Chuỗi do mô hình sinh ra không bao giờ đi vào câu truy vấn.
4. Mọi giá trị đều được **bind bằng tham số `$n`**. Ký tự đại diện của `ILIKE` được thêm ở phía máy chủ sau khi escape.

Không có đường đi nào nối chuỗi từ mô hình vào SQL.

Muốn mở rộng phạm vi tìm kiếm, cách **duy nhất** là thêm cột vào bảng whitelist đó.

---

## 5. Google APIs & OAuth scopes cần bật

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  aiplatform.googleapis.com \
  generativelanguage.googleapis.com \
  drive.googleapis.com \
  sheets.googleapis.com \
  identitytoolkit.googleapis.com
```

Scope OAuth mà người dùng cấp khi đăng nhập Google (chỉ đọc):

- `https://www.googleapis.com/auth/drive.readonly`
- `https://www.googleapis.com/auth/spreadsheets.readonly`

Trình duyệt lấy access token qua Firebase Google provider và gửi kèm mỗi request ở header `X-Google-Access-Token`. Token **không được lưu phía máy chủ**. Nó khác với Firebase ID token: ID token chứng minh *bạn là ai*, access token cho phép máy chủ gọi Drive/Sheets *thay mặt bạn*.

Access token của Google hết hạn sau khoảng 1 giờ và Firebase SDK **không** tự làm mới nó — giao diện sẽ hiện nút cấp quyền lại.

---

## 6. Xác thực

| `AUTH_MODE` | Hành vi |
|---|---|
| `dev` | Bỏ qua xác thực, mọi request thuộc `DEV_ORG_ID`. **Bị từ chối trong production và trên Cloud Run.** |
| `firebase` | Kiểm tra chữ ký RS256 của Firebase ID token theo khóa công khai của Google, cùng issuer/audience/expiry. |

Khóa tổ chức (`organization_id`) lấy từ custom claim `org_id`. Nếu chưa có claim, mỗi Firebase UID được cách ly trong một tổ chức cá nhân riêng; hệ thống không gộp người dùng theo tên miền email. Mọi truy vấn đều lọc theo `organization_id`.

Phiên đăng nhập dùng **Firebase session cookie** (HttpOnly, SameSite=Strict), không phải ID token thô. Mỗi request đều kiểm tra thu hồi — đăng xuất hoặc khoá tài khoản có hiệu lực ngay.

Tạo cookie (`:createSessionCookie`) và thu hồi refresh token là **lệnh gọi API Firebase Auth có đặc quyền**, không phải ký cục bộ, nên tài khoản dịch vụ cần các quyền `firebaseauth.users.createSession`, `firebaseauth.users.get` và `firebaseauth.users.update` — gọn nhất là `roles/firebaseauth.admin`. Khoá do Firebase cấp (`FIREBASE_SERVICE_ACCOUNT_JSON`) đã có sẵn các quyền này.

### Di trú dữ liệu từ khóa tổ chức cũ

Trước đây `organization_id` suy ra từ tên miền email (`org_fpt.com`), nên dữ liệu cũ nằm dưới khóa mà cơ chế mới không bao giờ sinh ra — sau khi nâng cấp sẽ không còn truy cập được. Lệnh dưới đây chuyển mỗi nguồn (và toàn bộ bản ghi, thực thể, gợi ý hợp nhất của nó) sang tổ chức cá nhân của người đã nhập nó, tra theo `imported_by`:

```bash
# 1. Liệt kê các tổ chức còn dùng khóa cũ (không ghi gì)
go run ./cmd/migrate-tenants

# 2. Chạy thử cho tổ chức đã chọn — thực thi rồi hoàn tác, nên số liệu là số thật
go run ./cmd/migrate-tenants -orgs=org_fpt.com

# 3. Thực hiện
go run ./cmd/migrate-tenants -orgs=org_fpt.com -apply
```

`-orgs` là **bắt buộc** và `-apply` không chạy nếu thiếu nó: một `org_id` đặt qua custom claim cũng không có tiền tố `org_user_`, nên không thể tự đoán đâu là dữ liệu cũ mà không xoá nhầm một tổ chức có thật.

Vài điểm cần biết trước khi chạy:

- **Nguồn dùng chung thực thể luôn đi cùng nhau.** Duyệt một gợi ý hợp nhất sẽ nối một thực thể với bản ghi từ nhiều nguồn; tách chúng ra sẽ để lại thực thể nằm giữa hai tổ chức. Các nguồn như vậy được gom thành một nhóm không thể chia nhỏ và cùng về một chủ sở hữu.
- **Gợi ý hợp nhất nằm giữa hai tổ chức sẽ bị xoá.** Một gợi ý `pending` trỏ tới bản ghi ứng viên chưa được nối, nên nó có thể rơi sang nhóm khác; nếu giữ lại, bấm duyệt sẽ kéo bản ghi của tổ chức khác sang. Số lượng được báo cáo ở bước chạy thử.
- **Có cổng kiểm tra toàn vẹn.** Trước khi commit, lệnh đếm mọi dòng có `organization_id` lệch với đối tượng nó thuộc về; chỉ cần một dòng là toàn bộ giao dịch bị hoàn tác.
- Nguồn nào không tra được tài khoản Firebase (dữ liệu dev, nhân sự đã nghỉ) sẽ được liệt kê và giữ nguyên.

Lưu ý: dữ liệu trước đây dùng chung theo tên miền sẽ trở thành riêng của người tải lên — muốn giữ chung, hãy đặt custom claim `org_id` cho các tài khoản liên quan thay vì chạy lệnh này.

---

## 7. Triển khai Cloud Run + Cloud SQL

### Bản Go (dùng `Dockerfile` sẵn có)

```bash
PROJECT_ID=$(gcloud config get-value project)
REGION=asia-southeast1

# Cloud SQL + pgvector
gcloud sql instances create event-hub-db \
  --database-version=POSTGRES_16 --tier=db-g1-small --region=$REGION
gcloud sql databases create event_data_hub --instance=event-hub-db
# Bật extension một lần (psql vào instance):  CREATE EXTENSION IF NOT EXISTS vector;

gcloud builds submit --tag gcr.io/$PROJECT_ID/event-data-hub

gcloud run deploy event-data-hub \
  --image gcr.io/$PROJECT_ID/event-data-hub \
  --region $REGION --platform managed --allow-unauthenticated \
  --add-cloudsql-instances $PROJECT_ID:$REGION:event-hub-db \
  --set-env-vars "AUTH_MODE=firebase,FIREBASE_PROJECT_ID=$PROJECT_ID" \
  --set-env-vars "VITE_FIREBASE_API_KEY=...,VITE_FIREBASE_AUTH_DOMAIN=$PROJECT_ID.firebaseapp.com,VITE_FIREBASE_APP_ID=..." \
  --set-env-vars "USE_VERTEX_EMBEDDINGS=true,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=$REGION" \
  --set-env-vars "DATABASE_URL=postgres://USER:PASS@/event_data_hub?host=/cloudsql/$PROJECT_ID:$REGION:event-hub-db" \
  --set-secrets "GEMINI_API_KEY=gemini-api-key:latest"
```

Trên Cloud Run nên đặt `USE_VERTEX_EMBEDDINGS=true`: service account đã có sẵn ADC nên không cần API key cho bước embedding.

Dùng Secret Manager cho `GEMINI_API_KEY` thay vì `--set-env-vars`.

### Bản Node

`npm run build` rồi `npm start` (`NODE_ENV=production`). Cần `AUTH_MODE=firebase`, nếu không tiến trình sẽ từ chối khởi động.

---

## 8. Cấu trúc thư mục

```
├── main.go                     # Bản Go: entrypoint, router, graceful shutdown
├── internal/
│   ├── ai/                     # Client Gemini + embeddings (structured output)
│   ├── auth/                   # Xác minh Firebase ID token
│   ├── config/                 # Đọc biến môi trường (nơi duy nhất)
│   ├── db/                     # SQL thô qua pgx/v5, truy vấn pgvector
│   ├── handlers/               # HTTP handlers trả về fragment HTMX
│   ├── normalize/              # Chuẩn hóa tên/email/SĐT/ngày tháng
│   ├── resolution/             # Pipeline hợp nhất hai giai đoạn
│   ├── search/                 # Whitelist NL→SQL
│   └── sources/                # excelize + Drive/Sheets REST
├── templates/                  # html/template + partial HTMX
│
├── server.ts                   # Bản Node: entrypoint
├── server/                     # Tương ứng từng module với internal/ ở trên
├── src/                        # Giao diện React
│
├── migrations/                 # SQL thuần (golang-migrate), dùng chung
├── Dockerfile                  # Cloud Run (multi-stage, distroless)
└── docker-compose.yml          # Postgres + pgvector cho local
```

---

## 9. Hạn chế đã biết

Những điểm này là **cố ý** và cần xử lý trước khi dùng thật:

- **Bảng tạm khi nhập dữ liệu nằm trong bộ nhớ tiến trình.** Bản Go giữ bảng tính đã phân tích trong RAM (TTL 30 phút) giữa bước xem trước và bước xác nhận; bản Node gửi dữ liệu vòng qua trình duyệt. Cả hai đều **không hoạt động đúng khi Cloud Run chạy nhiều instance**. Cần chuyển sang Memorystore/Redis hoặc bảng tạm trong DB.
- **Giới hạn 5000 dòng mỗi lần nhập**, và toàn bộ quá trình đối chiếu chạy đồng bộ trong một request. Với tệp lớn nên chuyển sang hàng đợi nền (Cloud Tasks).
- **`xlsx@0.18.5` trên npm có CVE prototype pollution đã biết** và không còn được cập nhật trên registry npm. Bản Go dùng `excelize` không bị ảnh hưởng. Nếu nhận tệp từ nguồn không tin cậy, hãy đổi sang `exceljs` hoặc cài SheetJS từ `cdn.sheetjs.com`.
- **Test tự động hiện tập trung vào các lỗi hồi quy quan trọng:** giới hạn batch Vertex AI, cô lập tenant Firebase, hiển thị lỗi HTMX và bảo toàn dữ liệu thô khi nhập. Luồng migration và nhập → gợi ý → duyệt vẫn cần kiểm thử tích hợp đầy đủ hơn.
- **Ngưỡng `RESOLUTION_MIN_SIMILARITY = 0.89` được đo, không phải đoán.** Trên bộ seed, embedding của chuỗi `họ tên | đơn vị | chức danh` đặt những người **không liên quan** ở 0.804–0.880 (các chuỗi này gần như cùng cấu trúc nên dải tương đồng bị nén lại), còn biến thể tên **thật sự trùng** ở 0.909–0.940. Hãy **đo lại trên dữ liệu của bạn** trước khi đổi. Nâng ngưỡng an toàn vì bước blocking theo email/SĐT chạy song song và bỏ qua ngưỡng này.
- **`GEMINI_MODEL` đã được kiểm chứng lúc khởi động.** Nếu API key của bạn không truy cập được model đang đặt, log khởi động sẽ báo rõ và bạn chỉ cần đổi biến môi trường.
- **Ngày tháng không phân tích được sẽ giữ nguyên bản** trong `event_date_raw` và `event_date` để `NULL`, thay vì đoán bừa. Giao diện đánh dấu "chưa nhận dạng".
