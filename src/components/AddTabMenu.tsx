import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { EditorWindow, HistoryEntry } from "../App";

interface AddTabMenuProps {
  entries: HistoryEntry[];
  currentWindows: EditorWindow[];
  onNewWindow: () => void;
  onSelectHistory: (entry: HistoryEntry) => void;
  onClearHistory: () => void;
  onClose: () => void;
  anchorRef: RefObject<HTMLButtonElement | null>;
}

function formatRelativeTime(timestamp: number, t: (key: string, options?: Record<string, unknown>) => string): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return t("history.justNow");
  if (hours < 1) return t("history.minutesAgo", { count: minutes });
  if (days < 1) return t("history.hoursAgo", { count: hours });
  return t("history.daysAgo", { count: days });
}

function AddTabMenu({ entries, currentWindows, onNewWindow, onSelectHistory, onClearHistory, onClose, anchorRef }: AddTabMenuProps) {
  const { t } = useTranslation();
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Filter out currently open tabs from history
  const currentNames = new Set(currentWindows.map(w => w.name));
  const filteredEntries = entries.filter(e => !currentNames.has(e.name));

  // Calculate position from anchor button
  useEffect(() => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setMenuPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
  }, [anchorRef]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <>
      <div style={styles.overlay} onClick={onClose} />
      <div
        ref={menuRef}
        style={{
          ...styles.container,
          ...(menuPos ? { top: menuPos.top, right: menuPos.right } : { top: 40, right: 8 }),
        }}
      >
        {/* New Window */}
        <button
          style={styles.newWindowButton}
          onClick={() => {
            onNewWindow();
            onClose();
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "#3a3a3a";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <span style={styles.newWindowIcon}>+</span>
          <span>{t("history.newWindow")}</span>
        </button>

        {/* History section */}
        {filteredEntries.length > 0 && (
          <>
            <div style={styles.separator} />
            <div style={styles.sectionHeader}>{t("history.recentProjects")}</div>
            <div style={styles.historyList}>
              {filteredEntries.map((entry) => (
                <button
                  key={`${entry.bundleId}:${entry.path}`}
                  style={styles.historyItem}
                  onClick={() => {
                    onSelectHistory(entry);
                    onClose();
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "#3a3a3a";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <div style={styles.historyItemContent}>
                    <div style={styles.historyItemTop}>
                      <span style={styles.historyName}>{entry.name}</span>
                      <span style={styles.historyEditor}>{entry.editorName}</span>
                    </div>
                    <span style={styles.historyTime}>{formatRelativeTime(entry.timestamp, t)}</span>
                  </div>
                </button>
              ))}
            </div>
            <div style={styles.separator} />
            <button
              style={styles.clearButton}
              onClick={() => {
                onClearHistory();
                onClose();
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "#3a3a3a";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              {t("history.clear")}
            </button>
          </>
        )}

        {filteredEntries.length === 0 && (
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
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
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
    fontSize: "16px",
    color: "rgba(255, 255, 255, 0.7)",
    width: "20px",
    textAlign: "center" as const,
  },
  separator: {
    height: "1px",
    background: "#404040",
    margin: "0",
  },
  sectionHeader: {
    padding: "6px 12px 4px",
    fontSize: "11px",
    color: "rgba(255, 255, 255, 0.4)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
  },
  historyList: {
    overflowY: "auto" as const,
    maxHeight: "300px",
  },
  historyItem: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    padding: "6px 12px",
    border: "none",
    background: "transparent",
    color: "#e0e0e0",
    fontSize: "13px",
    cursor: "pointer",
    textAlign: "left",
  },
  historyItemContent: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "2px",
    width: "100%",
    overflow: "hidden",
  },
  historyItemTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
  },
  historyName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    flex: 1,
  },
  historyEditor: {
    fontSize: "11px",
    color: "rgba(255, 255, 255, 0.4)",
    flexShrink: 0,
  },
  historyTime: {
    fontSize: "11px",
    color: "rgba(255, 255, 255, 0.35)",
  },
  clearButton: {
    display: "flex",
    alignItems: "center",
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
    fontSize: "12px",
    color: "rgba(255, 255, 255, 0.35)",
    textAlign: "center" as const,
  },
};

export default AddTabMenu;
