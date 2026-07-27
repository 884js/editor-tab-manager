import { useState, memo } from "react";
import { useTranslation } from "react-i18next";
import type { ClaudeStatus } from "../types/editor";
import { getColorById } from "../constants/tabColors";

const blend = (base: number, color: number, ratio: number) =>
  Math.round(base * (1 - ratio) + color * ratio);

interface TabProps {
  name: string;
  isActive: boolean;
  isOpen: boolean;
  hasOpenError: boolean;
  isDragging: boolean;
  onClick: (index: number, anchorRect: DOMRect) => void;
  onClose: (index: number) => void;
  onDragStart: (index: number) => void;
  onDragEnd: () => void;
  onDragOver: (index: number) => void;
  onDrop: (index: number) => void;
  index: number;
  claudeStatus?: ClaudeStatus;
  colorId?: string | null;
  onContextMenu?: (index: number, rect: DOMRect) => void;
  branch?: string;
}

const Tab = memo(function Tab({ name, isActive, isOpen, hasOpenError, isDragging, onClick, onClose, onDragStart, onDragEnd, onDragOver, onDrop, index, claudeStatus, colorId, onContextMenu, branch }: TabProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);

  const displayName = name || t("app.untitled");
  const shortcutKey = index < 9 ? `Cmd+${index + 1}` : "";

  // Calculate color styles for the tab
  const colorStyle: React.CSSProperties = {};
  const tabColor = getColorById(colorId);
  if (tabColor) {
    const { r, g, b: bl } = tabColor.rgb;
    if (isActive) {
      const base = 72; // #484848
      colorStyle.background = `rgb(${blend(base, r, 0.25)}, ${blend(base, g, 0.25)}, ${blend(base, bl, 0.25)})`;
    } else if (isHovered) {
      const base = 51; // #333333
      colorStyle.background = `rgb(${blend(base, r, 0.2)}, ${blend(base, g, 0.2)}, ${blend(base, bl, 0.2)})`;
    } else {
      const base = 37; // #252525
      colorStyle.background = `rgb(${blend(base, r, 0.15)}, ${blend(base, g, 0.15)}, ${blend(base, bl, 0.15)})`;
    }
  }

  return (
    <div
      style={{
        ...styles.tab,
        ...(isActive ? styles.tabActive : {}),
        ...(!isOpen ? styles.tabClosed : {}),
        ...(isHovered ? styles.tabHover : {}),
        ...(isDragging ? styles.tabDragging : {}),
        ...colorStyle,
      }}
      onClick={(event) => {
        setIsHovered(false);
        onClick(index, event.currentTarget.getBoundingClientRect());
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!isDragging) {
          const rect = e.currentTarget.getBoundingClientRect();
          onContextMenu?.(index, rect);
        }
      }}
      draggable
      onDragStart={(e) => {
        e.stopPropagation(); // Tauriのウィンドウドラッグを防止
        e.dataTransfer.setData("text/plain", index.toString());
        e.dataTransfer.effectAllowed = "move";
        onDragStart(index);
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver(index);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(index);
      }}
      title={!isOpen
        ? t("tabBar.closedTooltip", { name: displayName })
        : shortcutKey
          ? `${displayName} (${shortcutKey})`
          : displayName}
      data-tab-index={index}
    >
      {!isOpen && (
        <span
          aria-label={hasOpenError ? t("tabBar.openFailed") : t("tabBar.closedLabel")}
          title={hasOpenError ? t("tabBar.openFailed") : undefined}
          style={hasOpenError ? styles.errorIndicator : styles.closedIndicator}
        >
          {hasOpenError ? "!" : ""}
        </span>
      )}
      <div style={styles.tabTextContent}>
        <span style={styles.tabName}>{displayName}</span>
        {branch && (
          <span style={styles.branchName}>{"\u2387"} {branch}</span>
        )}
      </div>
      {claudeStatus === "waiting" && <div style={styles.badgeWaiting} />}
      {claudeStatus === "generating" && <div style={styles.badgeGenerating} className="pulse-animation" />}
      <button
        style={{
          ...styles.closeButton,
          opacity: isHovered || isActive ? 1 : 0,
        }}
        onClick={(e) => {
          e.stopPropagation();
          onClose(index);
        }}
        aria-label={t("tabBar.removeTooltip")}
        title={t("tabBar.removeTooltip")}
      >
        ×
      </button>
    </div>
  );
});

const styles: Record<string, React.CSSProperties> = {
  tab: {
    display: "flex",
    alignItems: "center",
    height: "32px",
    padding: "0 8px 0 12px",
    background: "#252525",
    borderBottom: "2px solid transparent",
    borderRadius: "6px 6px 0 0",
    cursor: "pointer",
    transition: "transform 0.15s ease-out, opacity 0.2s ease-out",
    maxWidth: "200px",
    minWidth: "80px",
    gap: "6px",
    flexShrink: 0,
  },
  tabActive: {
    background: "#484848",
    borderBottom: "2px solid #007aff",
  },
  tabClosed: {
    opacity: 0.55,
  },
  tabHover: {
    background: "#333333",
  },
  tabDragging: {
    opacity: 0.5,
  },
  tabTextContent: {
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    flex: 1,
    minWidth: 0,
  },
  tabName: {
    color: "rgba(255, 255, 255, 0.9)",
    fontSize: "12px",
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  branchName: {
    fontSize: "10px",
    color: "rgba(255, 255, 255, 0.5)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    lineHeight: "1.2",
  },
  closeButton: {
    width: "18px",
    height: "18px",
    border: "none",
    background: "transparent",
    color: "rgba(255, 255, 255, 0.6)",
    fontSize: "14px",
    cursor: "pointer",
    borderRadius: "3px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "opacity 0.15s, background 0.15s",
    flexShrink: 0,
  },
  closedIndicator: {
    width: "7px",
    height: "7px",
    border: "1px solid rgba(255, 255, 255, 0.65)",
    borderRadius: "50%",
    flexShrink: 0,
  },
  errorIndicator: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "12px",
    height: "12px",
    borderRadius: "50%",
    background: "#ff3b30",
    color: "#ffffff",
    fontSize: "9px",
    fontWeight: 700,
    flexShrink: 0,
  },
  badgeWaiting: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    backgroundColor: "#007aff",
    flexShrink: 0,
  },
  badgeGenerating: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    backgroundColor: "#ff3b30",
    flexShrink: 0,
  },
};

export default Tab;
