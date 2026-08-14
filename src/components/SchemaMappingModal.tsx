import React, { useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Check, Loader2, ShieldCheck, Sparkles } from "lucide-react";
import { CANONICAL_FIELD_OPTIONS, type PreviewPayload } from "../types";

interface Props {
  preview: PreviewPayload;
  isSubmitting: boolean;
  onConfirm: (mapping: Record<string, string>) => void;
  onClose: () => void;
}

function confidenceTone(c: number): string {
  if (c >= 0.85) return "bg-emerald-100 text-emerald-800";
  if (c >= 0.6) return "bg-amber-100 text-amber-800";
  return "bg-gray-100 text-gray-600";
}

export const SchemaMappingModal: React.FC<Props> = ({
  preview,
  isSubmitting,
  onConfirm,
  onClose,
}) => {
  const [mapping, setMapping] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      preview.headers.map((h) => [h, preview.mapping[h]?.canonical_field ?? "ignore"]),
    ),
  );

  const mappedCount = useMemo(
    () => Object.values(mapping).filter((v) => v !== "ignore").length,
    [mapping],
  );

  // A row needs a name or an email to identify anybody; without either mapped,
  // the import would skip every row. Catch it here rather than after upload.
  const hasIdentity = useMemo(
    () => Object.values(mapping).some((v) => v === "full_name" || v === "email"),
    [mapping],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 bg-gray-900/50 overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-4xl w-full border border-gray-200 my-8 overflow-hidden">
        <div className="bg-emerald-800 p-5 text-white flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-emerald-300" />
              Xác nhận ánh xạ cột
            </h3>
            <p className="text-sm text-emerald-100/90 mt-1">
              {preview.sourceName} • trang tính “{preview.sheetTitle}” • {preview.totalRows} dòng dữ liệu
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10" aria-label="Đóng">
            ✕
          </button>
        </div>

        {preview.mappingSource === "unavailable" ? (
          <div className="bg-amber-50 border-b border-amber-200 p-4 flex items-start gap-3 text-amber-900 text-sm">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Gemini chưa đề xuất được ánh xạ.</p>
              <p className="text-xs mt-0.5">
                Tất cả các cột đang để “Bỏ qua”. Vui lòng chọn thủ công trước khi nhập.
                {preview.mappingError ? ` (${preview.mappingError.slice(0, 160)})` : ""}
              </p>
            </div>
          </div>
        ) : (
          <div className="bg-emerald-50/70 border-b border-emerald-200 p-4 flex items-start gap-3 text-emerald-900 text-sm">
            <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            <p>
              <b>Gemini đề xuất</b> ánh xạ dưới đây. Không có dòng nào được lưu cho tới khi bạn xác nhận.
              Dữ liệu thô luôn được giữ nguyên bản, kể cả các cột đánh dấu “Bỏ qua”.
            </p>
          </div>
        )}

        <div className="p-5 max-h-[55vh] overflow-y-auto">
          <div className="border border-gray-200 rounded-xl divide-y divide-gray-100">
            {preview.headers.map((col, idx) => {
              const proposal = preview.mapping[col];
              const sample = preview.sampleRows.find((r) => (r[idx] ?? "").trim() !== "")?.[idx];
              return (
                <div key={col} className="p-3.5 flex flex-col md:flex-row md:items-center gap-3">
                  <div className="md:w-1/3 min-w-0">
                    <p className="font-semibold text-gray-900 text-sm truncate" title={col}>
                      {col}
                    </p>
                    <p className="text-xs text-gray-500 truncate italic">
                      {sample ? `Mẫu: “${sample}”` : "Không có dữ liệu mẫu"}
                    </p>
                  </div>

                  <ArrowRight className="w-4 h-4 text-gray-300 shrink-0 hidden md:block" />

                  <div className="flex-1 min-w-0">
                    <select
                      value={mapping[col]}
                      onChange={(e) => setMapping((prev) => ({ ...prev, [col]: e.target.value }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    >
                      {CANONICAL_FIELD_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    {proposal && proposal.confidence > 0 && (
                      <div className="flex items-center gap-2 mt-1.5">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[11px] font-semibold ${confidenceTone(proposal.confidence)}`}
                        >
                          {Math.round(proposal.confidence * 100)}%
                        </span>
                        <span className="text-[11px] text-gray-500 truncate" title={proposal.reasoning}>
                          {proposal.reasoning}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-gray-50 border-t border-gray-200 px-5 py-3.5 flex items-center justify-between gap-3">
          <div className="text-xs text-gray-500 min-w-0">
            <span>{mappedCount} / {preview.headers.length} cột được ánh xạ</span>
            {!hasIdentity && (
              <p className="text-red-600 font-medium mt-0.5">
                Cần ánh xạ ít nhất một cột sang “Họ và tên” hoặc “Email”.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 border border-gray-300 rounded-xl text-sm font-medium hover:bg-gray-100 disabled:opacity-50"
            >
              Hủy
            </button>
            <button
              onClick={() => onConfirm(mapping)}
              disabled={isSubmitting || !hasIdentity}
              className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2 rounded-xl text-sm font-bold disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Đang tạo vector &amp; đối chiếu…
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  Xác nhận &amp; nhập dữ liệu
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
