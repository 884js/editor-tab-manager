import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { getColorById } from "../constants/tabColors";
import { EDITOR_DISPLAY_NAMES, type ClaudeStatus, type TabColorMap } from "../types/editor";
import { groupRepositoryTabs, type TabEntry } from "../utils/repositoryTabs";
import { getWindowScopedValue, legacyWindowKey } from "../utils/store";

interface GroupTabListProps {
  name: string;
  entries: TabEntry[];
  activeIndex: number;
  statuses: Map<number, ClaudeStatus | undefined>;
  tabColors?: TabColorMap;
  showBranch: boolean;
  anchorLeft: number;
  onTabClick: (index: number) => void;
  onCloseTab: (index: number) => void;
  onRequestClose: () => void;
  onTabContextMenu: (index: number, rect: DOMRect) => void;
  onRepositoryContextMenu: (
    repositoryId: string,
    indices: number[],
    preferredIndex: number,
    rect: DOMRect,
  ) => void;
  onDragStart: (index: number) => void;
  onDragEnd: () => void;
  onDragOver: (index: number) => void;
  onDrop: (index: number) => void;
  onRowCountChange: (rowCount: number) => Promise<void>;
}

const MENU_WIDTH = 360;

function getColorBorder(colorId?: string | null): React.CSSProperties {
  const color = getColorById(colorId);
  return color ? { borderLeftColor: color.hex } : {};
}

