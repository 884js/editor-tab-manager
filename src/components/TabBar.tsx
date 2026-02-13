import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import Tab from "./Tab";
import ColorPicker from "./ColorPicker";
import type { EditorWindow, ClaudeStatus } from "../App";

interface TabBarProps {
  tabs: EditorWindow[];
  activeIndex: number;
  onTabClick: (index: number) => void;
  onNewTab: () => void;
  onCloseTab: (index: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  claudeStatuses?: Record<string, ClaudeStatus>;
  tabColors?: Record<string, string>;
  onColorChange?: (windowName: string, colorId: string | null) => void;
}

// フルパスからプロジェクト名を抽出してマッチング
const getClaudeStatusForTab = (tabName: string, statuses?: Record<string, ClaudeStatus>) => {
  if (!statuses) return undefined;
  for (const [fullPath, status] of Object.entries(statuses)) {
    const projectName = fullPath.split('/').pop();
    if (projectName === tabName) return status;
  }
  return undefined;
};

function TabBar({ tabs, activeIndex, onTabClick, onNewTab, onCloseTab, onReorder, claudeStatuses, tabColors, onColorChange }: TabBarProps) {
  const { t } = useTranslation();
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [colorPickerTarget, setColorPickerTarget] = useState<number | null>(null);

  const handleDragStart = useCallback((index: number) => {
    setDraggedIndex(index);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
  }, []);

  const handleDragOver = useCallback((_index: number) => {
    // Could be used for visual feedback in the future
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

  const handleTabContextMenu = useCallback((index: number, _e: React.MouseEvent) => {
    setColorPickerTarget(index);
  }, []);

  const handleColorSelect = useCallback((colorId: string | null) => {
    if (colorPickerTarget !== null) {
      const tab = tabs[colorPickerTarget];
      if (tab) {
        onColorChange?.(tab.name, colorId);
      }
    }
    setColorPickerTarget(null);
  }, [colorPickerTarget, tabs, onColorChange]);

  const handleColorPickerClose = useCallback(() => {
    setColorPickerTarget(null);
  }, []);

  return (
    <div style={styles.container}>
      {/* ドラッグ領域を最背面に配置（全体をカバー） */}
      <div style={styles.dragLayer} />

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
            claudeStatus={getClaudeStatusForTab(tab.name, claudeStatuses)}
            colorId={tabColors?.[tab.name] ?? null}
            onContextMenu={handleTabContextMenu}
          />
        ))}
        <button
          style={styles.addButton}
          onClick={onNewTab}
          onMouseDown={(e) => e.stopPropagation()}
          title={t("tabBar.newEditorTooltip")}
        >
          +
        </button>
      </div>

      {colorPickerTarget !== null && (
        <ColorPicker
          currentColorId={tabColors?.[tabs[colorPickerTarget]?.name] ?? null}
          onSelect={handleColorSelect}
          onClose={handleColorPickerClose}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    alignItems: "center",
    height: "100%",
    width: "100%",
    background: "#1e1e1e",
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
