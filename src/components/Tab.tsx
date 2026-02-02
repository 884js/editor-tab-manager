import { useState, memo } from "react";

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
}

const Tab = memo(function Tab({ name, isActive, isDragging, onClick, onClose, onDragStart, onDragEnd, onDragOver, onDrop, index }: TabProps) {
  const [isHovered, setIsHovered] = useState(false);

  const displayName = name || "Untitled";
  const shortcutKey = index < 9 ? `Cmd+${index + 1}` : "";

  return (
    <div
      style={{
        ...styles.tab,
        ...(isActive ? styles.tabActive : {}),
        ...(isHovered ? styles.tabHover : {}),
        ...(isDragging ? styles.tabDragging : {}),
      }}
      onClick={() => {
        setIsHovered(false);
        onClick(index);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
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
      <button
        style={{
          ...styles.closeButton,
          opacity: isHovered || isActive ? 1 : 0,
        }}
        onClick={(e) => {
          e.stopPropagation();
          onClose(index);
        }}
        title="閉じる (Cmd+W)"
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
    background: "rgba(255, 255, 255, 0.05)",
    borderRadius: "6px 6px 0 0",
    cursor: "pointer",
    transition: "transform 0.15s ease-out, opacity 0.2s ease-out",
    maxWidth: "200px",
    minWidth: "80px",
    gap: "6px",
  },
  tabActive: {
    background: "rgba(255, 255, 255, 0.18)",
  },
  tabHover: {
    background: "rgba(255, 255, 255, 0.12)",
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
};

export default Tab;
