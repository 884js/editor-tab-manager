import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { TAB_COLOR_PALETTE } from "../constants/tabColors";

interface ColorPickerProps {
  currentColorId: string | null;
  onSelect: (colorId: string | null) => void;
  onClose: () => void;
}

function ColorPicker({ currentColorId, onSelect, onClose }: ColorPickerProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);

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
      {/* Overlay to catch outside clicks */}
      <div style={styles.overlay} onClick={onClose} />
      <div ref={containerRef} style={styles.container}>
        {TAB_COLOR_PALETTE.map((color) => (
          <button
            key={color.id}
            style={{
              ...styles.swatch,
              backgroundColor: color.hex,
              ...(currentColorId === color.id ? styles.swatchSelected : {}),
            }}
            onClick={() => onSelect(color.id)}
            title={t(color.label)}
          />
        ))}
        {/* Reset button */}
        <button
          style={{
            ...styles.resetSwatch,
            ...(currentColorId === null ? styles.resetSwatchActive : {}),
          }}
          onClick={() => onSelect(null)}
          title={t("tabColor.reset")}
        >
          ×
        </button>
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
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 8px",
    background: "#2d2d2d",
    border: "1px solid #404040",
    borderRadius: "6px",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.5)",
    zIndex: 101,
  },
  swatch: {
    width: "16px",
    height: "16px",
    borderRadius: "50%",
    cursor: "pointer",
    border: "2px solid transparent",
    padding: 0,
    transition: "border-color 0.1s, transform 0.1s",
    flexShrink: 0,
  },
  swatchSelected: {
    borderColor: "#ffffff",
    transform: "scale(1.2)",
  },
  resetSwatch: {
    width: "16px",
    height: "16px",
    borderRadius: "50%",
    cursor: "pointer",
    border: "1px solid #666666",
    background: "transparent",
    padding: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#666666",
    fontSize: "10px",
    lineHeight: 1,
    transition: "border-color 0.1s",
    flexShrink: 0,
  },
  resetSwatchActive: {
    borderColor: "#ffffff",
    color: "#ffffff",
  },
};

export default ColorPicker;
