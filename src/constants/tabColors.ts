export interface TabColor {
  id: string;
  hex: string;
  rgb: { r: number; g: number; b: number };
  label: string;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 255, g: 255, b: 255 };
}

export const TAB_COLOR_PALETTE: TabColor[] = [
  { id: "red", hex: "#e06c75", rgb: hexToRgb("#e06c75"), label: "tabColor.red" },
  { id: "orange", hex: "#d19a66", rgb: hexToRgb("#d19a66"), label: "tabColor.orange" },
  { id: "yellow", hex: "#e5c07b", rgb: hexToRgb("#e5c07b"), label: "tabColor.yellow" },
  { id: "green", hex: "#98c379", rgb: hexToRgb("#98c379"), label: "tabColor.green" },
  { id: "teal", hex: "#56b6c2", rgb: hexToRgb("#56b6c2"), label: "tabColor.teal" },
  { id: "blue", hex: "#61afef", rgb: hexToRgb("#61afef"), label: "tabColor.blue" },
  { id: "purple", hex: "#c678dd", rgb: hexToRgb("#c678dd"), label: "tabColor.purple" },
  { id: "pink", hex: "#e06c9f", rgb: hexToRgb("#e06c9f"), label: "tabColor.pink" },
];

const COLOR_MAP = new Map(TAB_COLOR_PALETTE.map((c) => [c.id, c]));

export function getColorById(id: string | null | undefined): TabColor | undefined {
  if (!id) return undefined;
  return COLOR_MAP.get(id);
}
