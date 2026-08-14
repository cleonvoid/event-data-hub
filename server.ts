import path from "node:path";
import express from "express";
import { createServer as createViteServer } from "vite";
import { config } from "./server/config.js";
import { assertAuthConfigSane } from "./server/auth.js";
import { closePool, runMigrations } from "./server/db.js";
import { api, errorHandler } from "./server/routes.js";
import { isAiConfigured } from "./server/ai/client.js";
import { preflightModel } from "./server/ai/gemini.js";
import { getStats } from "./server/repo.js";
import { importAndResolve } from "./server/resolution.js";

const app = express();

// Sheet rows round-trip through the browser between preview and confirm, so the
// default 100kb JSON limit is far too small for a real attendee list.
app.use(express.json({ limit: "25mb" }));

app.use("/api", api);
app.use("/api", errorHandler);

async function autoSeedIfEmpty(): Promise<void> {
  try {
    const stats = await getStats(config.auth.devOrgId);
    if (stats.sourceFilesProcessed > 0 || stats.totalCanonicalEntities > 0) {
      return;
    }
    console.log("[boot] Auto-seeding initial demo data...");
    const file1 = {
      headers: ["STT", "Họ và tên", "Đơn vị công tác", "Chức danh", "Email", "Số điện thoại", "Tên sự kiện", "Ngày tổ chức"],
      rows: [
        ["1", "PGS.TS. Nguyễn Văn Hoàng", "Viện Nghiên cứu Trí tuệ Nhân tạo VinAI", "Chuyên gia AI Cấp cao", "hoang.nguyen@vinai.io", "0988 112 233", "Hội thảo Ứng dụng AI trong Quản trị Công 2025", "15/06/2025"],
        ["2", "Trần Minh Đức", "Công ty CP Công nghệ VN", "Giám đốc Chuyển đổi số", "duc.tm@vntech.com.vn", "0912 345 678", "Hội thảo Ứng dụng AI trong Quản trị Công 2025", "15/06/2025"],
        ["3", "ThS. Lê Thị Thu Hà", "Đại học Bách Khoa Hà Nội", "Phó Trưởng khoa CNTT", "ha.lethu@hust.edu.vn", "0913 221 144", "Hội thảo Ứng dụng AI trong Quản trị Công 2025", "15/06/2025"],
        ["4", "Phạm Quốc Bảo", "Tập đoàn FPT", "Trưởng phòng Đầu tư Công nghệ", "bao.pq@fpt.com.vn", "0903 998 877", "Hội thảo Ứng dụng AI trong Quản trị Công 2025", "15/06/2025"],
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

    const file2 = {
      headers: ["Full Name", "Company", "Job Title", "Email Address", "Mobile", "Event", "Date", "Notes"],
      rows: [
        ["N. V. Hoàng", "VinAI Research", "Senior AI Scientist", "hoang.nguyen@vinai.io", "0988112233", "TechFest 2025 - Kết nối Mạng lưới Đầu tư", "2025-08-01", "Giám khảo cuộc thi khởi nghiệp"],
        ["Tran Van Minh Duc", "VN Tech Corp", "Head of AI Innovation", "duc.tm@vntech.com.vn", "+84912345678", "TechFest 2025 - Kết nối Mạng lưới Đầu tư", "2025-08-01", "Tham gia tọa đàm kết nối đầu tư"],
        ["Pham Quoc Bao", "FPT Corp", "Investment Manager", "bao.pq@fpt.com.vn", "0903998877", "TechFest 2025 - Kết nối Mạng lưới Đầu tư", "2025-08-01", ""],
        ["Nguyễn Văn Hùng", "Sở Khoa học và Công nghệ TP.HCM", "Phó Giám đốc", "hung.nv@dost.hochiminhcity.gov.vn", "0907 445 566", "TechFest 2025 - Kết nối Mạng lưới Đầu tư", "2025-08-01", "Đại biểu khách mời"],
      ],
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

    await importAndResolve({
      organizationId: config.auth.devOrgId,
      importedBy: "seed@localhost",
      sourceName: "Danh_sach_Dien_gia_Hoi_thao_AI_2025.xlsx",
      sourceType: "local_upload",
      externalFileId: null,
      headers: file1.headers,
      rows: file1.rows,
      mapping: mapping1,
    });

    await importAndResolve({
      organizationId: config.auth.devOrgId,
      importedBy: "seed@localhost",
      sourceName: "TechFest_2025_Attendees.xlsx",
      sourceType: "google_sheets",
      externalFileId: "seed-sheet-id",
      headers: file2.headers,
      rows: file2.rows,
      mapping: mapping2,
    });
    console.log("[boot] Auto-seed complete.");
  } catch (err) {
    console.warn("[boot] autoSeedIfEmpty warning:", err);
  }
}

async function startServer(): Promise<void> {
  assertAuthConfigSane();

  await runMigrations();
  console.log("[boot] database ready");

  await autoSeedIfEmpty();

  if (!isAiConfigured()) {
    console.warn(
      "[boot] GEMINI_API_KEY is not set. Schema mapping, merge adjudication and NL search will use heuristic fallbacks.",
    );
  } else {
    const preflight = await preflightModel();
    if (preflight.ok) {
      console.log(`[boot] Gemini model "${config.gemini.model}" OK`);
    } else {
      console.warn(
        `[boot] Gemini model "${config.gemini.model}" note: ${preflight.detail}`,
      );
    }
  }

  if (config.isProduction) {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`[boot] Event Data Hub listening on http://0.0.0.0:${config.port}`);
    console.log(`[boot] auth mode: ${config.auth.mode}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[shutdown] ${signal} received, closing`);
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 9_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer().catch((err) => {
  console.error("[boot] failed to start:", err);
  process.exit(1);
});
