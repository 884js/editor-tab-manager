import { useState, useCallback, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import Tab from "./Tab";
import ColorPicker from "./ColorPicker";
import AddTabMenu from "./AddTabMenu";
import type { EditorWindow, ClaudeStatus, HistoryEntry, GroupDefinition, GroupAssignment } from "../types/editor";
import { windowKey } from "../utils/store";
import { getColorById } from "../constants/tabColors";

interface TabBarProps {
  tabs: EditorWindow[];
  activeIndex: number;
  onTabClick: (index: number) => void;
  onNewTab: () => void;
  onCloseTab: (index: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onReorderByVisual: (visualOrder: number[]) => void;
  claudeStatuses?: Record<string, ClaudeStatus>;
  tabColors?: Record<string, string>;
  onColorChange?: (windowName: string, colorId: string | null) => void;
  showBranch?: boolean;
  history: HistoryEntry[];
  showAddMenu: boolean;
  onAddMenuOpen: () => void;
  onAddMenuClose: () => void;
  onHistorySelect: (entry: HistoryEntry) => void;
  onHistoryClear: () => void;
  onColorPickerOpen: () => Promise<void>;
  onColorPickerClose: () => void;
  groups: GroupDefinition[];
  groupAssignments: GroupAssignment;
  collapsedGroups: Set<string>;
  onAddGroup: (name: string) => string;
  onUpdateGroup: (groupId: string, name: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onAssignTabToGroup: (wKey: string, groupId: string) => void;
  onUnassignTabFromGroup: (wKey: string) => void;
  onToggleGroupCollapse: (groupId: string) => void;
  onReorderGroups: (fromIndex: number, toIndex: number) => void;
  groupColors: Record<string, string>;
  onSetGroupColor: (groupId: string, colorId: string | null) => void;
  onTabContextMenuOpen: () => Promise<void>;
  onTabContextMenuClose: () => Promise<void>;
}

// フルパスからプロジェクト名を抽出してマッチング
const toRgba = (rgb: { r: number; g: number; b: number }, alpha: number) =>
  `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;

const getClaudeStatusForTab = (tabName: string, statuses?: Record<string, ClaudeStatus>) => {
  if (!statuses) return undefined;
  for (const [fullPath, status] of Object.entries(statuses)) {
    const projectName = fullPath.split('/').pop();
    if (projectName === tabName) return status;
  }
  return undefined;
};

function TabBar(props: TabBarProps) {
  const { tabs, activeIndex, onTabClick, onNewTab, onCloseTab, onReorder, onReorderByVisual, claudeStatuses, tabColors, onColorChange, showBranch, history, showAddMenu, onAddMenuOpen, onAddMenuClose, onHistorySelect, onHistoryClear, onColorPickerOpen, onColorPickerClose, groups, groupAssignments, collapsedGroups, onAddGroup, onUpdateGroup, onDeleteGroup, onAssignTabToGroup, onUnassignTabFromGroup, onToggleGroupCollapse, onReorderGroups, groupColors, onSetGroupColor, onTabContextMenuOpen, onTabContextMenuClose } = props;
  const { t } = useTranslation();
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [colorPickerTarget, setColorPickerTarget] = useState<number | null>(null);
  const [colorPickerAnchorLeft, setColorPickerAnchorLeft] = useState<number>(0);
  const [groupLabelMenu, setGroupLabelMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [draggedGroupIndex, setDraggedGroupIndex] = useState<number | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{ index: number; x: number; y: number; rect: DOMRect } | null>(null);
  const [groupSubmenuOpen, setGroupSubmenuOpen] = useState(false);
  const [newGroupInput, setNewGroupInput] = useState<string | null>(null);
  const [groupColorPickerTarget, setGroupColorPickerTarget] = useState<string | null>(null);
  const [groupColorPickerAnchorLeft, setGroupColorPickerAnchorLeft] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const handleDragStart = useCallback((index: number) => {
    setDraggedIndex(index);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
  }, []);

  const handleDragOver = useCallback((_index: number) => {
    // Could be used for visual feedback in the future
  }, []);

  // Stable callback that receives index from Tab component
  const handleTabClick = useCallback((index: number) => {
    onTabClick(index);
  }, [onTabClick]);

  const handleCloseTab = useCallback((index: number) => {
    onCloseTab(index);
  }, [onCloseTab]);

  const handleTabContextMenu = useCallback(async (index: number, rect: DOMRect) => {
    await onTabContextMenuOpen();
    setTabContextMenu({ index, x: rect.left, y: rect.bottom, rect });
  }, [onTabContextMenuOpen]);

  const handleOpenColorPicker = useCallback(async () => {
    if (tabContextMenu && containerRef.current) {
      const containerRect = containerRef.current.getBoundingClientRect();
      const rect = tabContextMenu.rect;
      setColorPickerAnchorLeft(rect.left - containerRect.left + rect.width / 2);
      const idx = tabContextMenu.index;
      // Clear context menu state without resizing window (ColorPicker will resize)
      setTabContextMenu(null);
      setGroupSubmenuOpen(false);
      setNewGroupInput(null);
      await onColorPickerOpen();
      setColorPickerTarget(idx);
    }
  }, [tabContextMenu, onColorPickerOpen]);

  const handleColorSelect = useCallback((colorId: string | null) => {
    if (colorPickerTarget !== null) {
      const tab = tabs[colorPickerTarget];
      if (tab) {
        onColorChange?.(tab.name, colorId);
      }
    }
    setColorPickerTarget(null);
    onColorPickerClose();
  }, [colorPickerTarget, tabs, onColorChange, onColorPickerClose]);

  const handleColorPickerClose = useCallback(() => {
    setColorPickerTarget(null);
    onColorPickerClose();
  }, [onColorPickerClose]);

  const closeTabContextMenu = useCallback(() => {
    setTabContextMenu(null);
    setGroupSubmenuOpen(false);
    setNewGroupInput(null);
    onTabContextMenuClose();
  }, [onTabContextMenuClose]);

  const handleAssignToGroup = useCallback((groupId: string) => {
    if (tabContextMenu) {
      const tab = tabs[tabContextMenu.index];
      if (tab) {
        onAssignTabToGroup(windowKey(tab), groupId);
      }
    }
    closeTabContextMenu();
  }, [tabContextMenu, tabs, onAssignTabToGroup, closeTabContextMenu]);

  const handleUnassignFromGroup = useCallback(() => {
    if (tabContextMenu) {
      const tab = tabs[tabContextMenu.index];
      if (tab) {
        onUnassignTabFromGroup(windowKey(tab));
      }
    }
    closeTabContextMenu();
  }, [tabContextMenu, tabs, onUnassignTabFromGroup, closeTabContextMenu]);

  const handleCreateNewGroup = useCallback(() => {
    if (newGroupInput !== null && newGroupInput.trim() && tabContextMenu) {
      const groupId = onAddGroup(newGroupInput.trim());
      const tab = tabs[tabContextMenu.index];
      if (tab) {
        onAssignTabToGroup(windowKey(tab), groupId);
      }
    }
    setNewGroupInput(null);
    closeTabContextMenu();
  }, [newGroupInput, onAddGroup, tabContextMenu, tabs, onAssignTabToGroup, closeTabContextMenu]);

  // Group label context menu
  const handleGroupLabelContextMenu = useCallback(async (e: React.MouseEvent, groupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    await onTabContextMenuOpen();
    setGroupLabelMenu({ groupId, x: e.clientX, y: e.clientY });
  }, [onTabContextMenuOpen]);

  const closeGroupLabelMenu = useCallback(() => {
    setGroupLabelMenu(null);
    onTabContextMenuClose();
  }, [onTabContextMenuClose]);

  const handleGroupRename = useCallback((groupId: string) => {
    const group = groups.find((g) => g.id === groupId);
    if (group) {
      setEditingGroupId(groupId);
      setEditingGroupName(group.name);
    }
    closeGroupLabelMenu();
  }, [groups, closeGroupLabelMenu]);

  const handleGroupRenameSubmit = useCallback(() => {
    if (editingGroupId && editingGroupName.trim()) {
      onUpdateGroup(editingGroupId, editingGroupName.trim());
    }
    setEditingGroupId(null);
    setEditingGroupName("");
  }, [editingGroupId, editingGroupName, onUpdateGroup]);

  const handleGroupDelete = useCallback((groupId: string) => {
    onDeleteGroup(groupId);
    closeGroupLabelMenu();
  }, [onDeleteGroup, closeGroupLabelMenu]);

  const handleOpenGroupColorPicker = useCallback(async (groupId: string) => {
    if (groupLabelMenu && containerRef.current) {
      const containerRect = containerRef.current.getBoundingClientRect();
      setGroupColorPickerAnchorLeft(groupLabelMenu.x - containerRect.left);
    }
    setGroupLabelMenu(null);
    await onColorPickerOpen();
    setGroupColorPickerTarget(groupId);
  }, [onColorPickerOpen, groupLabelMenu]);

  const handleGroupColorSelect = useCallback((colorId: string | null) => {
    if (groupColorPickerTarget) {
      onSetGroupColor(groupColorPickerTarget, colorId);
    }
    setGroupColorPickerTarget(null);
    onColorPickerClose();
  }, [groupColorPickerTarget, onSetGroupColor, onColorPickerClose]);

  const handleGroupColorPickerClose = useCallback(() => {
    setGroupColorPickerTarget(null);
    onColorPickerClose();
  }, [onColorPickerClose]);

  // Group label drag & drop
  const handleGroupDragStart = useCallback((e: React.DragEvent, index: number) => {
    e.dataTransfer.effectAllowed = "move";
    setDraggedGroupIndex(index);
  }, []);

  const handleGroupDragEnd = useCallback(() => {
    setDraggedGroupIndex(null);
  }, []);

  const handleGroupDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    if (draggedGroupIndex !== null && draggedGroupIndex !== toIndex) {
      onReorderGroups(draggedGroupIndex, toIndex);
    }
    setDraggedGroupIndex(null);
  }, [draggedGroupIndex, onReorderGroups]);

  // Build grouped tab structure (memoized)
  const { sortedGroups, groupedTabsMap, ungroupedTabs, visualOrder, originalToVisual } = useMemo(() => {
    const sorted = [...groups].sort((a, b) => a.order - b.order);
    const groupIds = new Set(groups.map((g) => g.id));
    const grouped = new Map<string, { tab: EditorWindow; originalIndex: number }[]>();
    const ungrouped: { tab: EditorWindow; originalIndex: number }[] = [];

    tabs.forEach((tab, index) => {
      const wKey = windowKey(tab);
      const groupId = groupAssignments[wKey];
      if (groupId && groupIds.has(groupId)) {
        if (!grouped.has(groupId)) {
          grouped.set(groupId, []);
        }
        grouped.get(groupId)!.push({ tab, originalIndex: index });
      } else {
        ungrouped.push({ tab, originalIndex: index });
      }
    });

    // Build visual order: flat array of originalIndex in display order
    const visualOrder: number[] = [];
    for (const group of sorted) {
      const groupTabs = grouped.get(group.id);
      if (groupTabs) {
        for (const { originalIndex } of groupTabs) {
          visualOrder.push(originalIndex);
        }
      }
    }
    for (const { originalIndex } of ungrouped) {
      visualOrder.push(originalIndex);
    }

    // Map from originalIndex -> visualIndex
    const originalToVisual = new Map<number, number>();
    visualOrder.forEach((origIdx, visIdx) => {
      originalToVisual.set(origIdx, visIdx);
    });

    return { sortedGroups: sorted, groupedTabsMap: grouped, ungroupedTabs: ungrouped, visualOrder, originalToVisual };
  }, [groups, tabs, groupAssignments]);

  const handleDrop = useCallback((toOriginalIndex: number) => {
    if (draggedIndex !== null && draggedIndex !== toOriginalIndex) {
      const hasGroups = groups.length > 0;
      if (!hasGroups) {
        onReorder(draggedIndex, toOriginalIndex);
      } else {
        const fromVisual = originalToVisual.get(draggedIndex);
        const toVisual = originalToVisual.get(toOriginalIndex);
        if (fromVisual !== undefined && toVisual !== undefined) {
          const newVisual = [...visualOrder];
          const [moved] = newVisual.splice(fromVisual, 1);
          newVisual.splice(toVisual, 0, moved);
          onReorderByVisual(newVisual);
        }
      }
    }
    setDraggedIndex(null);
  }, [draggedIndex, groups.length, onReorder, onReorderByVisual, originalToVisual, visualOrder]);

  const renderTab = (tab: EditorWindow, originalIndex: number) => (
    <Tab
      key={`${tab.bundle_id}:${tab.id}`}
      name={tab.name}
      isActive={originalIndex === activeIndex}
      isDragging={originalIndex === draggedIndex}
      onClick={handleTabClick}
      onClose={handleCloseTab}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      index={originalIndex}
      claudeStatus={getClaudeStatusForTab(tab.name, claudeStatuses)}
      colorId={tabColors?.[tab.name] ?? null}
      onContextMenu={handleTabContextMenu}
      branch={showBranch !== false ? tab.branch : undefined}
    />
  );

  return (
    <div ref={containerRef} style={styles.container}>
      {/* ドラッグ領域を最背面に配置（全体をカバー） */}
      <div style={styles.dragLayer} />

      {/* タブはその上に配置 */}
      <div style={styles.tabsWrapper}>
        {sortedGroups.map((group, groupIndex) => {
          const groupTabs = groupedTabsMap.get(group.id) || [];
          const isCollapsed = collapsedGroups.has(group.id);
          const groupColor = getColorById(groupColors[group.id]);
          const groupContainerStyle: React.CSSProperties = {
            ...styles.groupContainer,
            ...(groupColor ? {
              background: toRgba(groupColor.rgb, 0.1),
              border: `1px solid ${toRgba(groupColor.rgb, 0.25)}`,
            } : {}),
          };

          return (
            <div
              key={group.id}
              className="tab-group"
              style={groupContainerStyle}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleGroupDrop(e, groupIndex)}
            >
              {/* Group label */}
              {editingGroupId === group.id ? (
                <input
                  className="group-label-input"
                  style={styles.groupLabelInput}
                  value={editingGroupName}
                  onChange={(e) => setEditingGroupName(e.target.value)}
                  onBlur={handleGroupRenameSubmit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleGroupRenameSubmit();
                    if (e.key === "Escape") { setEditingGroupId(null); setEditingGroupName(""); }
                  }}
                  autoFocus
                  onMouseDown={(e) => e.stopPropagation()}
                />
              ) : (
                <button
                  className="group-label"
                  style={{
                    ...styles.groupLabel,
                    opacity: draggedGroupIndex === groupIndex ? 0.5 : 1,
                    ...(groupColor ? {
                      background: toRgba(groupColor.rgb, 0.2),
                      color: groupColor.hex,
                    } : {}),
                  }}
                  draggable
                  onDragStart={(e) => handleGroupDragStart(e, groupIndex)}
                  onDragEnd={handleGroupDragEnd}
                  onClick={() => onToggleGroupCollapse(group.id)}
                  onContextMenu={(e) => handleGroupLabelContextMenu(e, group.id)}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <span className="group-label-text" style={styles.groupLabelText}>
                    {group.name}
                  </span>
                  {isCollapsed && (
                    <span className="group-badge" style={styles.groupBadge}>
                      {groupTabs.length}
                    </span>
                  )}
                </button>
              )}

              {/* Group tabs (hidden when collapsed) */}
              {!isCollapsed && groupTabs.map(({ tab, originalIndex }) => renderTab(tab, originalIndex))}
            </div>
          );
        })}

        {/* Ungrouped tabs */}
        {ungroupedTabs.map(({ tab, originalIndex }) => renderTab(tab, originalIndex))}

        <button
          ref={addButtonRef}
          style={styles.addButton}
          onClick={onAddMenuOpen}
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
          anchorLeft={colorPickerAnchorLeft}
        />
      )}

      {groupColorPickerTarget !== null && (
        <ColorPicker
          currentColorId={groupColors[groupColorPickerTarget] ?? null}
          onSelect={handleGroupColorSelect}
          onClose={handleGroupColorPickerClose}
          anchorLeft={groupColorPickerAnchorLeft}
        />
      )}

      {showAddMenu && (
        <AddTabMenu
          entries={history}
          currentWindows={tabs}
          onNewWindow={() => {
            onNewTab();
          }}
          onSelectHistory={onHistorySelect}
          onClearHistory={onHistoryClear}
          onClose={onAddMenuClose}
          anchorRef={addButtonRef}
        />
      )}

      {/* Tab context menu */}
      {tabContextMenu && (
        <div
          className="tab-context-menu-overlay"
          style={styles.contextMenuOverlay}
          onClick={closeTabContextMenu}
        >
          <div
            className="tab-context-menu"
            style={{
              ...styles.contextMenu,
              left: tabContextMenu.x,
              top: tabContextMenu.y,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="context-menu-item"
              style={styles.contextMenuItem}
              onClick={handleOpenColorPicker}
            >
              {t("tabColor.title")}
            </button>
            <div style={styles.contextMenuSeparator} />
            <div
              className="context-menu-item-with-submenu"
              style={styles.contextMenuItemWithSubmenu}
              onMouseEnter={() => setGroupSubmenuOpen(true)}
              onMouseLeave={() => { setGroupSubmenuOpen(false); setNewGroupInput(null); }}
            >
              <button style={styles.contextMenuItem}>
                {t("group.assignToGroup")} ▶
              </button>
              {groupSubmenuOpen && (
                <div className="group-submenu" style={styles.submenu}>
                  {sortedGroups.map((group) => (
                    <button
                      key={group.id}
                      className="context-menu-item"
                      style={styles.contextMenuItem}
                      onClick={() => handleAssignToGroup(group.id)}
                    >
                      {group.name}
                    </button>
                  ))}
                  <div style={styles.contextMenuSeparator} />
                  {newGroupInput !== null ? (
                    <div style={styles.newGroupInputWrapper}>
                      <input
                        className="new-group-input"
                        style={styles.newGroupInputField}
                        value={newGroupInput}
                        onChange={(e) => setNewGroupInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleCreateNewGroup();
                          if (e.key === "Escape") setNewGroupInput(null);
                        }}
                        placeholder={t("group.newGroupPlaceholder")}
                        autoFocus
                        onMouseDown={(e) => e.stopPropagation()}
                      />
                    </div>
                  ) : (
                    <button
                      className="context-menu-item"
                      style={styles.contextMenuItem}
                      onClick={() => setNewGroupInput("")}
                    >
                      {t("group.createNew")}
                    </button>
                  )}
                  {tabContextMenu && tabs[tabContextMenu.index] && groupAssignments[windowKey(tabs[tabContextMenu.index])] && (
                    <>
                      <div style={styles.contextMenuSeparator} />
                      <button
                        className="context-menu-item"
                        style={{ ...styles.contextMenuItem, color: "#f44747" }}
                        onClick={handleUnassignFromGroup}
                      >
                        {t("group.unassign")}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Group label context menu */}
      {groupLabelMenu && (
        <div
          className="group-context-menu-overlay"
          style={styles.contextMenuOverlay}
          onClick={closeGroupLabelMenu}
        >
          <div
            className="group-context-menu"
            style={{
              ...styles.contextMenu,
              left: groupLabelMenu.x,
              top: groupLabelMenu.y,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="context-menu-item"
              style={styles.contextMenuItem}
              onClick={() => handleOpenGroupColorPicker(groupLabelMenu.groupId)}
            >
              {t("tabColor.title")}
            </button>
            <button
              className="context-menu-item"
              style={styles.contextMenuItem}
              onClick={() => handleGroupRename(groupLabelMenu.groupId)}
            >
              {t("group.rename")}
            </button>
            <div style={styles.contextMenuSeparator} />
            <button
              className="context-menu-item"
              style={{ ...styles.contextMenuItem, color: "#f44747" }}
              onClick={() => handleGroupDelete(groupLabelMenu.groupId)}
            >
              {t("group.delete")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    alignItems: "center",
    height: "36px",
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
  groupContainer: {
    display: "flex",
    alignItems: "center",
    height: "100%",
    gap: "2px",
    borderRadius: "4px",
    background: "rgba(255, 255, 255, 0.03)",
    border: "1px solid rgba(255, 255, 255, 0.06)",
    paddingRight: "2px",
  },
  groupLabel: {
    display: "flex",
    alignItems: "center",
    gap: "3px",
    height: "24px",
    padding: "0 6px",
    border: "none",
    background: "rgba(255, 255, 255, 0.06)",
    color: "rgba(255, 255, 255, 0.7)",
    fontSize: "10px",
    fontWeight: 600,
    cursor: "pointer",
    borderRadius: "3px",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
    marginLeft: "2px",
  },
  groupLabelText: {
    maxWidth: "80px",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  groupBadge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "14px",
    height: "14px",
    borderRadius: "7px",
    background: "rgba(255, 255, 255, 0.15)",
    color: "rgba(255, 255, 255, 0.8)",
    fontSize: "9px",
    fontWeight: 600,
    padding: "0 3px",
  },
  groupLabelInput: {
    height: "24px",
    width: "80px",
    padding: "0 6px",
    border: "1px solid rgba(255, 255, 255, 0.3)",
    background: "rgba(255, 255, 255, 0.1)",
    color: "#fff",
    fontSize: "10px",
    borderRadius: "3px",
    outline: "none",
    marginLeft: "2px",
  },
  contextMenuOverlay: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1000,
  },
  contextMenu: {
    position: "fixed" as const,
    background: "#2d2d2d",
    border: "1px solid rgba(255, 255, 255, 0.15)",
    borderRadius: "6px",
    padding: "4px 0",
    minWidth: "140px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
    zIndex: 1001,
  },
  contextMenuItem: {
    display: "block",
    width: "100%",
    padding: "6px 12px",
    border: "none",
    background: "transparent",
    color: "rgba(255, 255, 255, 0.9)",
    fontSize: "12px",
    textAlign: "left" as const,
    cursor: "pointer",
  },
  contextMenuSeparator: {
    height: "1px",
    background: "rgba(255, 255, 255, 0.1)",
    margin: "4px 0",
  },
  contextMenuItemWithSubmenu: {
    position: "relative" as const,
  },
  submenu: {
    position: "absolute" as const,
    left: "100%",
    top: 0,
    background: "#2d2d2d",
    border: "1px solid rgba(255, 255, 255, 0.15)",
    borderRadius: "6px",
    padding: "4px 0",
    minWidth: "140px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
    zIndex: 1002,
  },
  newGroupInputWrapper: {
    padding: "4px 8px",
  },
  newGroupInputField: {
    width: "100%",
    height: "24px",
    padding: "0 6px",
    border: "1px solid rgba(255, 255, 255, 0.3)",
    background: "rgba(255, 255, 255, 0.1)",
    color: "#fff",
    fontSize: "12px",
    borderRadius: "3px",
    outline: "none",
    boxSizing: "border-box" as const,
  },
};

export default TabBar;
