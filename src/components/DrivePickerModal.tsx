import React from 'react';
import { DriveSourceFile } from '../types';
import { FileSpreadsheet, Download, RefreshCw, X } from 'lucide-react';

interface Props {
  files: DriveSourceFile[];
  onSelectFile: (file: DriveSourceFile) => void;
  onClose: () => void;
}

export const DrivePickerModal: React.FC<Props> = ({ files, onSelectFile, onClose }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-xs">
      <div className="bg-white rounded-2xl max-w-2xl w-full border border-gray-200 shadow-2xl overflow-hidden">
        <div className="bg-gradient-to-r from-emerald-700 to-teal-800 p-6 text-white flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <FileSpreadsheet className="w-6 h-6 text-emerald-300" />
            <div>
              <h3 className="text-xl font-bold">Chọn Bảng tính từ Google Drive</h3>
              <p className="text-sm text-emerald-100/90">Đã kết nối tài khoản Google Workspace của bạn</p>
            </div>
          </div>
          <button onClick={onClose} className="text-emerald-200 hover:text-white p-2 rounded-lg hover:bg-white/10">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 max-h-[60vh] overflow-y-auto divide-y divide-gray-100">
          {files.map((file) => (
            <div
              key={file.id}
              className="py-4 flex items-center justify-between hover:bg-emerald-50/50 px-3 rounded-xl transition-colors"
            >
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-emerald-100 text-emerald-700 rounded-lg flex items-center justify-center shrink-0">
                  <FileSpreadsheet className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-bold text-gray-900 text-sm">{file.name}</h4>
                  <p className="text-xs text-gray-500">
                    Cập nhật: {new Date(file.modifiedTime).toLocaleDateString('vi-VN')} • Ước tính ~{file.recordsEstimate} bản ghi
                  </p>
                </div>
              </div>

              <button
                onClick={() => onSelectFile(file)}
                className="inline-flex items-center space-x-1 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-xs font-bold transition-colors shadow-2xs"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Nhập Dữ liệu</span>
              </button>
            </div>
          ))}
        </div>

        <div className="bg-gray-50 border-t border-gray-200 px-6 py-4 flex justify-between items-center">
          <span className="text-xs text-gray-500">Tự động kết nối Google Drive & Sheets API</span>
          <button onClick={onClose} className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold text-xs rounded-xl">
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
};
