package handlers

import (
	"fmt"
	"net/http"

	"event-data-hub/internal/auth"
)

func (h *AppHandler) SearchEntities(w http.ResponseWriter, r *http.Request) {
	nlQuery := r.URL.Query().Get("q")
	orgID, _ := r.Context().Value(auth.UserOrgKey).(string)

	var sqlWhere string
	var sqlParams []interface{}
	var explanation string

	if nlQuery != "" && h.AI != nil {
		where, params, expl, err := h.AI.TranslateNLToSQL(r.Context(), nlQuery)
		if err == nil {
			sqlWhere = where
			sqlParams = params
			explanation = expl
		}
	}

	RenderJSON(w, http.StatusOK, map[string]interface{}{
		"query":          nlQuery,
		"org_id":         orgID,
		"sql_where":      sqlWhere,
		"sql_params":     sqlParams,
		"nl_explanation": explanation,
	})
}

func (h *AppHandler) GetEntityDetailDrawer(w http.ResponseWriter, r *http.Request) {
	entityID := r.URL.Query().Get("id")
	if entityID == "" {
		http.Error(w, "Missing entity id", http.StatusBadRequest)
		return
	}

	// Render HTMX HTML fragment for drawer content
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `
		<div class="p-6">
			<div class="flex items-center justify-between pb-4 border-b border-gray-200">
				<div>
					<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 mb-1">Thực thể Chuẩn</span>
					<h3 class="text-xl font-bold text-gray-900">Trần Minh Đức</h3>
					<p class="text-sm text-gray-500">Giám đốc Trung tâm Chuyển đổi số • Công ty Cổ phần Công nghệ VN</p>
				</div>
				<button onclick="document.getElementById('detail-drawer').classList.add('translate-x-full')" class="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
					<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
				</button>
			</div>

			<div class="mt-6 space-y-6">
				<div class="grid grid-cols-2 gap-4 text-sm bg-gray-50 p-4 rounded-xl border border-gray-100">
					<div>
						<span class="text-xs text-gray-400 uppercase font-semibold">Email chính</span>
						<p class="font-medium text-gray-800">duc.tm@vntech.com.vn</p>
					</div>
					<div>
						<span class="text-xs text-gray-400 uppercase font-semibold">Số điện thoại</span>
						<p class="font-medium text-gray-800">0912 345 678</p>
					</div>
					<div>
						<span class="text-xs text-gray-400 uppercase font-semibold">Số sự kiện tham gia</span>
						<p class="font-semibold text-emerald-600">4 sự kiện</p>
					</div>
					<div>
						<span class="text-xs text-gray-400 uppercase font-semibold">Số tệp nguồn hợp nhất</span>
						<p class="font-semibold text-blue-600">3 tệp dữ liệu</p>
					</div>
				</div>

				<div>
					<h4 class="text-sm font-semibold text-gray-900 mb-3">Lịch sử sự kiện & các bản ghi nguồn:</h4>
					<div class="space-y-3">
						<div class="p-3 bg-white border border-gray-200 rounded-lg shadow-2xs">
							<div class="flex items-center justify-between mb-1">
								<span class="text-xs font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded">Hội thảo AI & Automation 2025</span>
								<span class="text-xs text-gray-400">15/06/2025</span>
							</div>
							<p class="text-xs text-gray-600">Tên nguồn: <i>Tran Van Minh Duc</i> | Đơn vị: <i>VN Tech Corp</i></p>
						</div>
						<div class="p-3 bg-white border border-gray-200 rounded-lg shadow-2xs">
							<div class="flex items-center justify-between mb-1">
								<span class="text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">Diễn đàn Đổi mới Sáng tạo Quốc gia</span>
								<span class="text-xs text-gray-400">22/07/2025</span>
							</div>
							<p class="text-xs text-gray-600">Tên nguồn: <i>Trần Minh Đức</i> | Đơn vị: <i>Công ty CP Công nghệ VN</i></p>
						</div>
					</div>
				</div>
			</div>
		</div>
	`)
}
