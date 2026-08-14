import path from "node:path";
import express from "express";
import { createServer as createViteServer } from "vite";
import { config } from "./server/config.js";
import { assertAuthConfigSane } from "./server/auth.js";
import { closePool, runMigrations } from "./server/db.js";
import { api, errorHandler } from "./server/routes.js";
import { isAiConfigured } from "./server/ai/client.js";
import { preflightModel } from "./server/ai/gemini.js";

const app = express();

// Sheet rows round-trip through the browser between preview and confirm, so the
// default 100kb JSON limit is far too small for a real attendee list.
app.use(express.json({ limit: "25mb" }));

app.use("/api", api);
app.use("/api", errorHandler);

async function startServer(): Promise<void> {
  assertAuthConfigSane();

  await runMigrations();
  console.log("[boot] database ready");

  if (!isAiConfigured()) {
    console.warn(
      "[boot] GEMINI_API_KEY is not set. Schema mapping, merge adjudication and NL search " +
        "will return errors; import will fail at the embedding step. Set it in .env.",
    );
  } else {
    // Model ids change frequently. Verifying once at boot turns a confusing
    // mid-demo 404 into a clear startup message.
    const preflight = await preflightModel();
    if (preflight.ok) {
      console.log(`[boot] Gemini model "${config.gemini.model}" OK`);
    } else {
      console.error(
        `[boot] Gemini model "${config.gemini.model}" is NOT usable: ${preflight.detail}\n` +
          `       Override it with GEMINI_MODEL=<a model your key can access>.`,
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

  // Cloud Run injects PORT; binding 0.0.0.0 is required there.
  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`[boot] Event Data Hub listening on http://0.0.0.0:${config.port}`);
    console.log(`[boot] auth mode: ${config.auth.mode}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[shutdown] ${signal} received, closing`);
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });
    // Cloud Run allows 10s before SIGKILL; don't hang past it.
    setTimeout(() => process.exit(1), 9_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer().catch((err) => {
  console.error("[boot] failed to start:", err);
  process.exit(1);
});
