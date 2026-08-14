import React, { useCallback, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, X, XCircle } from "lucide-react";

export interface Toast {
  id: number;
  kind: "success" | "error" | "warn";
  message: string;
  detail?: string;
}

/**
 * Replaces the alert() calls the original used. alert() blocks the event loop,
 * cannot show a second message, and truncates nothing gracefully — a poor fit
 * for reporting Gemini/Drive errors that are often several sentences of
 * actionable detail.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { ...toast, id }]);
      // Errors stay until dismissed; successes clear themselves.
      if (toast.kind === "success") {
        setTimeout(() => dismiss(id), 6000);
      }
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}

const STYLES = {
  success: { wrap: "bg-emerald-50 border-emerald-200 text-emerald-900", Icon: CheckCircle2, icon: "text-emerald-600" },
  error: { wrap: "bg-red-50 border-red-200 text-red-900", Icon: XCircle, icon: "text-red-600" },
  warn: { wrap: "bg-amber-50 border-amber-200 text-amber-900", Icon: AlertTriangle, icon: "text-amber-600" },
} as const;

export const Toasts: React.FC<{ toasts: Toast[]; dismiss: (id: number) => void }> = ({
  toasts,
  dismiss,
}) => {
  if ((toasts ?? []).length === 0) return null;
  return (
    <div className="fixed top-4 right-4 z-[100] space-y-2 w-full max-w-md pointer-events-none">
      {(toasts ?? []).map((t) => {
        const style = STYLES[t.kind];
        const { Icon } = style;
        return (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto border rounded-xl px-4 py-3 flex items-start gap-3 ${style.wrap}`}
          >
            <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${style.icon}`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium break-words">{t.message}</p>
              {t.detail && <p className="text-xs opacity-80 mt-1 break-words">{t.detail}</p>}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="p-1 rounded hover:bg-black/5 shrink-0"
              aria-label="Đóng thông báo"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
