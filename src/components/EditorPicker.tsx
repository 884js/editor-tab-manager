import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { EDITOR_DISPLAY_NAMES, PROJECT_EDITOR_BUNDLE_IDS } from "../types/editor";
import type { ProjectEditorBundleId } from "../types/editor";

interface EditorPickerProps {
  targetName: string;
  anchorRect: DOMRect;
  onSelect: (bundleId: ProjectEditorBundleId) => Promise<boolean>;
  onClose: () => void;
}

const PICKER_WIDTH = 220;
const PICKER_HEIGHT = 130;
const VIEWPORT_PADDING = 4;

function EditorPicker({ targetName, anchorRect, onSelect, onClose }: EditorPickerProps) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);
  const [errorEditor, setErrorEditor] = useState<string | null>(null);
  const left = Math.min(
    Math.max(VIEWPORT_PADDING, anchorRect.left),
    window.innerWidth - PICKER_WIDTH - VIEWPORT_PADDING,
  );
  const top = anchorRect.bottom + VIEWPORT_PADDING + PICKER_HEIGHT <= window.innerHeight
    ? anchorRect.bottom + VIEWPORT_PADDING
    : Math.max(VIEWPORT_PADDING, anchorRect.top - PICKER_HEIGHT - VIEWPORT_PADDING);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSelect = async (bundleId: ProjectEditorBundleId) => {
    setOpening(true);
    setErrorEditor(null);
    const opened = await onSelect(bundleId);
    if (opened) {
      onClose();
      return;
    }
    setOpening(false);
    setErrorEditor(EDITOR_DISPLAY_NAMES[bundleId]);
  };

  return (
    <>
      <div style={styles.overlay} onClick={onClose} />
      <div
        role="dialog"
        aria-label={t("history.chooseEditor")}
        style={{
          ...styles.container,
          top,
          left,
        }}
      >
        <div style={styles.header}>
          <span style={styles.title}>{t("history.chooseEditor")}</span>
          <span style={styles.targetName}>{targetName}</span>
        </div>
        <div style={styles.editorList}>
          {PROJECT_EDITOR_BUNDLE_IDS.map((bundleId) => (
            <button
              key={bundleId}
              type="button"
              disabled={opening}
              style={styles.editorButton}
              onClick={() => void handleSelect(bundleId)}
            >
              {EDITOR_DISPLAY_NAMES[bundleId]}
            </button>
          ))}
        </div>
        {errorEditor && (
          <div role="status" style={styles.errorText}>
            {t("history.openFailed", { editor: errorEditor })}
          </div>
        )}
        <button type="button" disabled={opening} style={styles.cancelButton} onClick={onClose}>
          {t("history.cancel")}
        </button>
      </div>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 102,
  },
  container: {
    position: "fixed",
    width: `${PICKER_WIDTH}px`,
    overflow: "hidden",
    border: "1px solid #404040",
    borderRadius: "8px",
    background: "#2d2d2d",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.5)",
    zIndex: 103,
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "8px 10px 6px",
  },
  title: {
    color: "rgba(255, 255, 255, 0.55)",
    fontSize: "11px",
  },
  targetName: {
    overflow: "hidden",
    color: "#e0e0e0",
    fontSize: "12px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  editorList: {
    display: "flex",
    gap: "6px",
    padding: "2px 10px 8px",
  },
  editorButton: {
    flex: 1,
    padding: "5px 4px",
    border: "1px solid #505050",
    borderRadius: "5px",
    background: "#383838",
    color: "#e0e0e0",
    fontSize: "11px",
    cursor: "pointer",
  },
  errorText: {
    padding: "6px 10px",
    borderTop: "1px solid #404040",
    color: "#f0a0a0",
    fontSize: "11px",
  },
  cancelButton: {
    width: "100%",
    padding: "7px 10px",
    border: "none",
    borderTop: "1px solid #404040",
    background: "transparent",
    color: "rgba(255, 255, 255, 0.55)",
    fontSize: "11px",
    cursor: "pointer",
  },
};

export default EditorPicker;
