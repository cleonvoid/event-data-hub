import { config } from "../config.js";
import { closePool, runMigrations } from "../db.js";
import { importAndResolve } from "../resolution.js";

/**
 * Seeds two deliberately messy spreadsheets so the demo has something to
 * deduplicate. This goes through the SAME import + resolution path as a real
 * upload — real embeddings, real Stage 1 retrieval, real Gemini adjudication —
 * so what you see afterwards is genuine output, not fixtures.
 *
 *   npm run seed
 */

const orgId = config.auth.devOrgId;

// File 1: the "official" speaker list. Vietnamese headers, diacritics, titles.
const file1 = {
  headers: ["STT", "Họ và tên", "Đơn vị công tác", "Chức danh", "Email", "Số điện thoại", "Tên sự kiện", "Ngày tổ chức"],
  rows: [
    ["1", "PGS.TS. Nguyễn Văn Hoàng", "Viện Nghiên cứu Trí tuệ Nhân tạo VinAI", "Chuyên gia AI Cấp cao", "hoang.nguyen@vinai.io", "0988 112 233", "Hội thảo Ứng dụng AI trong Quản trị Công 2025", "15/06/2025"],
    ["2", "Trần Minh Đức", "Công ty CP Công nghệ VN", "Giám đốc Chuyển đổi số", "duc.tm@vntech.com.vn", "0912 345 678", "Hội thảo Ứng dụng AI trong Quản trị Công 2025", "15/06/2025"],
    ["3", "ThS. Lê Thị Thu Hà", "Đại học Bách Khoa Hà Nội", "Phó Trưởng khoa CNTT", "ha.lethu@hust.edu.vn", "0913 221 144", "Hội thảo Ứng dụng AI trong Quản trị Công 2025", "15/06/2025"],
    ["4", "Phạm Quốc Bảo", "Tập đoàn FPT", "Trưởng phòng Đầu tư Công nghệ", "bao.pq@fpt.com.vn", "0903 998 877", "Hội thảo Ứng dụng AI trong Quản trị Công 2025", "15/06/2025"],
  ],
};

// File 2: a different team's export. English headers, no diacritics, short
// names, different org spellings, ISO dates. Same four people plus one new.
const file2 = {
  headers: ["Full Name", "Company", "Job Title", "Email Address", "Mobile", "Event", "Date", "Notes"],
  rows: [
    ["N. V. Hoàng", "VinAI Research", "Senior AI Scientist", "hoang.nguyen@vinai.io", "0988112233", "TechFest 2025 - Kết nối Mạng lưới Đầu tư", "2025-08-01", "Giám khảo cuộc thi khởi nghiệp"],
    ["Tran Van Minh Duc", "VN Tech Corp", "Head of AI Innovation", "duc.tm@vntech.com.vn", "+84912345678", "TechFest 2025 - Kết nối Mạng lưới Đầu tư", "2025-08-01", "Tham gia tọa đàm kết nối đầu tư"],
    ["Pham Quoc Bao", "FPT Corp", "Investment Manager", "bao.pq@fpt.com.vn", "0903998877", "TechFest 2025 - Kết nối Mạng lưới Đầu tư", "2025-08-01", ""],
    ["Nguyễn Văn Hùng", "Sở Khoa học và Công nghệ TP.HCM", "Phó Giám đốc", "hung.nv@dost.hochiminhcity.gov.vn", "0907 445 566", "TechFest 2025 - Kết nối Mạng lưới Đầu tư", "2025-08-01", "Đại biểu khách mời"],
  ],
};

const mapping1 = {
  "STT": "ignore",
  "Họ và tên": "full_name",
  "Đơn vị công tác": "organization",
  "Chức danh": "role_title",
  "Email": "email",
  "Số điện thoại": "phone",
  "Tên sự kiện": "event_name",
  "Ngày tổ chức": "event_date",
};

const mapping2 = {
  "Full Name": "full_name",
  "Company": "organization",
  "Job Title": "role_title",
  "Email Address": "email",
  "Mobile": "phone",
  "Event": "event_name",
  "Date": "event_date",
  "Notes": "notes",
};

async function main(): Promise<void> {
  await runMigrations();

  console.log(`Seeding into organization "${orgId}"…`);

  const r1 = await importAndResolve({
    organizationId: orgId,
    importedBy: "seed@localhost",
    sourceName: "Danh_sach_Dien_gia_Hoi_thao_AI_2025.xlsx",
    sourceType: "local_upload",
    externalFileId: null,
    headers: file1.headers,
    rows: file1.rows,
    mapping: mapping1,
  });
  console.log("file 1:", r1);

  const r2 = await importAndResolve({
    organizationId: orgId,
    importedBy: "seed@localhost",
    sourceName: "TechFest_2025_Attendees.xlsx",
    sourceType: "google_sheets",
    externalFileId: "seed-sheet-id",
    headers: file2.headers,
    rows: file2.rows,
    mapping: mapping2,
  });
  console.log("file 2:", r2);

  console.log(
    `\nDone. ${r2.suggestionsCreated} merge suggestion(s) are waiting for review ` +
      `at http://localhost:${config.port}.`,
  );
}

main()
  .catch((err) => {
    console.error("seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
