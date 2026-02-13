export interface TabColor {
  id: string;
  hex: string;
  label: string;
}

export const TAB_COLOR_PALETTE: TabColor[] = [
  { id: "red", hex: "#e06c75", label: "tabColor.red" },
  { id: "orange", hex: "#d19a66", label: "tabColor.orange" },
  { id: "yellow", hex: "#e5c07b", label: "tabColor.yellow" },
  { id: "green", hex: "#98c379", label: "tabColor.green" },
  { id: "teal", hex: "#56b6c2", label: "tabColor.teal" },
  { id: "blue", hex: "#61afef", label: "tabColor.blue" },
  { id: "purple", hex: "#c678dd", label: "tabColor.purple" },
  { id: "pink", hex: "#e06c9f", label: "tabColor.pink" },
];

export function getColorById(id: string | null | undefined): TabColor | undefined {
  if (!id) return undefined;
  return TAB_COLOR_PALETTE.find((c) => c.id === id);
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 255, g: 255, b: 255 };
}
