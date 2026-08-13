import React, { useState } from 'react';
import { Sparkles, Check, ArrowRight, ShieldCheck, AlertCircle } from 'lucide-react';

interface Props {
  filename: string;
  sheetName: string;
  headers: string[];
  sampleRows: any[][];
  rawRows: any[][];
  mapping: Record<string, { canonical_field: string; confidence: number; reasoning: string }>;
  onConfirm: (confirmedMapping: Record<string, string>) => void;
  onClose: () => void;
  isSubmitting: boolean;
}

const CANONICAL_FIELD_OPTIONS = [
  { value: 'full_name', label: 'Họ và tên (Full Name)' },
  { value: 'organization', label: 'Tên Đơn vị / Công ty (Organization)' },
  { value: 'role_title', label: 'Chức danh / Vai trò (Role/Title)' },
  { value: 'email', label: 'Địa chỉ Email' },
  { value: 'phone', label: 'Số điện thoại (Phone)' },
  { value: 'event_name', label: 'Tên Sự kiện (Event Name)' },
  { value: 'event_date', label: 'Ngày diễn ra (Event Date)' },
  { value: 'notes', label: 'Ghi chú / Bổ sung (Notes)' },
  { value: 'ignore', label: 'Bỏ qua cột này (Ignore)' },
];

export const SchemaMappingModal: React.FC<Props> = ({
  filename,
  sheetName,
  headers,
  sampleRows,
  mapping,
  onConfirm,
  onClose,
  isSubmitting,
}) => {
  const [userMapping, setUserMapping] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    headers.forEach((h) => {
      initial[h] = mapping[h]?.canonical_field || 'notes';
    });
    return initial;
  });

  const handleFieldChange = (col: string, val: string) => {
    setUserMapping((prev) => ({ ...prev, [col]: val }));
  };

  const handleConfirm = () => {
    onConfirm(userMapping);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-4xl w-full border border-gray-200 shadow-2xl overflow-hidden my-8">
        {/* Header */}
        <div className="bg-gradient-to-r from-emerald-800 to-teal-900 p-6 text-white flex items-center justify-between">
          <div>
            <div className="flex items-center space-x-2">
              <Sparkles className="w-5 h-5 text-emerald-300" />
              <h3 className="text-xl font-bold">Xác nhận Ánh xạ Schema bằng Gemini AI</h3>
            </div>
            <p className="text-sm text-emerald-100/90 mt-1">
              Tệp: <span className="font-semibold">{filename}</span> ({sheetName}) • Phân tích đề xuất cấu trúc tự động
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-emerald-200 hover:text-white p-2 rounded-lg hover:bg-white/10"
          >
            ✕
          </button>
        </div>

        {/* Warning Banner */}
        <div className="bg-amber-50 border-b border-amber-200 p-4 flex items-start space-x-3 text-amber-800 text-sm">
          <ShieldCheck className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <p>
            <b>Nguyên tắc an toàn:</b> Hệ thống hiển thị ánh xạ đề xuất để người dùng kiểm tra xác nhận trước khi lưu bản ghi. Dữ liệu thô sẽ luôn được giữ nguyên bản.
          </p>
        </div>

        {/* Column Mapping Grid */}
        <div className="p-6 max-h-[60vh] overflow-y-auto space-y-4">
          <h4 className="text-sm font-bold text-gray-800 uppercase tracking-wider">
            Chi tiết ánh xạ từ Cột nguồn sang Trường chuẩn:
          </h4>

          <div className="divide-y divide-gray-200 border border-gray-200 rounded-xl overflow-hidden bg-white">
            {headers.map((col, idx) => {
              const aiProp = mapping[col] || { canonical_field: 'notes', confidence: 0.8, reasoning: 'Mặc định ghi chú' };
              const currentVal = userMapping[col];
              const confPercent = Math.round((aiProp.confidence || 0.85) * 100);

              return (
                <div key={idx} className="p-4 hover:bg-gray-50/80 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="md:w-1/3">
                    <span className="text-xs font-semibold text-gray-400 uppercase">Cột Nguồn #{idx + 1}</span>
                    <p className="font-bold text-gray-900 text-base">{col}</p>
                    {sampleRows.length > 0 && (
                      <p className="text-xs text-gray-500 mt-1 italic truncate">
                        Mẫu: "{sampleRows[0][idx] || '—'}"
                      </p>
                    )}
                  </div>

                  <div className="flex items-center space-x-2 text-emerald-600 font-medium text-sm">
                    <ArrowRight className="w-4 h-4 shrink-0" />
                  </div>

                  <div className="md:w-1/2 flex flex-col space-y-2">
                    <div className="flex items-center justify-between">
                      <select
                        value={currentVal}
                        onChange={(e) => handleFieldChange(col, e.target.value)}
                        className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm font-medium text-gray-800 focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
                      >
                        {CANONICAL_FIELD_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center space-x-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
                        Độ tin cậy AI: {confPercent}%
                      </span>
                      <p className="text-xs text-gray-500 italic truncate" title={aiProp.reasoning}>
                        {aiProp.reasoning}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="bg-gray-50 border-t border-gray-200 px-6 py-4 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            Hủy bỏ
          </button>

          <button
            onClick={handleConfirm}
            disabled={isSubmitting}
            className="inline-flex items-center space-x-2 bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2.5 rounded-xl font-bold text-sm shadow-xs transition-colors disabled:opacity-50"
          >
            {isSubmitting ? (
              <span>Đang lưu bản ghi & tạo Vector...</span>
            ) : (
              <>
                <Check className="w-4 h-4" />
                <span>Xác nhận & Tiến hành Nhập Dữ liệu</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
