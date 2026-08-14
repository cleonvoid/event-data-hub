import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, FileSpreadsheet, Loader2, Search, ShieldAlert } from "lucide-react";
import { api, ApiError } from "../api";
import type { DriveFile } from "../types";

interface Props {
  onSelect: (file: DriveFile) => void;
  onClose: () => void;
  /** True when signed in via Firebase but no Drive access token is held yet. */
  needsGoogleToken: boolean;
  onReauth: () => Promise<void>;
}

const MIME_SHEET = "application/vnd.google-apps.spreadsheet";

export const DrivePickerModal: React.FC<Props> = ({
  onSelect,
  onClose,
  needsGoogleToken,
  onReauth,
}) => {
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.driveFiles(q || undefined);
      setFiles(res.files);
    } catch (err) {
      setError({
        message: err instanceof ApiError ? err.message : "Không tải được danh sách tệp",
        hint: err instanceof ApiError ? err.hint : undefined,
      });
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!needsGoogleToken) void load("");
  }, [needsGoogleToken, load]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 bg-gray-900/50 overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-2xl w-full border border-gray-200 my-8 overflow-hidden">
        <div className="p-5 border-b border-gray-200 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
              Chọn bảng tính từ Google Drive
            </h3>
            <p className="text-sm text-gray-500 mt-0.5">
              Chỉ hiển thị Google Sheets và tệp .xlsx trong Drive của bạn.
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100" aria-label="Đóng">
            ✕
          </button>
        </div>

        {needsGoogleToken ? (
          <div className="p-6 text-center">
            <ShieldAlert className="w-10 h-10 text-amber-500 mx-auto mb-3" />
            <p className="font-semibold text-gray-900">Cần cấp quyền truy cập Google Drive</p>
            <p className="text-sm text-gray-500 mt-1 mb-4 max-w-sm mx-auto">
              Phiên đăng nhập hiện tại chưa có quyền đọc Drive/Sheets, hoặc token đã hết hạn.
              Đăng nhập lại để cấp quyền.
            </p>
            <button
              onClick={() => void onReauth().then(() => load(""))}
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 rounded-xl text-sm font-semibold"
            >
              Cấp quyền Google Drive
            </button>
          </div>
        ) : (
          <>
            <div className="p-4 border-b border-gray-200">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void load(search.trim());
                }}
                className="relative"
              >
                <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Tìm theo tên tệp…"
                  className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </form>
            </div>

            <div className="max-h-[55vh] overflow-y-auto">
              {loading ? (
                <div className="p-10 text-center text-gray-500 text-sm">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-emerald-600" />
                  Đang tải danh sách tệp từ Google Drive…
                </div>
              ) : error ? (
                <div className="p-6 m-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-900">
                  <p className="font-semibold flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" /> {error.message}
                  </p>
                  {error.hint && <p className="text-xs mt-1">{error.hint}</p>}
                  <button
                    onClick={() => void onReauth().then(() => load(search))}
                    className="mt-3 text-xs font-semibold underline"
                  >
                    Thử đăng nhập lại để cấp quyền
                  </button>
                </div>
              ) : files.length === 0 ? (
                <div className="p-10 text-center text-sm text-gray-500">
                  Không tìm thấy bảng tính nào.
                </div>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {files.map((f) => (
                    <li key={f.id}>
                      <button
                        onClick={() => onSelect(f)}
                        className="w-full text-left px-4 py-3 hover:bg-emerald-50/50 flex items-center gap-3"
                      >
                        <FileSpreadsheet
                          className={`w-5 h-5 shrink-0 ${
                            f.mimeType === MIME_SHEET ? "text-emerald-600" : "text-blue-600"
                          }`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-gray-900 truncate">{f.name}</p>
                          <p className="text-xs text-gray-400">
                            {f.mimeType === MIME_SHEET ? "Google Sheets" : "Excel (.xlsx)"}
                            {" • "}
                            {new Date(f.modifiedTime).toLocaleDateString("vi-VN")}
                            {f.owners ? ` • ${f.owners}` : ""}
                          </p>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
