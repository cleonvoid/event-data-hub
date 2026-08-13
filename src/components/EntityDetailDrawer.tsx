import React from 'react';
import { CanonicalEntity, RawRecord } from '../types';
import { X, Building2, Mail, Phone, Calendar, FileText, CheckCircle2 } from 'lucide-react';

interface Props {
  entity: CanonicalEntity;
  rawRecords: RawRecord[];
  onClose: () => void;
}

export const EntityDetailDrawer: React.FC<Props> = ({
  entity,
  rawRecords,
  onClose,
}) => {
  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-gray-900/40 backdrop-blur-xs flex justify-end">
      <div className="w-full max-w-2xl bg-white h-full shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Drawer Header */}
        <div className="bg-gradient-to-r from-emerald-800 to-teal-900 p-6 text-white flex items-start justify-between">
          <div>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-200 border border-emerald-400/30 mb-2">
              <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
              Thực thể Chuẩn (Canonical Entity)
            </span>
            <h3 className="text-2xl font-bold">{entity.displayName}</h3>
            <p className="text-sm text-emerald-100/90 mt-1">{entity.primaryOrganization}</p>
          </div>
          <button
            onClick={onClose}
            className="text-emerald-200 hover:text-white p-2 rounded-lg hover:bg-white/10"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Primary Info Overview Grid */}
          <div className="grid grid-cols-2 gap-4 bg-gray-50 p-4 rounded-xl border border-gray-200 text-sm">
            <div>
              <span className="text-xs text-gray-400 uppercase font-semibold">Chức danh chính</span>
              <p className="font-semibold text-gray-800">{entity.primaryRole || '—'}</p>
            </div>
            <div>
              <span className="text-xs text-gray-400 uppercase font-semibold">Email chính</span>
              <p className="font-semibold text-gray-800">{entity.primaryEmail || '—'}</p>
            </div>
            <div>
              <span className="text-xs text-gray-400 uppercase font-semibold">Số sự kiện tham gia</span>
              <p className="font-bold text-emerald-600">{entity.eventCount} sự kiện</p>
            </div>
            <div>
              <span className="text-xs text-gray-400 uppercase font-semibold">Số tệp nguồn hợp nhất</span>
              <p className="font-bold text-blue-600">{entity.sourceFileCount} tệp dữ liệu</p>
            </div>
          </div>

          {/* Source Records Timeline */}
          <div>
            <h4 className="text-sm font-bold text-gray-900 uppercase tracking-wider mb-3 flex items-center space-x-2">
              <FileText className="w-4 h-4 text-emerald-600" />
              <span>Lịch sử các bản ghi nguồn hợp nhất:</span>
            </h4>

            <div className="space-y-3">
              {rawRecords.length === 0 ? (
                <div className="p-4 bg-gray-50 rounded-xl border border-gray-200 text-xs text-gray-500 italic">
                  Chưa có chi tiết bản ghi thô liên kết trực tiếp.
                </div>
              ) : (
                rawRecords.map((rec) => (
                  <div
                    key={rec.id}
                    className="p-4 bg-white border border-gray-200 rounded-xl shadow-2xs hover:border-emerald-300 transition-colors space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-bold bg-blue-50 text-blue-700">
                        {rec.sourceType} • {rec.sourceName}
                      </span>
                      <span className="text-xs text-gray-400">{rec.importedAt}</span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-gray-100">
                      <div>
                        <span className="text-gray-400">Tên trong nguồn:</span>
                        <p className="font-semibold text-gray-800">{rec.fullName}</p>
                      </div>
                      <div>
                        <span className="text-gray-400">Đơn vị ghi nhận:</span>
                        <p className="font-semibold text-gray-800">{rec.organization}</p>
                      </div>
                      <div>
                        <span className="text-gray-400">Sự kiện:</span>
                        <p className="font-medium text-gray-800">{rec.eventName}</p>
                      </div>
                      <div>
                        <span className="text-gray-400">Ghi chú:</span>
                        <p className="text-gray-600 italic truncate">{rec.notes || '—'}</p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Drawer Footer */}
        <div className="bg-gray-50 border-t border-gray-200 p-4 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold text-sm rounded-xl transition-colors"
          >
            Đóng Chi tiết
          </button>
        </div>
      </div>
    </div>
  );
};
