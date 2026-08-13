import React, { useState, useEffect } from 'react';
import { CanonicalEntity, MergeSuggestion, StatsSummary, DriveSourceFile } from './types';
import { StatsOverview } from './components/StatsOverview';
import { SchemaMappingModal } from './components/SchemaMappingModal';
import { MergeReviewModal } from './components/MergeReviewModal';
import { EntityDetailDrawer } from './components/EntityDetailDrawer';
import { DrivePickerModal } from './components/DrivePickerModal';
import {
  Upload,
  FileSpreadsheet,
  Search,
  Sparkles,
  GitMerge,
  ChevronRight,
  Database,
  Building2,
  Mail,
  Users,
  Filter,
  CheckCircle2,
  ShieldAlert,
} from 'lucide-react';

export default function App() {
  const [stats, setStats] = useState<StatsSummary | null>(null);
  const [entities, setEntities] = useState<CanonicalEntity[]>([]);
  const [mergeSuggestions, setMergeSuggestions] = useState<MergeSuggestion[]>([]);
  const [driveFiles, setDriveFiles] = useState<DriveSourceFile[]>([]);
  
  // UI Modals & Drawers
  const [showDrivePicker, setShowDrivePicker] = useState(false);
  const [showMergeReview, setShowMergeReview] = useState(false);
  const [selectedEntity, setSelectedEntity] = useState<CanonicalEntity | null>(null);
  const [entityRawRecords, setEntityRawRecords] = useState<any[]>([]);
  
  // Schema Mapping State
  const [schemaModalData, setSchemaModalData] = useState<{
    filename: string;
    sheetName: string;
    headers: string[];
    sampleRows: any[][];
    rawRows: any[][];
    mapping: Record<string, any>;
  } | null>(null);
  
  const [isSubmittingImport, setIsSubmittingImport] = useState(false);

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchingNL, setIsSearchingNL] = useState(false);
  const [nlExplanation, setNlExplanation] = useState<string | null>(null);

  // Load Initial Data
  useEffect(() => {
    fetchStats();
    fetchEntities();
    fetchMergeSuggestions();
    fetchDriveFiles();
  }, []);

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();
      setStats(data);
    } catch (e) {
      console.error('Failed to fetch stats', e);
    }
  };

  const fetchEntities = async () => {
    try {
      const res = await fetch('/api/entities');
      const data = await res.json();
      setEntities(data.entities || []);
    } catch (e) {
      console.error('Failed to fetch entities', e);
    }
  };

  const fetchMergeSuggestions = async () => {
    try {
      const res = await fetch('/api/merges');
      const data = await res.json();
      setMergeSuggestions(data.suggestions || []);
    } catch (e) {
      console.error('Failed to fetch merges', e);
    }
  };

  const fetchDriveFiles = async () => {
    try {
      const res = await fetch('/api/drive-sources');
      const data = await res.json();
      setDriveFiles(data.files || []);
    } catch (e) {
      console.error('Failed to fetch drive files', e);
    }
  };

  // Handle Natural Language Search via Gemini AI
  const handleNLSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      fetchEntities();
      setNlExplanation(null);
      return;
    }

    setIsSearchingNL(true);
    try {
      const res = await fetch('/api/ai/nl-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery }),
      });
      const data = await res.json();
      setEntities(data.entities || []);
      setNlExplanation(data.explanation || null);
    } catch (e) {
      console.error('NL Search failed', e);
    } finally {
      setIsSearchingNL(false);
    }
  };

  // Handle Local Spreadsheet File Upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload-excel', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();

      // Trigger Gemini AI Schema Mapping
      const mapRes = await fetch('/api/ai/schema-map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headers: data.headers,
          sampleRows: data.sampleRows,
        }),
      });
      const mapData = await mapRes.json();

      setSchemaModalData({
        filename: data.filename,
        sheetName: data.sheetName,
        headers: data.headers,
        sampleRows: data.sampleRows,
        rawRows: data.rawRows,
        mapping: mapData.mappings || {},
      });
    } catch (e) {
      alert('Tải lên tệp không thành công. Vui lòng kiểm tra định dạng .xlsx/.csv');
    }
  };

  // Confirm Schema Mapping and Execute Import
  const handleConfirmImport = async (confirmedMapping: Record<string, string>) => {
    if (!schemaModalData) return;
    setIsSubmittingImport(true);

    try {
      const res = await fetch('/api/import-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceName: schemaModalData.filename,
          sourceType: 'Local Upload',
          mapping: confirmedMapping,
          rawRows: schemaModalData.rawRows,
        }),
      });
      const data = await res.json();

      alert(data.message || 'Đã nhập thành công!');
      setSchemaModalData(null);
      fetchStats();
      fetchEntities();
      fetchMergeSuggestions();
    } catch (e) {
      alert('Có lỗi xảy ra khi lưu bản ghi');
    } finally {
      setIsSubmittingImport(false);
    }
  };

  // Select Drive Sheet File for Import
  const handleSelectDriveFile = async (driveFile: DriveSourceFile) => {
    setShowDrivePicker(false);
    // Simulate Drive Sheets header extraction & schema mapping
    const sampleHeaders = ['Họ và Tên', 'Đơn vị công tác', 'Vị trí', 'Email liên hệ', 'SĐT', 'Sự kiện tham dự'];
    const sampleRows = [
      ['TS. Vũ Hoàng Nam', 'Đại học Kinh tế Quốc dân', 'Trưởng khoa', 'nam.vh@neu.edu.vn', '0912 889 900', driveFile.name],
    ];

    const mapRes = await fetch('/api/ai/schema-map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        headers: sampleHeaders,
        sampleRows: sampleRows,
      }),
    });
    const mapData = await mapRes.json();

    setSchemaModalData({
      filename: driveFile.name,
      sheetName: 'Sheet1',
      headers: sampleHeaders,
      sampleRows: sampleRows,
      rawRows: sampleRows,
      mapping: mapData.mappings || {},
    });
  };

  // Open Entity Detail Drawer
  const handleOpenEntityDetail = async (entity: CanonicalEntity) => {
    setSelectedEntity(entity);
    try {
      const res = await fetch(`/api/entities/${entity.id}`);
      const data = await res.json();
      setEntityRawRecords(data.rawRecords || []);
    } catch (e) {
      console.error('Failed to fetch entity details', e);
    }
  };

  // Approve Merge Suggestion
  const handleApproveMerge = async (id: string) => {
    try {
      await fetch(`/api/merges/${id}/approve`, { method: 'POST' });
      fetchMergeSuggestions();
      fetchEntities();
      fetchStats();
    } catch (e) {
      console.error(e);
    }
  };

  // Reject Merge Suggestion
  const handleRejectMerge = async (id: string) => {
    try {
      await fetch(`/api/merges/${id}/reject`, { method: 'POST' });
      fetchMergeSuggestions();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans flex flex-col">
      {/* Top Navigation Bar */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between sticky top-0 z-30 shadow-xs">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-gradient-to-tr from-emerald-600 to-teal-500 rounded-xl flex items-center justify-center text-white font-bold text-lg shadow-xs">
            EDH
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900 leading-tight">Event Data Hub</h1>
            <p className="text-xs text-gray-500">Trung tâm Chuẩn hóa & Hợp nhất Dữ liệu Sự kiện</p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {mergeSuggestions.length > 0 && (
            <button
              onClick={() => setShowMergeReview(true)}
              className="inline-flex items-center space-x-2 bg-blue-50 hover:bg-blue-100 text-blue-800 border border-blue-200 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-colors animate-pulse"
            >
              <GitMerge className="w-4 h-4 text-blue-600" />
              <span>Duyệt {mergeSuggestions.length} gợi ý hợp nhất LLM</span>
            </button>
          )}

          <label className="inline-flex items-center space-x-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-xs font-bold cursor-pointer transition-colors shadow-2xs">
            <Upload className="w-4 h-4" />
            <span>Tải tệp Excel / CSV</span>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFileUpload} className="hidden" />
          </label>

          <button
            onClick={() => setShowDrivePicker(true)}
            className="inline-flex items-center space-x-2 bg-white hover:bg-gray-100 border border-gray-300 text-gray-800 px-4 py-2 rounded-xl text-xs font-bold transition-colors"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
            <span>Google Drive / Sheets</span>
          </button>
        </div>
      </header>

      {/* Main Layout Container */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar */}
        <aside className="w-64 bg-white border-r border-gray-200 p-5 space-y-6 shrink-0 hidden md:block">
          <div>
            <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Danh mục Thao tác</span>
            <nav className="mt-3 space-y-1">
              <a href="#" className="flex items-center px-3 py-2.5 text-sm font-semibold rounded-xl bg-emerald-50 text-emerald-800">
                <Database className="w-4 h-4 mr-3 text-emerald-600" />
                Thực thể Chuẩn
              </a>
              <button
                onClick={() => setShowMergeReview(true)}
                className="w-full flex items-center justify-between px-3 py-2.5 text-sm font-semibold rounded-xl text-gray-600 hover:bg-gray-50 hover:text-gray-900 text-left transition-colors"
              >
                <span className="flex items-center">
                  <GitMerge className="w-4 h-4 mr-3 text-blue-600" />
                  Hợp nhất LLM
                </span>
                {mergeSuggestions.length > 0 && (
                  <span className="bg-blue-600 text-white text-xs px-2 py-0.5 rounded-full font-bold">
                    {mergeSuggestions.length}
                  </span>
                )}
              </button>
            </nav>
          </div>

          <div className="pt-4 border-t border-gray-100 space-y-3">
            <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Công nghệ Google tích hợp</span>
            <div className="space-y-2 text-xs text-gray-600">
              <div className="flex items-center space-x-2 p-2 bg-gray-50 rounded-lg">
                <Sparkles className="w-4 h-4 text-purple-600 shrink-0" />
                <span><b>Gemini API</b> (Inference & Adjudication)</span>
              </div>
              <div className="flex items-center space-x-2 p-2 bg-gray-50 rounded-lg">
                <Database className="w-4 h-4 text-emerald-600 shrink-0" />
                <span><b>Vertex AI Embeddings</b> & pgvector</span>
              </div>
              <div className="flex items-center space-x-2 p-2 bg-gray-50 rounded-lg">
                <FileSpreadsheet className="w-4 h-4 text-blue-600 shrink-0" />
                <span><b>Google Drive & Sheets API</b></span>
              </div>
            </div>
          </div>
        </aside>

        {/* Main Workspace Area */}
        <main class="flex-1 overflow-y-auto p-6 md:p-8 space-y-8">
          <div className="max-w-7xl mx-auto space-y-8">
            {/* Stats Overview Panel */}
            <StatsOverview stats={stats} />

            {/* Search & Action Bar */}
            <div className="bg-white p-5 rounded-2xl border border-gray-200 shadow-xs space-y-4">
              <form onSubmit={handleNLSearch} className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <Search className="w-5 h-5 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder='Tìm kiếm tự nhiên (ví dụ: "chuyên gia AI tham gia sự kiện năm 2025" hoặc "FPT")...'
                    className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-hidden focus:ring-2 focus:ring-emerald-500 focus:bg-white transition-all"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isSearchingNL}
                  className="inline-flex items-center justify-center space-x-2 bg-emerald-800 hover:bg-emerald-900 text-white px-6 py-3 rounded-xl font-bold text-sm shadow-xs transition-colors shrink-0"
                >
                  <Sparkles className="w-4 h-4 text-emerald-300" />
                  <span>{isSearchingNL ? 'Gemini đang truy vấn...' : 'Tìm kiếm AI (NL-to-SQL)'}</span>
                </button>
              </form>

              {nlExplanation && (
                <div className="bg-emerald-50 border border-emerald-200 p-3 rounded-xl flex items-center space-x-2 text-xs text-emerald-800">
                  <Sparkles className="w-4 h-4 text-emerald-600 shrink-0" />
                  <p><b>Giải thích AI:</b> {nlExplanation}</p>
                </div>
              )}
            </div>

            {/* Canonical Entities Master Table */}
            <div className="bg-white rounded-2xl border border-gray-200 shadow-xs overflow-hidden">
              <div className="p-5 border-b border-gray-200 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Danh sách Thực thể Chuẩn (Canonical Entities)</h3>
                  <p className="text-xs text-gray-500 mt-0.5">Dữ liệu đã qua hai giai đoạn hợp nhất trùng lặp và liên kết dòng sự kiện</p>
                </div>
                <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-3 py-1 rounded-full">
                  {entities.length} Thực thể khả dụng
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-gray-50/80 border-b border-gray-200 text-xs uppercase font-bold text-gray-500 tracking-wider">
                      <th className="py-3.5 px-6">Thực thể / Họ và Tên</th>
                      <th className="py-3.5 px-6">Đơn vị & Chức danh</th>
                      <th className="py-3.5 px-6">Email & Liên hệ</th>
                      <th className="py-3.5 px-6 text-center">Số sự kiện</th>
                      <th className="py-3.5 px-6 text-center">Số tệp nguồn</th>
                      <th className="py-3.5 px-6 text-right">Hành động</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 text-sm">
                    {entities.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-12 text-center text-gray-500">
                          Không tìm thấy thực thể nào phù hợp với truy vấn.
                        </td>
                      </tr>
                    ) : (
                      entities.map((entity) => (
                        <tr
                          key={entity.id}
                          onClick={() => handleOpenEntityDetail(entity)}
                          className="hover:bg-emerald-50/30 cursor-pointer transition-colors"
                        >
                          <td className="py-4 px-6 font-bold text-gray-900">
                            <div className="flex items-center space-x-3">
                              <div className="w-8 h-8 bg-emerald-100 text-emerald-800 rounded-full flex items-center justify-center font-bold text-xs shrink-0">
                                {entity.displayName.charAt(0)}
                              </div>
                              <span>{entity.displayName}</span>
                            </div>
                          </td>

                          <td className="py-4 px-6">
                            <p className="font-semibold text-gray-800">{entity.primaryOrganization}</p>
                            <p className="text-xs text-gray-500">{entity.primaryRole}</p>
                          </td>

                          <td className="py-4 px-6 text-gray-600 text-xs">
                            <div className="space-y-0.5">
                              <p className="flex items-center space-x-1">
                                <Mail className="w-3.5 h-3.5 text-gray-400" />
                                <span>{entity.primaryEmail}</span>
                              </p>
                            </div>
                          </td>

                          <td className="py-4 px-6 text-center">
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-50 text-blue-700">
                              {entity.eventCount} sự kiện
                            </span>
                          </td>

                          <td className="py-4 px-6 text-center">
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700">
                              {entity.sourceFileCount} tệp nguồn
                            </span>
                          </td>

                          <td className="py-4 px-6 text-right">
                            <span className="inline-flex items-center text-xs font-bold text-emerald-700 group-hover:underline">
                              Chi tiết <ChevronRight className="w-4 h-4 ml-1" />
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* Modals & Drawers */}
      {schemaModalData && (
        <SchemaMappingModal
          filename={schemaModalData.filename}
          sheetName={schemaModalData.sheetName}
          headers={schemaModalData.headers}
          sampleRows={schemaModalData.sampleRows}
          rawRows={schemaModalData.rawRows}
          mapping={schemaModalData.mapping}
          onConfirm={handleConfirmImport}
          onClose={() => setSchemaModalData(null)}
          isSubmitting={isSubmittingImport}
        />
      )}

      {showMergeReview && (
        <MergeReviewModal
          suggestions={mergeSuggestions}
          onApprove={handleApproveMerge}
          onReject={handleRejectMerge}
          onClose={() => setShowMergeReview(false)}
        />
      )}

      {showDrivePicker && (
        <DrivePickerModal
          files={driveFiles}
          onSelectFile={handleSelectDriveFile}
          onClose={() => setShowDrivePicker(false)}
        />
      )}

      {selectedEntity && (
        <EntityDetailDrawer
          entity={selectedEntity}
          rawRecords={entityRawRecords}
          onClose={() => setSelectedEntity(null)}
        />
      )}
    </div>
  );
}
