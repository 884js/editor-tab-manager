import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { EDITOR_DISPLAY_NAMES, type ClaudeStatus } from "../types/editor";
import type { TabEntry } from "../utils/repositoryTabs";

interface WorktreeTabProps {
  name: string;
  entries: TabEntry[];
  activeIndex: number;
  statuses: Map<number, ClaudeStatus | undefined>;
  onTabClick: (index: number) => void;
  onCloseTab: (index: number) => void;
  onMenuOpen: (rowCount: number) => Promise<void>;
  onMenuClose: () => Promise<void>;
  onContextMenu?: (indices: number[], preferredIndex: number, rect: DOMRect) => void;
}

const MENU_WIDTH = 280;

function WorktreeTab({
  name,
  entries,
  activeIndex,
  statuses,
  onTabClick,
  onCloseTab,
  onMenuOpen,
  onMenuClose,
  onContextMenu,
}: WorktreeTabProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 36 });
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isOpenRef = useRef(false);

  const activeEntry = entries.find((entry) => entry.originalIndex === activeIndex);
  const contextEntry = activeEntry ?? entries[0];
  const isActive = Boolean(activeEntry);
  const showEditorNames = new Set(entries.map((entry) => entry.tab.bundle_id)).size > 1;
  const hasWaiting = entries.some((entry) => statuses.get(entry.originalIndex) === "waiting");
  const hasGenerating = entries.some((entry) => statuses.get(entry.originalIndex) === "generating");

  const closeMenu = useCallback(() => {
    if (!isOpen) return;
    setIsOpen(false);
    void onMenuClose();
  }, [isOpen, onMenuClose]);

  const openMenu = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const maxLeft = Math.max(8, window.innerWidth - MENU_WIDTH - 8);
      setMenuPosition({ left: Math.min(Math.max(8, rect.left), maxLeft), top: rect.bottom });
    }
    if (!isOpen) {
      setIsOpen(true);
      void onMenuOpen(entries.length);
    }
  }, [entries.length, isOpen, onMenuOpen]);

  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => () => {
    if (isOpenRef.current) void onMenuClose();
  }, [onMenuClose]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      closeMenu();
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [closeMenu, contextEntry.tab.bundle_id, contextEntry.tab.repository_id, isOpen]);

  return (
    <div
      ref={rootRef}
      style={styles.root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && isOpen) {
          event.stopPropagation();
          closeMenu();
        }
      }}
      data-tab-index={isActive ? activeIndex : contextEntry.originalIndex}
    >
      <button
        type="button"
        style={{
          ...styles.tab,
          ...(isOpen && !isActive ? styles.tabHover : {}),
          ...(isActive ? styles.tabActive : {}),
        }}
        onClick={() => {
          if (isOpen) {
            closeMenu();
            return;
          }
          openMenu();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setIsOpen(false);
          onContextMenu?.(
            entries.map((entry) => entry.originalIndex),
            contextEntry.originalIndex,
            event.currentTarget.getBoundingClientRect(),
          );
        }}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={t("worktree.openBranches", { name })}
        title={t("worktree.openBranches", { name })}
      >
        <span style={styles.name}>{name}</span>
        <span style={styles.count}>{entries.length}</span>
        {hasGenerating && <span style={styles.badgeGenerating} className="pulse-animation" />}
        {!hasGenerating && hasWaiting && <span style={styles.badgeWaiting} />}
        <span aria-hidden="true" style={styles.chevron}>⌄</span>
      </button>

      {isOpen && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("worktree.branchList", { name })}
          data-worktree-menu={`${contextEntry.tab.bundle_id}:${contextEntry.tab.repository_id}`}
          style={{ ...styles.menu, left: menuPosition.left, top: menuPosition.top }}
        >
          {entries.map(({ tab, originalIndex }) => {
            const status = statuses.get(originalIndex);
            const branchName = tab.branch || tab.name || t("app.untitled");
            const rowActive = originalIndex === activeIndex;
            return (
              <div key={`${tab.bundle_id}:${tab.id}`} style={styles.row}>
                <button
                  type="button"
                  role="menuitem"
                  aria-current={rowActive ? "page" : undefined}
                  style={{ ...styles.branchButton, ...(rowActive ? styles.branchButtonActive : {}) }}
                  onClick={() => {
                    onTabClick(originalIndex);
                    closeMenu();
                  }}
                >
                  <span aria-hidden="true" style={styles.activeMarker}>{rowActive ? "●" : ""}</span>
                  <span style={styles.branchName}>⑂ {branchName}</span>
                  {showEditorNames && (
                    <span style={styles.editorName}>
                      {EDITOR_DISPLAY_NAMES[tab.bundle_id] || tab.editor_name}
                    </span>
                  )}
                  {status === "waiting" && <span style={styles.badgeWaiting} />}
                  {status === "generating" && <span style={styles.badgeGenerating} className="pulse-animation" />}
                </button>
                <button
                  type="button"
                  style={styles.closeButton}
                  onClick={() => {
                    onCloseTab(originalIndex);
                    if (entries.length === 2) closeMenu();
                  }}
                  aria-label={t("worktree.closeBranch", { branch: branchName })}
                  title={t("tabBar.closeTooltip")}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

const badgeStyle: React.CSSProperties = {
  width: "8px",
  height: "8px",
  borderRadius: "50%",
  flexShrink: 0,
};

const styles: Record<string, React.CSSProperties> = {
  root: {
    height: "32px",
    flexShrink: 0,
  },
  tab: {
    display: "flex",
    alignItems: "center",
    height: "32px",
    minWidth: "110px",
    maxWidth: "220px",
    padding: "0 10px 0 12px",
    gap: "7px",
    border: "none",
    borderBottom: "2px solid transparent",
    borderRadius: "6px 6px 0 0",
    background: "#252525",
    color: "rgba(255, 255, 255, 0.9)",
    cursor: "pointer",
  },
  tabActive: {
    background: "#484848",
    borderBottom: "2px solid #007aff",
  },
  tabHover: {
    background: "#333333",
  },
  name: {
    minWidth: 0,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "left",
    fontSize: "12px",
    fontWeight: 500,
  },
  count: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "18px",
    height: "18px",
    padding: "0 5px",
    borderRadius: "9px",
    background: "rgba(255, 255, 255, 0.12)",
    color: "rgba(255, 255, 255, 0.75)",
    fontSize: "10px",
    fontWeight: 600,
  },
  chevron: {
    color: "rgba(255, 255, 255, 0.55)",
    fontSize: "13px",
  },
  menu: {
    position: "fixed",
    width: `${MENU_WIDTH}px`,
    padding: "4px",
    border: "1px solid rgba(255, 255, 255, 0.15)",
    borderRadius: "6px",
    background: "#2d2d2d",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.5)",
    zIndex: 1001,
    maxHeight: "400px",
    overflowY: "auto",
  },
  row: {
    display: "flex",
    alignItems: "center",
    minHeight: "32px",
    borderRadius: "4px",
  },
  branchButton: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    flex: 1,
    height: "32px",
    padding: "0 8px",
    gap: "7px",
    border: "none",
    borderRadius: "4px",
    background: "transparent",
    color: "rgba(255, 255, 255, 0.85)",
    cursor: "pointer",
    textAlign: "left",
  },
  branchButtonActive: {
    background: "rgba(0, 122, 255, 0.18)",
    color: "#fff",
  },
  activeMarker: {
    width: "8px",
    color: "#007aff",
    fontSize: "8px",
    flexShrink: 0,
  },
  branchName: {
    minWidth: 0,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "12px",
  },
  editorName: {
    flexShrink: 0,
    color: "rgba(255, 255, 255, 0.5)",
    fontSize: "10px",
  },
  closeButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    padding: 0,
    border: "none",
    borderRadius: "4px",
    background: "transparent",
    color: "rgba(255, 255, 255, 0.6)",
    cursor: "pointer",
    fontSize: "14px",
  },
  badgeWaiting: {
    ...badgeStyle,
    backgroundColor: "#007aff",
  },
  badgeGenerating: {
    ...badgeStyle,
    backgroundColor: "#ff3b30",
  },
};

export default WorktreeTab;
