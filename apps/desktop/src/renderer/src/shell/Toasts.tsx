import { Notification, Portal, Stack } from "@mantine/core";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Small notes over the page, in the bottom right (SH6): built from Mantine's Notification, so there is no new
 * dependency. A toast takes no focus and is announced politely. It stays until it is dismissed, so nothing the person
 * should read vanishes by itself; the newest three show.
 */

export interface Toast {
  id: number;
  text: string;
  tone: "done" | "info";
}

const ToastContext = createContext<(text: string, tone?: Toast["tone"]) => void>(() => undefined);

export function useToast() {
  return useContext(ToastContext);
}

const CHECK = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
const INFO = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const show = useCallback((text: string, tone: Toast["tone"] = "done") => {
    const id = next.current++;
    setToasts((current) => [...current, { id, text, tone }].slice(-3));
  }, []);
  const dismiss = (id: number) => setToasts((current) => current.filter((toast) => toast.id !== id));
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <Portal>
        <Stack
          gap={8}
          role="status"
          aria-live="polite"
          style={{ position: "fixed", right: 16, bottom: 16, zIndex: 400, maxWidth: "min(420px, calc(100vw - 32px))", pointerEvents: toasts.length ? undefined : "none" }}
          data-testid="toasts"
        >
          {toasts.map((toast) => (
            <Notification
              key={toast.id}
              icon={toast.tone === "done" ? CHECK : INFO}
              withBorder={false}
              // The region around them is the polite live region; a toast is never an alert.
              role="note"
              closeButtonProps={{ "aria-label": "Dismiss" }}
              onClose={() => dismiss(toast.id)}
              styles={{
                root: { background: "#0A0A0A", color: "#FFFFFF", boxShadow: "0 8px 24px rgba(10, 10, 10, 0.18)" },
                icon: { background: "transparent", color: "#FFFFFF" },
                description: { color: "#FFFFFF", fontSize: 13 },
                closeButton: { color: "#FFFFFF" },
              }}
              data-testid="toast"
            >
              {toast.text}
            </Notification>
          ))}
        </Stack>
      </Portal>
    </ToastContext.Provider>
  );
}
