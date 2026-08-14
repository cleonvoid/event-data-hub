import React from "react";
import { Database, FileSpreadsheet, GitMerge, Layers } from "lucide-react";
import type { StatsSummary } from "../types";

const SOURCE_LABELS: Record<string, string> = {
  google_sheets: "Google Sheets",
  google_drive_xlsx: "Drive (.xlsx)",
  local_upload: "Tải lên",
};

export const StatsOverview: React.FC<{ stats: StatsSummary | null }> = ({ stats }) => {
  if (!stats) {
    return (
      <section>
        <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Thống kê</h2>
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 bg-gray-100 rounded-lg animate-pulse" />
          ))}
        </div>
      </section>
    );
  }

  const rows = [
    { Icon: Layers, label: "Thực thể chuẩn", value: stats.totalCanonicalEntities, tone: "text-emerald-700" },
    { Icon: Database, label: "Bản ghi thô", value: stats.totalRawRecords, tone: "text-gray-900" },
    { Icon: FileSpreadsheet, label: "Tệp nguồn", value: stats.sourceFilesProcessed, tone: "text-gray-900" },
    { Icon: GitMerge, label: "Gợi ý chờ duyệt", value: stats.pendingMergeSuggestions, tone: "text-blue-700" },
  ];

  return (
    <section>
      <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Thống kê</h2>

      <div className="space-y-1.5">
        {rows.map(({ Icon, label, value, tone }) => (
          <div
            key={label}
            className="flex items-center justify-between px-3 py-2 rounded-lg border border-gray-100 bg-gray-50/60"
          >
            <span className="text-xs text-gray-600 flex items-center gap-2">
              <Icon className="w-3.5 h-3.5 text-gray-400" />
              {label}
            </span>
            <span className={`text-sm font-bold ${tone}`}>{value}</span>
          </div>
        ))}
      </div>

      <div className="mt-3 px-3 py-2.5 rounded-lg bg-emerald-50 border border-emerald-200">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-emerald-800 font-medium">Tỷ lệ hợp nhất</span>
          <span className="text-lg font-bold text-emerald-700">{stats.dedupRatePercent}%</span>
        </div>
        <p className="text-[11px] text-emerald-700/80 mt-0.5">
          {stats.totalRawRecords} bản ghi thô → {stats.totalCanonicalEntities} thực thể
        </p>
      </div>

      {(stats.bySourceType ?? []).length > 0 && (
        <div className="mt-3">
          <h3 className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">
            Theo loại nguồn
          </h3>
          <ul className="space-y-1">
            {(stats.bySourceType ?? []).map((s) => (
              <li key={s.sourceType} className="flex items-center justify-between text-xs text-gray-600">
                <span>{SOURCE_LABELS[s.sourceType] ?? s.sourceType}</span>
                <span className="text-gray-400">
                  {s.fileCount} tệp • {s.recordCount} dòng
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};
