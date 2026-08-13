import React from 'react';
import { StatsSummary } from '../types';
import { Users, Database, Layers, FileSpreadsheet } from 'lucide-react';

interface Props {
  stats: StatsSummary | null;
}

export const StatsOverview: React.FC<Props> = ({ stats }) => {
  if (!stats) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div className="bg-white p-5 rounded-2xl border border-gray-200/80 shadow-xs flex items-center space-x-4">
        <div className="w-12 h-12 bg-emerald-50 rounded-xl flex items-center justify-center text-emerald-600 shrink-0">
          <Users className="w-6 h-6" />
        </div>
        <div>
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Thực thể Chuẩn</span>
          <p className="text-2xl font-bold text-gray-900 mt-0.5">{stats.totalCanonicalEntities.toLocaleString()}</p>
          <span className="text-xs text-emerald-600 font-medium">Đã hợp nhất & chuẩn hóa</span>
        </div>
      </div>

      <div className="bg-white p-5 rounded-2xl border border-gray-200/80 shadow-xs flex items-center space-x-4">
        <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center text-blue-600 shrink-0">
          <Database className="w-6 h-6" />
        </div>
        <div>
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Bản ghi Nguồn thô</span>
          <p className="text-2xl font-bold text-gray-900 mt-0.5">{stats.totalRawRecords.toLocaleString()}</p>
          <span className="text-xs text-blue-600 font-medium">Lưu trữ không ghi đè</span>
        </div>
      </div>

      <div className="bg-white p-5 rounded-2xl border border-gray-200/80 shadow-xs flex items-center space-x-4">
        <div className="w-12 h-12 bg-teal-50 rounded-xl flex items-center justify-center text-teal-600 shrink-0">
          <Layers className="w-6 h-6" />
        </div>
        <div>
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Tỷ lệ Trùng lặp</span>
          <p className="text-2xl font-bold text-teal-700 mt-0.5">{stats.dedupRatePercent}%</p>
          <span className="text-xs text-teal-600 font-medium">Giảm nhiễu dữ liệu</span>
        </div>
      </div>

      <div className="bg-white p-5 rounded-2xl border border-gray-200/80 shadow-xs flex items-center space-x-4">
        <div className="w-12 h-12 bg-purple-50 rounded-xl flex items-center justify-center text-purple-600 shrink-0">
          <FileSpreadsheet className="w-6 h-6" />
        </div>
        <div>
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Tệp Nguồn Xử lý</span>
          <p className="text-2xl font-bold text-gray-900 mt-0.5">{stats.sourceFilesProcessed}</p>
          <span className="text-xs text-purple-600 font-medium">{stats.driveSheetsCount} Sheets • {stats.localUploadCount} XLSX/CSV</span>
        </div>
      </div>
    </div>
  );
};
