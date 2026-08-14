import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Building2,
  Database,
  FileSpreadsheet,
  GitMerge,
  Loader2,
  LogOut,
  Search,
  Sparkles,
  Upload,
  Users,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { api, ApiError } from "./api";
import {
  getGoogleAccessToken,
  isFirebaseConfigured,
  onAuthChange,
  signInWithGoogle,
  signOut,
} from "./auth";
import { StatsOverview } from "./components/StatsOverview";
import { SchemaMappingModal } from "./components/SchemaMappingModal";
import { MergeReviewModal } from "./components/MergeReviewModal";
import { EntityDetailDrawer } from "./components/EntityDetailDrawer";
import { DrivePickerModal } from "./components/DrivePickerModal";
import { Toasts, useToasts } from "./components/Toasts";
import type {
  AppliedFilter,
  CanonicalEntity,
  HealthInfo,
  MergeSuggestion,
  PreviewPayload,
  RawRecord,
  SourceRow,
  StatsSummary,
} from "./types";

const PAGE_SIZE = 25;

export default function App() {
  const { toasts, push, dismiss } = useToasts();

  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [userLabel, setUserLabel] = useState<string>("");
  const [authReady, setAuthReady] = useState(false);

  const [stats, setStats] = useState<StatsSummary | null>(null);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [entities, setEntities] = useState<CanonicalEntity[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [merges, setMerges] = useState<MergeSuggestion[]>([]);

  const [searchInput, setSearchInput] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [searchExplanation, setSearchExplanation] = useState<string | null>(null);
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilter[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingEntities, setIsLoadingEntities] = useState(false);

  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const [showDrivePicker, setShowDrivePicker] = useState(false);
  const [showMergeReview, setShowMergeReview] = useState(false);
  const [drawerEntity, setDrawerEntity] = useState<CanonicalEntity | null>(null);
  const [drawerRecords, setDrawerRecords] = useState<RawRecord[]>([]);
  const [drawerDiffs, setDrawerDiffs] = useState<string[]>([]);
  const [drawerLoading, setDrawerLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const reportError = useCallback(
    (err: unknown, fallback: string) => {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : fallback;
      const hint = err instanceof ApiError ? err.hint : undefined;
      push({ kind: "error", message, detail: hint });
    },
    [push],
  );

  // ---- auth -------------------------------------------------------------
  useEffect(() => {
    let unsubscribe = () => {};
    void api
      .health()
      .then((h) => {
        setHealth(h);
        // In dev auth mode the server pins every request to one org, so the
        // sign-in gate would only be theatre.
        if (h.authMode === "dev") {
          setSignedIn(true);
          setUserLabel("Chế độ phát triển (AUTH_MODE=dev)");
          setAuthReady(true);
          return;
        }
        void onAuthChange((user) => {
          setSignedIn(Boolean(user));
          setUserLabel(user?.email ?? "");
          setAuthReady(true);
        }).then((fn) => {
          unsubscribe = fn;
        });
      })
      .catch((err) => {
        reportError(err, "Không kết nối được máy chủ");
        setAuthReady(true);
      });
    return () => unsubscribe();
  }, [reportError]);

  // ---- data loading -----------------------------------------------------
  const loadEntities = useCallback(
    async (q: string, targetPage: number) => {
      setIsLoadingEntities(true);
      try {
        const res = await api.entities({ q: q || undefined, page: targetPage, limit: PAGE_SIZE });
        setEntities(res?.entities ?? []);
        setTotal(res?.total ?? 0);
        setPage(res?.page ?? 1);
        setSearchExplanation(res?.explanation ?? null);
        setAppliedFilters(res?.filters ?? []);
        if (res?.mode === "keyword" && q) {
          push({ kind: "warn", message: "Gemini không khả dụng — đã chuyển sang tìm theo từ khóa." });
        }
      } catch (err) {
        reportError(err, "Không tải được danh sách thực thể");
      } finally {
        setIsLoadingEntities(false);
      }
    },
    [push, reportError],
  );

  const refreshAll = useCallback(async () => {
    const results = await Promise.allSettled([api.stats(), api.sources(), api.merges()]);
    if (results[0].status === "fulfilled") setStats(results[0].value ?? null);
    if (results[1].status === "fulfilled") setSources(results[1].value?.sources ?? []);
    if (results[2].status === "fulfilled") setMerges(results[2].value?.suggestions ?? []);
    const failure = results.find((r) => r.status === "rejected");
    if (failure && failure.status === "rejected") {
      reportError(failure.reason, "Không tải được dữ liệu tổng quan");
    }
  }, [reportError]);

  useEffect(() => {
    if (!signedIn) return;
    void refreshAll();
    void loadEntities("", 1);
  }, [signedIn, refreshAll, loadEntities]);

  // ---- search -----------------------------------------------------------
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchInput.trim();
    setActiveQuery(q);
    setIsSearching(true);
    await loadEntities(q, 1);
    setIsSearching(false);
  };

  const clearSearch = async () => {
    setSearchInput("");
    setActiveQuery("");
    await loadEntities("", 1);
  };

  // ---- import -----------------------------------------------------------
  const handleFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;

    setIsPreviewing(true);
    try {
      const payload = await api.previewUpload(file);
      setPreview(payload);
      if (payload.mappingSource === "unavailable") {
        push({
          kind: "warn",
          message: "Gemini chưa đề xuất được ánh xạ — vui lòng chọn thủ công.",
          detail: payload.mappingError,
        });
      }
    } catch (err) {
      reportError(err, "Không đọc được tệp");
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleDrivePick = async (file: Parameters<typeof api.previewDrive>[0]) => {
    setShowDrivePicker(false);
    setIsPreviewing(true);
    try {
      setPreview(await api.previewDrive(file));
    } catch (err) {
      reportError(err, "Không đọc được bảng tính từ Drive");
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleConfirmImport = async (mapping: Record<string, string>) => {
    if (!preview) return;
    setIsImporting(true);
    try {
      const result = await api.confirmImport({
        sourceName: preview.sourceName,
        sourceType: preview.sourceType,
        externalFileId: preview.externalFileId,
        headers: preview.headers,
        rows: preview.rows,
        mapping,
      });
      setPreview(null);
      push({
        kind: "success",
        message: result.message,
        detail:
          `${result.geminiCalls} lượt đánh giá Gemini • ` +
          `${result.skippedRows} dòng bị bỏ qua • ` +
          `${result.autoRejected} cặp bị loại tự động`,
      });
      await refreshAll();
      await loadEntities(activeQuery, 1);
    } catch (err) {
      reportError(err, "Nhập dữ liệu thất bại");
    } finally {
      setIsImporting(false);
    }
  };

  // ---- merges -----------------------------------------------------------
  const handleApprove = async (id: string) => {
    try {
      const res = await api.approveMerge(id);
      push({ kind: "success", message: res.message });
      await refreshAll();
      await loadEntities(activeQuery, page);
    } catch (err) {
      reportError(err, "Phê duyệt thất bại");
      await refreshAll();
    }
  };

  const handleReject = async (id: string) => {
    try {
      const res = await api.rejectMerge(id);
      push({ kind: "success", message: res.message });
      await refreshAll();
    } catch (err) {
      reportError(err, "Từ chối thất bại");
      await refreshAll();
    }
  };

  // ---- drawer -----------------------------------------------------------
  const openDrawer = async (entity: CanonicalEntity) => {
    setDrawerEntity(entity);
    setDrawerLoading(true);
    try {
      const detail = await api.entityDetail(entity.id);
      setDrawerEntity(detail.entity);
      setDrawerRecords(detail.records);
      setDrawerDiffs(detail.differingFields);
    } catch (err) {
      reportError(err, "Không tải được chi tiết thực thể");
      setDrawerEntity(null);
    } finally {
      setDrawerLoading(false);
    }
  };

  // ---- render -----------------------------------------------------------
  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 text-gray-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Đang khởi tạo…
      </div>
    );
  }

  if (!signedIn) {
    return <SignInScreen onSignIn={signInWithGoogle} onError={reportError} toasts={toasts} dismiss={dismiss} />;
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col">
      <Toasts toasts={toasts} dismiss={dismiss} />

      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 bg-emerald-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">
            EDH
          </div>
          <div>
            <h1 className="text-base font-bold leading-tight">Event Data Hub</h1>
            <p className="text-xs text-gray-500">Chuẩn hóa &amp; Hợp nhất Dữ liệu Sự kiện</p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {merges.length > 0 && (
            <button
              onClick={() => setShowMergeReview(true)}
              className="inline-flex items-center gap-2 bg-blue-50 hover:bg-blue-100 text-blue-800 border border-blue-200 px-3 py-1.5 rounded-lg text-xs font-semibold"
            >
              <GitMerge className="w-4 h-4" />
              {merges.length} gợi ý chờ duyệt
            </button>
          )}
          <span className="text-xs text-gray-500 hidden md:inline">{userLabel}</span>
          {health?.authMode === "firebase" && (
            <button
              onClick={() => void signOut()}
              className="p-2 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100"
              title="Đăng xuất"
            >
              <LogOut className="w-4 h-4" />
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <aside className="w-72 bg-white border-r border-gray-200 p-4 space-y-6 overflow-y-auto shrink-0 hidden lg:block">
          <section>
            <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Nhập dữ liệu</h2>
            <div className="space-y-2">
              <button
                onClick={() => setShowDrivePicker(true)}
                disabled={isPreviewing}
                className="w-full inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
              >
                <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
                Chọn từ Google Drive
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isPreviewing}
                className="w-full inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
              >
                {isPreviewing ? (
                  <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />
                ) : (
                  <Upload className="w-4 h-4 text-emerald-600" />
                )}
                Tải lên tệp .xlsx / .csv
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFilePicked}
                className="hidden"
              />
            </div>
          </section>

          <StatsOverview stats={stats} />

          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                Tệp nguồn ({sources.length})
              </h2>
              <button
                onClick={() => void refreshAll()}
                className="p-1 text-gray-400 hover:text-gray-700 rounded"
                title="Làm mới"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
            {(sources ?? []).length === 0 ? (
              <p className="text-xs text-gray-400 italic">Chưa có tệp nào được nhập.</p>
            ) : (
              <ul className="space-y-1.5">
                {(sources ?? []).map((s) => (
                  <li key={s.id} className="text-xs border border-gray-100 rounded-lg p-2 bg-gray-50/60">
                    <p className="font-medium text-gray-800 truncate" title={s.name}>
                      {s.name}
                    </p>
                    <p className="text-gray-400 mt-0.5">
                      {sourceTypeLabel(s.sourceType)} • {s.recordsCount} bản ghi
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        {/* Main */}
        <main className="flex-1 overflow-y-auto p-6 min-w-0">
          <div className="max-w-6xl mx-auto space-y-5">
            <form onSubmit={handleSearch} className="flex gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder='Hỏi bằng ngôn ngữ tự nhiên — ví dụ: "chuyên gia AI tham gia sự kiện năm 2025"'
                  className="w-full pl-9 pr-3 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
              </div>
              <button
                type="submit"
                disabled={isSearching}
                className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60"
              >
                {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                Tìm kiếm
              </button>
              {activeQuery && (
                <button
                  type="button"
                  onClick={() => void clearSearch()}
                  className="px-4 py-2.5 border border-gray-300 rounded-xl text-sm font-medium hover:bg-gray-50"
                >
                  Xóa lọc
                </button>
              )}
            </form>

            {searchExplanation && activeQuery && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-sm">
                <p className="text-emerald-900 flex items-start gap-2">
                  <Sparkles className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" />
                  <span>{searchExplanation}</span>
                </p>
                {(appliedFilters ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2 pl-6">
                    {(appliedFilters ?? []).map((f, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center px-2 py-0.5 rounded-md bg-white border border-emerald-200 text-xs text-emerald-800 font-mono"
                      >
                        {f.columnLabel} {f.operatorLabel} “{f.value}”
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            <EntityTable
              entities={entities ?? []}
              total={total}
              page={page}
              totalPages={totalPages}
              loading={isLoadingEntities}
              onOpen={openDrawer}
              onPage={(p) => void loadEntities(activeQuery, p)}
              hasQuery={Boolean(activeQuery)}
            />
          </div>
        </main>
      </div>

      {preview && (
        <SchemaMappingModal
          preview={preview}
          isSubmitting={isImporting}
          onConfirm={handleConfirmImport}
          onClose={() => setPreview(null)}
        />
      )}

      {showDrivePicker && (
        <DrivePickerModal
          onSelect={handleDrivePick}
          onClose={() => setShowDrivePicker(false)}
          needsGoogleToken={!getGoogleAccessToken() && isFirebaseConfigured}
          onReauth={async () => {
            try {
              await signInWithGoogle();
              push({ kind: "success", message: "Đã cấp quyền truy cập Google Drive." });
            } catch (err) {
              reportError(err, "Cấp quyền Drive thất bại");
            }
          }}
        />
      )}

      {showMergeReview && (
        <MergeReviewModal
          suggestions={merges}
          onApprove={handleApprove}
          onReject={handleReject}
          onClose={() => setShowMergeReview(false)}
        />
      )}

      {drawerEntity && (
        <EntityDetailDrawer
          entity={drawerEntity}
          records={drawerRecords}
          differingFields={drawerDiffs}
          loading={drawerLoading}
          onClose={() => {
            setDrawerEntity(null);
            setDrawerRecords([]);
            setDrawerDiffs([]);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function EntityTable({
  entities,
  total,
  page,
  totalPages,
  loading,
  hasQuery,
  onOpen,
  onPage,
}: {
  entities: CanonicalEntity[];
  total: number;
  page: number;
  totalPages: number;
  loading: boolean;
  hasQuery: boolean;
  onOpen: (e: CanonicalEntity) => void;
  onPage: (p: number) => void;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Users className="w-4 h-4 text-emerald-600" />
          Thực thể chuẩn
          <span className="text-gray-400 font-normal">({total})</span>
        </h2>
        {loading && <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />}
      </div>

      {(entities ?? []).length === 0 ? (
        <div className="p-10 text-center">
          <Database className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-700">
            {hasQuery ? "Không có thực thể nào khớp truy vấn" : "Chưa có dữ liệu"}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {hasQuery
              ? "Thử diễn đạt lại câu hỏi hoặc xóa bộ lọc."
              : "Nhập một bảng tính từ Google Drive hoặc tải lên tệp .xlsx để bắt đầu."}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">Tên</th>
                  <th className="text-left font-semibold px-4 py-2.5">Đơn vị</th>
                  <th className="text-left font-semibold px-4 py-2.5">Chức danh</th>
                  <th className="text-right font-semibold px-4 py-2.5">Sự kiện</th>
                  <th className="text-right font-semibold px-4 py-2.5">Tệp nguồn</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(entities ?? []).map((e) => (
                  <tr
                    key={e.id}
                    onClick={() => onOpen(e)}
                    className="hover:bg-emerald-50/40 cursor-pointer"
                  >
                    <td className="px-4 py-2.5">
                      <p className="font-semibold text-gray-900">{e.displayName}</p>
                      {e.primaryEmail && <p className="text-xs text-gray-500">{e.primaryEmail}</p>}
                    </td>
                    <td className="px-4 py-2.5 text-gray-700">
                      <span className="inline-flex items-center gap-1.5">
                        {e.primaryOrganization && <Building2 className="w-3.5 h-3.5 text-gray-400" />}
                        {e.primaryOrganization || "—"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{e.primaryRole || "—"}</td>
                    <td className="px-4 py-2.5 text-right">
                      <span className="inline-block px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 font-semibold text-xs">
                        {e.eventCount}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-600">{e.sourceFileCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between text-xs">
              <span className="text-gray-500">
                Trang {page} / {totalPages}
              </span>
              <div className="flex gap-2">
                <button
                  disabled={page <= 1}
                  onClick={() => onPage(page - 1)}
                  className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50"
                >
                  Trước
                </button>
                <button
                  disabled={page >= totalPages}
                  onClick={() => onPage(page + 1)}
                  className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50"
                >
                  Sau
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SignInScreen({
  onSignIn,
  onError,
  toasts,
  dismiss,
}: {
  onSignIn: () => Promise<unknown>;
  onError: (err: unknown, fallback: string) => void;
  toasts: ReturnType<typeof useToasts>["toasts"];
  dismiss: (id: number) => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <Toasts toasts={toasts} dismiss={dismiss} />
      <div className="bg-white border border-gray-200 rounded-2xl p-8 max-w-md w-full text-center">
        <div className="w-12 h-12 bg-emerald-600 rounded-xl flex items-center justify-center text-white font-bold mx-auto mb-4">
          EDH
        </div>
        <h1 className="text-xl font-bold">Event Data Hub</h1>
        <p className="text-sm text-gray-500 mt-1 mb-6">
          Chuẩn hóa và hợp nhất dữ liệu sự kiện từ nhiều bảng tính.
        </p>

        {!isFirebaseConfigured ? (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-left text-sm text-amber-900">
            <p className="font-semibold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Chưa cấu hình Firebase
            </p>
            <p className="mt-1 text-xs">
              Đặt <code className="font-mono">VITE_FIREBASE_*</code> trong <code className="font-mono">.env</code>,
              hoặc chạy máy chủ với <code className="font-mono">AUTH_MODE=dev</code> để bỏ qua đăng nhập khi phát triển.
            </p>
          </div>
        ) : (
          <button
            onClick={async () => {
              setBusy(true);
              try {
                await onSignIn();
              } catch (err) {
                onError(err, "Đăng nhập thất bại");
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
            className="w-full inline-flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-3 rounded-xl font-semibold disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Đăng nhập bằng Google
          </button>
        )}
      </div>
    </div>
  );
}

function sourceTypeLabel(t: string): string {
  switch (t) {
    case "google_sheets":
      return "Google Sheets";
    case "google_drive_xlsx":
      return "Drive (.xlsx)";
    case "local_upload":
      return "Tải lên";
    default:
      return t;
  }
}
