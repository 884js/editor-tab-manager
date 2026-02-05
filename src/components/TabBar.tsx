import { useState, useCallback } from "react";
import Tab from "./Tab";
import type { EditorWindow } from "../App";

interface TabBarProps {
  tabs: EditorWindow[];
  activeIndex: number;
  onTabClick: (index: number) => void;
  onNewTab: () => void;
  onCloseTab: (index: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  badgeWindowNames?: Set<string>;
}

function TabBar({ tabs, activeIndex, onTabClick, onNewTab, onCloseTab, onReorder, badgeWindowNames }: TabBarProps) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  const handleDragStart = useCallback((index: number) => {
    setDraggedIndex(index);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
  }, []);

  const handleDragOver = useCallback((_index: number) => {
    // Could be used for visual feedback in the future
  }, []);

  // ドラッグ領域のマウスダウンハンドラ（タブバーウィンドウの移動は無効化）
  const handleDragAreaMouseDown = useCallback((_e: React.MouseEvent) => {
    // タブバーは画面上部に固定するため、ウィンドウのドラッグ移動は無効
  }, []);

  const handleDrop = useCallback((toIndex: number) => {
    if (draggedIndex !== null && draggedIndex !== toIndex) {
      onReorder(draggedIndex, toIndex);
    }
    setDraggedIndex(null);
  }, [draggedIndex, onReorder]);

  // Stable callback that receives index from Tab component
  const handleTabClick = useCallback((index: number) => {
    onTabClick(index);
  }, [onTabClick]);

  const handleCloseTab = useCallback((index: number) => {
    onCloseTab(index);
  }, [onCloseTab]);

  return (
    <div style={styles.container}>
      {/* ドラッグ領域を最背面に配置（全体をカバー） */}
      <div
        style={styles.dragLayer}
        onMouseDown={handleDragAreaMouseDown}
      />

      {/* タブはその上に配置 */}
      <div style={styles.tabsWrapper}>
        {tabs.map((tab, index) => (
          <Tab
            key={tab.name}
            name={tab.name}
            isActive={index === activeIndex}
            isDragging={index === draggedIndex}
            onClick={handleTabClick}
            onClose={handleCloseTab}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            index={index}
            hasBadge={badgeWindowNames?.has(tab.name)}
          />
        ))}
        <button
          style={styles.addButton}
          onClick={onNewTab}
          onMouseDown={(e) => e.stopPropagation()}
          title="新しいエディタウィンドウを開く (Cmd+Shift+T)"
        >
          +
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    alignItems: "center",
    height: "100%",
    width: "100%",
    background: "rgba(30, 30, 30, 0.95)",
    borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
    position: "relative",
  },
  dragLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 0,
    cursor: "grab",
  },
  tabsWrapper: {
    display: "flex",
    alignItems: "center",
    height: "100%",
    paddingLeft: "8px",
    paddingRight: "8px",
    gap: "2px",
    overflow: "hidden",
    position: "relative",
    zIndex: 1,
  },
  addButton: {
    width: "28px",
    height: "28px",
    border: "none",
    background: "transparent",
    color: "rgba(255, 255, 255, 0.6)",
    fontSize: "18px",
    cursor: "pointer",
    borderRadius: "4px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    transition: "background 0.15s, color 0.15s",
  },
};

export default TabBar;
