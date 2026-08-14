import React, { useState } from "react";
import {
  ArrowRightLeft,
  Building2,
  Calendar,
  Check,
  CheckCircle2,
  Loader2,
  Mail,
  Phone,
  Sparkles,
  User,
  X,
} from "lucide-react";
import type { MergeSuggestion } from "../types";

interface Props {
  suggestions: MergeSuggestion[];
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  onClose: () => void;
}

function pct(n: number): number {
  return Math.round(n * 100);
}

function confidenceTone(c: number): string {
  if (c >= 0.8) return "bg-emerald-600";
  if (c >= 0.6) return "bg-amber-500";
  return "bg-gray-400";
}

/** Highlights values that differ, so a reviewer's eye lands on the evidence. */
function FieldRow({
  Icon,
  label,
  left,
  right,
  side,
}: {
  Icon: React.ElementType;
  label: string;
  left: string;
  right: string;
  side: "left" | "right";
}) {
  const value = side === "left" ? left : right;
  const differs =
    left.trim().toLowerCase() !== right.trim().toLowerCase() && Boolean(left || right);
  return (
    <div className="flex items-start gap-2">
      <Icon className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" />
      <div className="min-w-0">
        <span className="text-[11px] text-gray-400 uppercase font-semibold">{label}</span>
        <p
          className={`text-sm break-words ${
            differs ? "text-amber-700 font-semibold" : "text-gray-800"
          }`}
        >
          {value || "—"}
        </p>
      </div>
    </div>
  );
}