function GroupTabList({
  name,
  entries,
  activeIndex,
  statuses,
  tabColors,
  showBranch,
  anchorLeft,
  onTabClick,
  onCloseTab,
  onRequestClose,
  onTabContextMenu,
  onRepositoryContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onRowCountChange,
}: GroupTabListProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [expandedRepositories, setExpandedRepositories] = useState<Set<string>>(() => new Set());
  const items = groupRepositoryTabs(entries);
  const visibleRowCount = items.reduce(
    (count, item) => count + (
      item.type === "repository" && expandedRepositories.has(item.key)
        ? item.entries.length
        : 0
    ),
    items.length,
  );
  const left = Math.min(
    Math.max(8, anchorLeft),
    Math.max(8, window.innerWidth - MENU_WIDTH - 8),
  );

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onRequestClose();
    };
    document.addEventListener("mousedown", handlePointerDown, true);
    return () => document.removeEventListener("mousedown", handlePointerDown, true);
  }, [onRequestClose]);

  useEffect(() => {
    void onRowCountChange(visibleRowCount);
  }, [onRowCountChange, visibleRowCount]);

  const toggleRepository = (repositoryId: string) => {
    setExpandedRepositories((current) => {
      const next = new Set(current);
      if (next.has(repositoryId)) {
        next.delete(repositoryId);
      } else {
        next.add(repositoryId);
      }
      return next;
    });
  };

  const renderTabRow = ({ tab, originalIndex }: TabEntry, nested = false) => {
    const isActive = originalIndex === activeIndex;
    const status = statuses.get(originalIndex);
    const branchName = tab.branch || tab.name || t("app.untitled");
    const colorId = tabColors
      ? getWindowScopedValue(tabColors, tab, legacyWindowKey(tab)) ?? null
      : null;

    return (
      <div
        key={`${tab.bundle_id}:${tab.id}`}
        style={{
          ...styles.row,
          ...(nested ? styles.nestedRow : {}),
          ...(isActive ? styles.rowActive : {}),
        }}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData("text/plain", originalIndex.toString());
          event.dataTransfer.effectAllowed = "move";
          onDragStart(originalIndex);
        }}
        onDragEnd={onDragEnd}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          onDragOver(originalIndex);
        }}
        onDrop={(event) => {
          event.preventDefault();
          onDrop(originalIndex);
        }}
      >
        <button
          type="button"
          role="menuitem"
          aria-current={isActive ? "page" : undefined}
          data-tab-index={originalIndex}
          style={{
            ...styles.tabButton,
            ...getColorBorder(colorId),
          }}
          onClick={() => {
            onTabClick(originalIndex);
            onRequestClose();
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            onTabContextMenu(originalIndex, event.currentTarget.getBoundingClientRect());
          }}
        >
          {nested && <span aria-hidden="true" style={styles.branchIndicator}>⑂</span>}
          <span style={styles.tabText}>
            <span style={styles.tabName}>{nested ? branchName : tab.name || t("app.untitled")}</span>
            {!nested && showBranch && tab.branch && (
              <span style={styles.branchName}>⑂ {tab.branch}</span>
            )}
          </span>
          <span style={styles.editorName}>
            {EDITOR_DISPLAY_NAMES[tab.bundle_id] || tab.editor_name}
          </span>
          {status === "waiting" && <span style={styles.badgeWaiting} />}
          {status === "generating" && <span style={styles.badgeGenerating} className="pulse-animation" />}
        </button>
        <button
          type="button"
          style={styles.closeButton}
          onClick={() => onCloseTab(originalIndex)}
          aria-label={t("worktree.closeBranch", { branch: branchName })}
          title={t("tabBar.closeTooltip")}
        >
          ×
        </button>
      </div>
    );
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("group.tabList", { name })}
      style={{ ...styles.menu, left }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onRequestClose();
        }
      }}
    >
      {items.map((item) => {
        if (item.type === "tab") return renderTabRow(item.entry);

        const indices = item.entries.map((entry) => entry.originalIndex);
        const activeEntry = item.entries.find((entry) => entry.originalIndex === activeIndex);
        const isExpanded = expandedRepositories.has(item.key);
        const isParentActive = Boolean(activeEntry) && !isExpanded;
        const preferredIndex = activeEntry?.originalIndex ?? indices[0];
        const hasWaiting = item.entries.some(
          (entry) => statuses.get(entry.originalIndex) === "waiting",
        );
        const hasGenerating = item.entries.some(
          (entry) => statuses.get(entry.originalIndex) === "generating",
        );

        return (
          <div key={item.key} role="group" aria-label={item.name} style={styles.repositoryGroup}>
            <div style={{ ...styles.row, ...(isParentActive ? styles.rowActive : {}) }}>
              <button
                type="button"
                role="menuitem"
                aria-expanded={isExpanded}
                aria-current={isParentActive ? "page" : undefined}
                style={styles.tabButton}
                onClick={() => toggleRepository(item.key)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onRepositoryContextMenu(
                    item.key,
                    indices,
                    preferredIndex,
                    event.currentTarget.getBoundingClientRect(),
                  );
                }}
              >
                <span aria-hidden="true" style={styles.disclosureIcon}>
                  {isExpanded ? "▾" : "▸"}
                </span>
                <span style={styles.tabText}>
                  <span style={styles.tabName}>{item.name}</span>
                </span>
                <span style={styles.count}>{item.entries.length}</span>
                {hasGenerating && <span style={styles.badgeGenerating} className="pulse-animation" />}
                {!hasGenerating && hasWaiting && <span style={styles.badgeWaiting} />}
              </button>
            </div>
            {isExpanded && (
              <div style={styles.repositoryRows}>
                {item.entries.map((entry) => renderTabRow(entry, true))}
              </div>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

const badgeStyle: React.CSSProperties = {
  width: "8px",
  height: "8px",
  borderRadius: "50%",
  flexShrink: 0,
};

const styles: Record<string, React.CSSProperties> = {
  menu: {
    position: "fixed",
    top: "36px",
    width: `${MENU_WIDTH}px`,
    maxHeight: "400px",
    overflowY: "auto",
    padding: "4px",
    border: "1px solid rgba(255, 255, 255, 0.15)",
    borderRadius: "0 0 6px 6px",
    background: "#2d2d2d",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.5)",
    zIndex: 1001,
  },
  repositoryGroup: {
    padding: 0,
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
    fontVariantNumeric: "tabular-nums",
  },
  repositoryRows: {
    paddingLeft: "16px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    minHeight: "32px",
    borderRadius: "4px",
    overflow: "hidden",
  },
  rowActive: {
    background: "rgba(0, 122, 255, 0.18)",
  },
  nestedRow: {
    marginTop: "2px",
  },
  tabButton: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    flex: 1,
    height: "32px",
    padding: "0 8px",
    gap: "7px",
    border: "none",
    borderLeft: "3px solid transparent",
    borderRadius: "4px",
    background: "transparent",
    color: "rgba(255, 255, 255, 0.85)",
    cursor: "pointer",
    textAlign: "left",
  },
  branchIndicator: {
    color: "rgba(255, 255, 255, 0.4)",
    fontSize: "11px",
    flexShrink: 0,
  },
  disclosureIcon: {
    width: "10px",
    color: "rgba(255, 255, 255, 0.55)",
    fontSize: "10px",
    flexShrink: 0,
    textAlign: "center",
  },
  tabText: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
  },
  tabName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "12px",
  },
  branchName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "rgba(255, 255, 255, 0.5)",
    fontSize: "10px",
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

export default GroupTabList;
