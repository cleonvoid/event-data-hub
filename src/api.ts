import { getGoogleAccessToken, getIdToken } from "./auth";
import type {
  DriveFile,
  EntitySearchResponse,
  HealthInfo,
  ImportResult,
  MergeSuggestion,
  PreviewPayload,
  RawRecord,
  SourceRow,
  StatsSummary,
  CanonicalEntity,
} from "./types";

/**
 * Single place every API call goes through, so auth headers and error handling
 * are consistent. Errors surface the server's Vietnamese message rather than a
 * generic "request failed", because that message is usually actionable
 * (missing scope, expired token, unmapped columns).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  opts: { withGoogleToken?: boolean } = {},
): Promise<T> {
  const headers = new Headers(init.headers);

  const idToken = await getIdToken();
  if (idToken) headers.set("Authorization", `Bearer ${idToken}`);

  if (opts.withGoogleToken) {
    const accessToken = getGoogleAccessToken();
    if (accessToken) headers.set("X-Google-Access-Token", accessToken);
  }

  // Let the browser set the multipart boundary itself for FormData bodies.
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`/api${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? safeParse(text) : {};

  if (!res.ok) {
    const message =
      (body as { error?: string }).error ?? `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, (body as { hint?: string }).hint);
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 300) };
  }
}

export const api = {
  health: () => request<HealthInfo>("/health"),

  stats: () => request<StatsSummary>("/stats"),

  sources: () => request<{ sources: SourceRow[] }>("/sources"),

  entities: (params: { q?: string; page?: number; limit?: number }) => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.page) search.set("page", String(params.page));
    if (params.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    return request<EntitySearchResponse>(`/entities${qs ? `?${qs}` : ""}`);
  },

  entityDetail: (id: string) =>
    request<{ entity: CanonicalEntity; records: RawRecord[]; differingFields: string[] }>(
      `/entities/${encodeURIComponent(id)}`,
    ),

  driveFiles: (q?: string) =>
    request<{ files: DriveFile[] }>(
      `/drive/files${q ? `?q=${encodeURIComponent(q)}` : ""}`,
      {},
      { withGoogleToken: true },
    ),

  previewUpload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<PreviewPayload>("/preview/upload", { method: "POST", body: form });
  },

  previewDrive: (file: DriveFile) =>
    request<PreviewPayload>(
      "/preview/drive",
      {
        method: "POST",
        body: JSON.stringify({ fileId: file.id, mimeType: file.mimeType, name: file.name }),
      },
      { withGoogleToken: true },
    ),

  confirmImport: (payload: {
    sourceName: string;
    sourceType: string;
    externalFileId: string | null;
    headers: string[];
    rows: string[][];
    mapping: Record<string, string>;
  }) => request<ImportResult>("/import/confirm", { method: "POST", body: JSON.stringify(payload) }),

  merges: () => request<{ suggestions: MergeSuggestion[] }>("/merges"),

  approveMerge: (id: string) =>
    request<{ message: string }>(`/merges/${encodeURIComponent(id)}/approve`, { method: "POST" }),

  rejectMerge: (id: string) =>
    request<{ message: string }>(`/merges/${encodeURIComponent(id)}/reject`, { method: "POST" }),
};