export const MergeReviewModal: React.FC<Props> = ({
  suggestions,
  onApprove,
  onReject,
  onClose,
}) => {
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = async (id: string, fn: (id: string) => Promise<void>) => {
    setBusyId(id);
    try {
      await fn(id);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 bg-gray-900/50 overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-5xl w-full border border-gray-200 my-8 overflow-hidden">
        <div className="bg-blue-900 p-5 text-white flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold flex items-center gap-2">
              <ArrowRightLeft className="w-5 h-5 text-blue-300" />
              Duyệt hợp nhất thực thể
            </h3>
            <p className="text-sm text-blue-100/90 mt-1">
              Giai đoạn 1: truy hồi vector pgvector → Giai đoạn 2: Gemini đối chiếu. Không có cặp nào
              được hợp nhất nếu bạn không phê duyệt.
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10" aria-label="Đóng">
            ✕
          </button>
        </div>

        <div className="p-5 max-h-[70vh] overflow-y-auto space-y-4">
          {(suggestions ?? []).length === 0 ? (
            <div className="text-center py-12">
              <div className="w-14 h-14 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-3">
                <CheckCircle2 className="w-7 h-7" />
              </div>
              <h4 className="font-bold text-gray-900">Không còn gợi ý nào chờ duyệt</h4>
              <p className="text-sm text-gray-500 mt-1">
                Nhập thêm bảng tính để hệ thống tìm các bản ghi trùng lặp mới.
              </p>
            </div>
          ) : (
            (suggestions ?? []).map((s) => {
              const entity = s.canonicalEntity ?? {
                displayName: "Không rõ",
                primaryEmail: null,
                primaryPhone: null,
                primaryOrganization: null,
                primaryRole: null,
                eventCount: 0,
                sourceFileCount: 0,
              };
              const record = s.candidateRecord ?? {
                sourceName: "Nguồn không rõ",
                fullName: null,
                organization: null,
                roleTitle: null,
                email: null,
                phone: null,
                eventName: null,
                eventDate: null,
              };
              const busy = busyId === s.id;

              return (
                <div key={s.id} className="border border-gray-200 rounded-xl overflow-hidden">
                  {/* Reasoning + the two-stage score breakdown */}
                  <div className="bg-blue-50/70 border-b border-blue-100 p-4">
                    <div className="flex items-start gap-3">
                      <Sparkles className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-800 font-medium">{s.reasoning}</p>

                        <div className="flex flex-wrap items-center gap-3 mt-2.5">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] uppercase font-bold text-gray-500">
                              Tổng hợp
                            </span>
                            <div className="w-24 h-2 bg-gray-200 rounded-full overflow-hidden">
                              <div
                                className={`h-full ${confidenceTone(s.combinedConfidence)}`}
                                style={{ width: `${pct(s.combinedConfidence)}%` }}
                              />
                            </div>
                            <span className="text-xs font-bold text-gray-800">
                              {pct(s.combinedConfidence)}%
                            </span>
                          </div>

                          <span className="text-[11px] text-gray-500">
                            Vector: <b className="text-gray-700">{pct(s.vectorSimilarity)}%</b>
                          </span>
                          <span className="text-[11px] text-gray-500">
                            Gemini: <b className="text-gray-700">{pct(s.llmConfidence)}%</b>
                            {s.llmVerdict ? " (cùng người)" : " (chưa chắc)"}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-200">
                    <div className="p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2 py-1 rounded-full uppercase">
                          Thực thể chuẩn hiện có
                        </span>
                        <span className="text-[11px] text-gray-400">
                          {entity.eventCount} sự kiện • {entity.sourceFileCount} tệp
                        </span>
                      </div>
                      <FieldRow Icon={User} label="Tên" left={entity.displayName} right={record.fullName ?? ""} side="left" />
                      <FieldRow Icon={Building2} label="Đơn vị" left={entity.primaryOrganization ?? ""} right={record.organization ?? ""} side="left" />
                      <FieldRow Icon={User} label="Chức danh" left={entity.primaryRole ?? ""} right={record.roleTitle ?? ""} side="left" />
                      <FieldRow Icon={Mail} label="Email" left={entity.primaryEmail ?? ""} right={record.email ?? ""} side="left" />
                      <FieldRow Icon={Phone} label="Điện thoại" left={entity.primaryPhone ?? ""} right={record.phone ?? ""} side="left" />
                    </div>

                    <div className="p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold text-blue-700 bg-blue-50 px-2 py-1 rounded-full uppercase">
                          Bản ghi nguồn mới
                        </span>
                        <span className="text-[11px] text-gray-400 truncate max-w-[55%]" title={record.sourceName}>
                          {record.sourceName}
                        </span>
                      </div>
                      <FieldRow Icon={User} label="Tên" left={entity.displayName} right={record.fullName ?? ""} side="right" />
                      <FieldRow Icon={Building2} label="Đơn vị" left={entity.primaryOrganization ?? ""} right={record.organization ?? ""} side="right" />
                      <FieldRow Icon={User} label="Chức danh" left={entity.primaryRole ?? ""} right={record.roleTitle ?? ""} side="right" />
                      <FieldRow Icon={Mail} label="Email" left={entity.primaryEmail ?? ""} right={record.email ?? ""} side="right" />
                      <FieldRow Icon={Phone} label="Điện thoại" left={entity.primaryPhone ?? ""} right={record.phone ?? ""} side="right" />
                      <div className="flex items-start gap-2 pt-1 border-t border-gray-100">
                        <Calendar className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <span className="text-[11px] text-gray-400 uppercase font-semibold">Sự kiện</span>
                          <p className="text-sm text-gray-800 break-words">{record.eventName || "—"}</p>
                          {record.eventDate && (
                            <p className="text-xs text-gray-500">{record.eventDate}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="bg-gray-50 border-t border-gray-200 px-4 py-3 flex items-center justify-end gap-2">
                    <button
                      onClick={() => void act(s.id, onReject)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 px-4 py-2 border border-gray-300 rounded-xl text-sm font-medium hover:bg-gray-100 disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4 text-red-500" />}
                      Từ chối
                    </button>
                    <button
                      onClick={() => void act(s.id, onApprove)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2 rounded-xl text-sm font-bold disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      Phê duyệt hợp nhất
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="bg-gray-50 border-t border-gray-200 px-5 py-3 flex justify-end">
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
