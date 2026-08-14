import { closePool, runMigrations } from "../db.js";

runMigrations()
  .then(() => {
    console.log("migrations up to date");
  })
  .catch((err) => {
    console.error("migration failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
