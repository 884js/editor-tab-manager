import { useState, memo } from "react";
import { useTranslation } from "react-i18next";
import type { ClaudeStatus } from "../App";
import { getColorById } from "../constants/tabColors";

const blend = (base: number, color: number, ratio: number) =>
  Math.round(base * (1 - ratio) + color * ratio);

interface TabProps {
  name: string;
  isActive: boolean;
  isDragging: boolean;
  onClick: (index: number) => void;
  onClose: (index: number) => void;
  onDragStart: (index: number) => void;
  onDragEnd: () => void;
  onDragOver: (index: number) => void;
  onDrop: (index: number) => void;
  index: number;
  claudeStatus?: ClaudeStatus;
  colorId?: string | null;
  onContextMenu?: (index: number) => void;
}

const Tab = memo(function Tab({ name, isActive, isDragging, onClick, onClose, onDragStart, onDragEnd, onDragOver, onDrop, index, claudeStatus, colorId, onContextMenu }: TabProps) {
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
        ...(isHovered ? styles.tabHover : {}),
        ...(isDragging ? styles.tabDragging : {}),
        ...colorStyle,
      }}
      onClick={() => {
        setIsHovered(false);
        onClick(index);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!isDragging) {
          onContextMenu?.(index);
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
      title={shortcutKey ? `${displayName} (${shortcutKey})` : displayName}
    >
      <span style={styles.tabName}>{displayName}</span>
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
        title={t("tabBar.closeTooltip")}
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
  },
  tabActive: {
    background: "#484848",
    borderBottom: "2px solid #007aff",
  },
  tabHover: {
    background: "#333333",
  },
  tabDragging: {
    opacity: 0.5,
  },
  tabName: {
    color: "rgba(255, 255, 255, 0.9)",
    fontSize: "12px",
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
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
