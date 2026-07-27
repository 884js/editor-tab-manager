import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { HistoryEntry } from "../types/editor";
import { normalizeProjectPath } from "../utils/store";

interface AddTabMenuProps {
  entries: HistoryEntry[];
  onNewWindow: (anchorRect: DOMRect) => Promise<void>;
  onSelectHistory: (entry: HistoryEntry, anchorRect: DOMRect) => Promise<void>;
  onClearHistory: () => void;
  onClose: () => Promise<void>;
  anchorRef: RefObject<HTMLButtonElement | null>;
}

function formatRelativeTime(
  timestamp: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return t("history.justNow");
  if (hours < 1) return t("history.minutesAgo", { count: minutes });
  if (days < 1) return t("history.hoursAgo", { count: hours });
  return t("history.daysAgo", { count: days });
}

function AddTabMenu({
  entries,
  onNewWindow,
  onSelectHistory,
  onClearHistory,
  onClose,
  anchorRef,
}: AddTabMenuProps) {
  const { t } = useTranslation();
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!anchorRef.current) return;

    const rect = anchorRef.current.getBoundingClientRect();
    const menuWidth = 280;
    const viewportPadding = 4;
    const left = Math.min(
      Math.max(viewportPadding, rect.right - menuWidth),
      window.innerWidth - menuWidth - viewportPadding,
    );
    setMenuPos({ top: rect.bottom + 4, left });
  }, [anchorRef]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <>
      <div style={styles.overlay} onClick={() => void onClose()} />
      <div
        ref={menuRef}
        style={{
          ...styles.container,
          ...(menuPos ? { top: menuPos.top, left: menuPos.left } : { top: 40, left: 8 }),
        }}
      >
        <button
          type="button"
          style={styles.newWindowButton}
          onClick={async (event) => {
            const anchorRect = event.currentTarget.getBoundingClientRect();
            await onClose();
            await onNewWindow(anchorRect);
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = "#3a3a3a";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = "transparent";
          }}
        >
          <span style={styles.newWindowIcon}>+</span>
          <span>{t("history.newWindow")}</span>
        </button>

        {entries.length > 0 ? (
          <>
            <div style={styles.separator} />
            <div style={styles.sectionHeader}>{t("history.recentProjects")}</div>
            <div style={styles.historyList}>
              {entries.map((entry) => (
                <button
                  key={normalizeProjectPath(entry.path)}
                  type="button"
                  style={styles.historyItem}
                  onClick={async (event) => {
                    const anchorRect = event.currentTarget.getBoundingClientRect();
                    await onClose();
                    await onSelectHistory(entry, anchorRect);
                  }}
                  onMouseEnter={(event) => {
                    event.currentTarget.style.background = "#3a3a3a";
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.background = "transparent";
                  }}
                >
                  <span style={styles.historyName}>{entry.name}</span>
                  <span style={styles.historyTime}>{formatRelativeTime(entry.timestamp, t)}</span>
                </button>
              ))}
            </div>
            <div style={styles.separator} />
            <button
              type="button"
              style={styles.clearButton}
              onClick={() => {
                onClearHistory();
                onClose();
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = "#3a3a3a";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = "transparent";
              }}
            >
              {t("history.clear")}
            </button>
          </>
        ) : (
          <>
            <div style={styles.separator} />
            <div style={styles.emptyText}>{t("history.empty")}</div>
          </>
        )}
      </div>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 100,
  },
  container: {
    position: "fixed",
    width: "280px",
    maxHeight: "400px",
    background: "#2d2d2d",
    border: "1px solid #404040",
    borderRadius: "8px",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.5)",
    zIndex: 101,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  newWindowButton: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    padding: "8px 12px",
    border: "none",
    background: "transparent",
    color: "#e0e0e0",
    fontSize: "13px",
    cursor: "pointer",
    textAlign: "left",
  },
  newWindowIcon: {
    width: "20px",
    color: "rgba(255, 255, 255, 0.7)",
    fontSize: "16px",
    textAlign: "center",
  },
  separator: {
    height: "1px",
    margin: 0,
    background: "#404040",
  },
  sectionHeader: {
    padding: "6px 12px 4px",
    color: "rgba(255, 255, 255, 0.4)",
    fontSize: "11px",
    textTransform: "uppercase",
  },
  historyList: {
    maxHeight: "300px",
    overflowY: "auto",
  },
  historyItem: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    width: "100%",
    padding: "6px 12px",
    border: "none",
    background: "transparent",
    color: "#e0e0e0",
    cursor: "pointer",
    textAlign: "left",
  },
  historyName: {
    overflow: "hidden",
    fontSize: "13px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  historyTime: {
    color: "rgba(255, 255, 255, 0.35)",
    fontSize: "11px",
  },
  clearButton: {
    width: "100%",
    padding: "8px 12px",
    border: "none",
    background: "transparent",
    color: "rgba(255, 255, 255, 0.5)",
    fontSize: "12px",
    cursor: "pointer",
    textAlign: "left",
  },
  emptyText: {
    padding: "12px",
    color: "rgba(255, 255, 255, 0.35)",
    fontSize: "12px",
    textAlign: "center",
  },
};

export default AddTabMenu;
