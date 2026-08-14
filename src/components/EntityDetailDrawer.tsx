import React from "react";
import { CheckCircle2, FileText, Info, Loader2, X } from "lucide-react";
import type { CanonicalEntity, RawRecord } from "../types";

interface Props {
  entity: CanonicalEntity;
  records: RawRecord[];
  /** Canonical fields whose values disagree across the merged source records. */
  differingFields: string[];
  loading: boolean;
  onClose: () => void;
}

const FIELD_LABELS: Record<string, string> = {
  fullName: "Họ và tên",
  organization: "Đơn vị",
  roleTitle: "Chức danh",
  email: "Email",
  phone: "Điện thoại",
};

const SOURCE_LABELS: Record<string, string> = {
  google_sheets: "Google Sheets",
  google_drive_xlsx: "Drive (.xlsx)",
  local_upload: "Tải lên",
};

export const EntityDetailDrawer: React.FC<Props> = ({
  entity,
  records,
  differingFields,
  loading,
  onClose,
}) => {
  return (
    <div className="fixed inset-0 z-50 bg-gray-900/40 flex justify-end" onClick={onClose}>
      <div
        className="w-full max-w-2xl bg-white h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-emerald-800 p-5 text-white flex items-start justify-between shrink-0">
          <div className="min-w-0">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/20 text-emerald-100 border border-emerald-400/30 mb-2">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              Thực thể chuẩn
            </span>
            <h3 className="text-xl font-bold break-words">{entity.displayName}</h3>
            <p className="text-sm text-emerald-100/90 mt-0.5 break-words">
              {entity.primaryOrganization || "Chưa có đơn vị"}
              {entity.primaryRole ? ` • ${entity.primaryRole}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10" aria-label="Đóng">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <div className="grid grid-cols-2 gap-3 bg-gray-50 p-4 rounded-xl border border-gray-200 text-sm">
            <Field label="Email chính" value={entity.primaryEmail} />
            <Field label="Điện thoại" value={entity.primaryPhone} />
            <div>
              <span className="text-[11px] text-gray-400 uppercase font-semibold">Số sự kiện</span>
              <p className="font-bold text-emerald-700">{entity.eventCount}</p>
            </div>
            <div>
              <span className="text-[11px] text-gray-400 uppercase font-semibold">Tệp nguồn</span>
              <p className="font-bold text-blue-700">{entity.sourceFileCount}</p>
            </div>
          </div>

          {(differingFields ?? []).length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2.5">
              <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-sm text-amber-900">
                <p className="font-semibold">Các trường khác nhau giữa những bản ghi đã hợp nhất:</p>
                <p className="text-xs mt-0.5">
                  {(differingFields ?? []).map((f) => FIELD_LABELS[f] ?? f).join(", ")}. Đây là biến thể bình
                  thường giữa các tệp, nhưng cũng là dấu hiệu cần kiểm tra nếu bạn nghi ngờ hợp nhất sai.
                </p>
              </div>
            </div>
          )}

          <div>
            <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2.5 flex items-center gap-2">
              <FileText className="w-4 h-4 text-emerald-600" />
              Bản ghi nguồn ({(records ?? []).length})
            </h4>

            {loading ? (
              <div className="flex items-center gap-2 text-sm text-gray-500 p-4">
                <Loader2 className="w-4 h-4 animate-spin" /> Đang tải…
              </div>
            ) : (records ?? []).length === 0 ? (
              <p className="text-sm text-gray-400 italic p-4 bg-gray-50 rounded-xl border border-gray-200">
                Chưa có bản ghi nguồn nào liên kết.
              </p>
            ) : (
              <div className="space-y-2.5">
                {(records ?? []).map((rec) => (
                  <div key={rec.id} className="border border-gray-200 rounded-xl p-3.5 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <span className="inline-block px-2 py-0.5 rounded-md text-[11px] font-bold bg-blue-50 text-blue-700 truncate">
                        {SOURCE_LABELS[rec.sourceType] ?? rec.sourceType} • {rec.sourceName}
                      </span>
                      <span className="text-[11px] text-gray-400 shrink-0">
                        dòng {rec.rowNumber}
                      </span>
                    </div>

                    {rec.eventName && (
                      <p className="text-sm font-medium text-gray-800">
                        {rec.eventName}
                        {rec.eventDate && (
                          <span className="text-xs text-gray-400 font-normal ml-2">{rec.eventDate}</span>
                        )}
                        {!rec.eventDate && rec.eventDateRaw && (
                          <span
                            className="text-xs text-amber-600 font-normal ml-2"
                            title="Không phân tích được định dạng ngày; giá trị gốc được giữ nguyên"
                          >
                            {rec.eventDateRaw} (chưa nhận dạng)
                          </span>
                        )}
                      </p>
                    )}

                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs pt-2 border-t border-gray-100">
                      <SourceField label="Tên trong nguồn" value={rec.fullName} highlight={(differingFields ?? []).includes("fullName")} />
                      <SourceField label="Đơn vị" value={rec.organization} highlight={(differingFields ?? []).includes("organization")} />
                      <SourceField label="Chức danh" value={rec.roleTitle} highlight={(differingFields ?? []).includes("roleTitle")} />
                      <SourceField label="Email" value={rec.email} highlight={(differingFields ?? []).includes("email")} />
                      <SourceField label="Điện thoại" value={rec.phone} highlight={(differingFields ?? []).includes("phone")} />
                      {rec.notes && <SourceField label="Ghi chú" value={rec.notes} highlight={false} />}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="bg-gray-50 border-t border-gray-200 p-4 flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold text-sm rounded-xl"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
};

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <span className="text-[11px] text-gray-400 uppercase font-semibold">{label}</span>
      <p className="font-semibold text-gray-800 break-words">{value || "—"}</p>
    </div>
  );
}

function SourceField({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | null;
  highlight: boolean;
}) {
  return (
    <div className="min-w-0">
      <span className="text-gray-400">{label}:</span>{" "}
      <span className={`break-words ${highlight ? "text-amber-700 font-semibold" : "text-gray-800"}`}>
        {value || "—"}
      </span>
    </div>
  );
}
