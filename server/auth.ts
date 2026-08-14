import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";
import { cert, getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { config } from "./config.js";
import type { AuthUser } from "./types.js";

/**
 * Firebase ID token verification.
 *
 * This replaces an earlier "middleware" that base64-decoded nothing, checked no
 * signature, and fell through to a hardcoded org id on every request — i.e. a
 * complete auth bypass. verifyIdToken() below checks the RS256 signature against
 * Google's rotating public keys and validates issuer, audience, and expiry.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

let initialised = false;

function ensureFirebaseApp(): void {
  if (initialised || getApps().length > 0) {
    initialised = true;
    return;
  }
  if (!config.auth.firebaseProjectId) {
    throw new Error("AUTH_MODE=firebase requires FIREBASE_PROJECT_ID");
  }

  // verifyIdToken only needs the project id — it fetches Google's public signing
  // certificates over HTTPS. A service account is only required if you later add
  // privileged Admin SDK calls (custom claims, user management).
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountJson) {
    initializeApp({
      credential: cert(JSON.parse(serviceAccountJson)),
      projectId: config.auth.firebaseProjectId,
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    initializeApp({
      credential: applicationDefault(),
      projectId: config.auth.firebaseProjectId,
    });
  } else {
    initializeApp({ projectId: config.auth.firebaseProjectId });
  }
  initialised = true;
}

/**
 * Derives the tenant key. A custom claim wins; without one, each Firebase UID
 * is isolated instead of grouping unrelated users by email domain.
 */
function deriveOrganizationId(claims: Record<string, unknown>, uid: string): string {
  const claim = claims.org_id ?? claims.organization_id;
  if (typeof claim === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(claim.trim())) {
    return claim.trim();
  }
  const digest = createHash("sha256").update(uid).digest("hex").slice(0, 24);
  return `org_user_${digest}`;
}

export function assertAuthConfigSane(): void {
  if (config.auth.mode === "dev" && config.isProduction) {
    throw new Error(
      "AUTH_MODE=dev is refused when NODE_ENV=production. Set AUTH_MODE=firebase and FIREBASE_PROJECT_ID.",
    );
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (config.auth.mode === "dev") {
    req.user = {
      uid: "dev-user",
      email: config.auth.devEmail,
      organizationId: config.auth.devOrgId,
    };
    next();
    return;
  }

  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: "Thiếu Firebase ID token (Authorization: Bearer <token>)" });
    return;
  }

  void (async () => {
    try {
      ensureFirebaseApp();
      const decoded = await getAuth().verifyIdToken(match[1]);
      const email = typeof decoded.email === "string" ? decoded.email : "";
      req.user = {
        uid: decoded.uid,
        email,
        organizationId: deriveOrganizationId(decoded as Record<string, unknown>, decoded.uid),
      };
      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 401 for a bad/expired token, not 500 — the client should re-authenticate.
      res.status(401).json({ error: "Firebase ID token không hợp lệ", detail: message });
    }
  })();
}

/** Narrows req.user for handlers mounted behind requireAuth. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) {
    // Unreachable behind requireAuth; throwing beats silently defaulting an org.
    throw new Error("currentUser() called on an unauthenticated request");
  }
  return req.user;
}
