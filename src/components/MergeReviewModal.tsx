import React from 'react';
import { MergeSuggestion } from '../types';
import { Sparkles, Check, X, Building2, User, Mail, Phone, Calendar, ArrowRightLeft } from 'lucide-react';

interface Props {
  suggestions: MergeSuggestion[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onClose: () => void;
}

export const MergeReviewModal: React.FC<Props> = ({
  suggestions,
  onApprove,
  onReject,
  onClose,
}) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-5xl w-full border border-gray-200 shadow-2xl overflow-hidden my-8">
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-900 to-indigo-900 p-6 text-white flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-blue-500/20 rounded-xl border border-blue-400/30">
              <ArrowRightLeft className="w-6 h-6 text-blue-300" />
            </div>
            <div>
              <h3 className="text-xl font-bold">Trung tâm Duyệt Hợp nhất Trùng lặp (Entity Resolution)</h3>
              <p className="text-sm text-blue-100/90 mt-0.5">
                Quy trình 2 giai đoạn: Giai đoạn 1 (pgvector Cosine Retrieval) ➔ Giai đoạn 2 (Gemini LLM Adjudication)
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-blue-200 hover:text-white p-2 rounded-lg hover:bg-white/10"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-6 max-h-[70vh] overflow-y-auto space-y-6">
          {suggestions.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-4">
                <Check className="w-8 h-8" />
              </div>
              <h4 className="text-lg font-bold text-gray-900">Không có gợi ý hợp nhất nào chờ duyệt</h4>
              <p className="text-sm text-gray-500 mt-1 max-w-md mx-auto">
                Tất cả các bản ghi sự kiện nguồn đã được chuẩn hóa và hợp nhất thành công vào các thực thể chuẩn.
              </p>
            </div>
          ) : (
            suggestions.map((sug) => {
              const confPercent = Math.round(sug.confidenceScore * 100);

              return (
                <div
                  key={sug.id}
                  className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-xs hover:shadow-md transition-shadow"
                >
                  {/* AI Reasoning Banner */}
                  <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border-b border-blue-100 p-4 flex items-start space-x-3">
                    <Sparkles className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <div className="flex items-center space-x-3 mb-1">
                        <span className="text-xs font-bold uppercase text-blue-800 tracking-wider">
                          Đánh giá Gemini AI Stage 2
                        </span>
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-600 text-white">
                          Độ tin cậy: {confPercent}%
                        </span>
                      </div>
                      <p className="text-sm font-medium text-gray-800">{sug.reasoning}</p>
                    </div>
                  </div>

                  {/* Side-by-Side Comparison */}
                  <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-200 p-6 gap-6">
                    {/* Left: Existing Canonical Entity */}
                    <div className="space-y-4">
                      <div className="flex items-center justify-between pb-2 border-b border-gray-100">
                        <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full uppercase">
                          Thực thể Chuẩn Hiện có
                        </span>
                        <span className="text-xs text-gray-400">ID: {sug.canonicalEntity.id}</span>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-start space-x-2">
                          <User className="w-4 h-4 text-gray-400 shrink-0 mt-1" />
                          <div>
                            <span className="text-xs text-gray-400 uppercase">Tên hiển thị</span>
                            <p className="font-bold text-gray-900">{sug.canonicalEntity.displayName}</p>
                          </div>
                        </div>

                        <div className="flex items-start space-x-2">
                          <Building2 className="w-4 h-4 text-gray-400 shrink-0 mt-1" />
                          <div>
                            <span className="text-xs text-gray-400 uppercase">Đơn vị / Chức danh</span>
                            <p className="text-sm font-semibold text-gray-800">
                              {sug.canonicalEntity.primaryOrganization}
                            </p>
                            <p className="text-xs text-gray-500">{sug.canonicalEntity.primaryRole}</p>
                          </div>
                        </div>

                        <div className="flex items-start space-x-2">
                          <Mail className="w-4 h-4 text-gray-400 shrink-0 mt-1" />
                          <div>
                            <span className="text-xs text-gray-400 uppercase">Email liên hệ</span>
                            <p className="text-sm text-gray-700">{sug.canonicalEntity.primaryEmail}</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Right: Candidate Raw Record */}
                    <div className="space-y-4 pt-4 md:pt-0">
                      <div className="flex items-center justify-between pb-2 border-b border-gray-100">
                        <span className="text-xs font-bold text-blue-700 bg-blue-50 px-2.5 py-1 rounded-full uppercase">
                          Bản ghi Nguồn Mới Ingest
                        </span>
                        <span className="text-xs text-gray-400">Nguồn: {sug.candidateRecord.sourceName}</span>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-start space-x-2">
                          <User className="w-4 h-4 text-gray-400 shrink-0 mt-1" />
                          <div>
                            <span className="text-xs text-gray-400 uppercase">Họ và tên nguồn</span>
                            <p className="font-bold text-gray-900">{sug.candidateRecord.fullName}</p>
                          </div>
                        </div>

                        <div className="flex items-start space-x-2">
                          <Building2 className="w-4 h-4 text-gray-400 shrink-0 mt-1" />
                          <div>
                            <span className="text-xs text-gray-400 uppercase">Đơn vị / Chức danh</span>
                            <p className="text-sm font-semibold text-gray-800">
                              {sug.candidateRecord.organization}
                            </p>
                            <p className="text-xs text-gray-500">{sug.candidateRecord.roleTitle}</p>
                          </div>
                        </div>

                        <div className="flex items-start space-x-2">
                          <Calendar className="w-4 h-4 text-gray-400 shrink-0 mt-1" />
                          <div>
                            <span className="text-xs text-gray-400 uppercase">Sự kiện tham gia</span>
                            <p className="text-xs font-semibold text-gray-800">{sug.candidateRecord.eventName}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Approve / Reject Action Buttons */}
                  <div className="bg-gray-50 border-t border-gray-200 px-6 py-3 flex items-center justify-end space-x-3">
                    <button
                      onClick={() => onReject(sug.id)}
                      className="inline-flex items-center space-x-1.5 px-4 py-2 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors"
                    >
                      <X className="w-4 h-4 text-red-500" />
                      <span>Từ chối Hợp nhất</span>
                    </button>

                    <button
                      onClick={() => onApprove(sug.id)}
                      className="inline-flex items-center space-x-1.5 bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2 rounded-xl text-sm font-bold shadow-xs transition-colors"
                    >
                      <Check className="w-4 h-4" />
                      <span>Phê duyệt Hợp nhất</span>
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="bg-gray-50 border-t border-gray-200 px-6 py-4 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold text-sm rounded-xl transition-colors"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
};
