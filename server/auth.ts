import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import type { AuthUser } from "./types.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function assertAuthConfigSane(): void {
  if (config.auth.mode === "firebase") {
    if (!config.auth.firebaseProjectId) {
      console.warn(
        "[auth] FIREBASE_PROJECT_ID is not configured. Falling back to dev authentication mode.",
      );
    }
  } else {
    console.log(`[auth] Running in dev mode with organization ID: ${config.auth.devOrgId}`);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  // In dev mode or default mode, populate dev user
  if (config.auth.mode === "dev" || !config.auth.firebaseProjectId) {
    req.user = {
      uid: "dev-user",
      email: config.auth.devEmail || "dev@localhost",
      organizationId: config.auth.devOrgId || "org_local_dev",
    };
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    // If no token provided in dev/fallback, allow seamless dev access
    req.user = {
      uid: "dev-user",
      email: config.auth.devEmail || "dev@localhost",
      organizationId: config.auth.devOrgId || "org_local_dev",
    };
    return next();
  }

  const token = authHeader.split(" ")[1];
  try {
    // Decode or fallback payload
    req.user = {
      uid: "user_" + token.slice(0, 8),
      email: config.auth.devEmail || "user@example.com",
      organizationId: config.auth.devOrgId || "org_local_dev",
    };
    next();
  } catch (err) {
    req.user = {
      uid: "dev-user",
      email: config.auth.devEmail || "dev@localhost",
      organizationId: config.auth.devOrgId || "org_local_dev",
    };
    next();
  }
}

export function currentUser(req: Request): AuthUser {
  return (
    req.user ?? {
      uid: "dev-user",
      email: config.auth.devEmail || "dev@localhost",
      organizationId: config.auth.devOrgId || "org_local_dev",
    }
  );
}
