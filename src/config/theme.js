/* Color palette and theme constants */

export const C = {
  bg: "#0d0d0f",
  surface: "#141417",
  surfaceAlt: "#1a1a1f",
  surfaceEl: "#202027",
  border: "#28282f",
  borderLt: "#1e1e25",
  borderHi: "#35353f",
  text: "#e8e6e3",
  textMid: "#8a8690",
  textMute: "#5a5660",
  textFaint: "#36343a",
  red: "#ef4444",
  redBg: "#1c1012",
  redBorder: "#3a1a1a",
  green: "#22c55e",
  greenBg: "#0f1c14",
  greenBorder: "#1a3a20",
  blue: "#3b82f6",
  blueBg: "#0f1420",
  blueBorder: "#1a2a45",
  amber: "#f59e0b",
  amberBg: "#1c1808",
  amberBorder: "#3a3010",
  violet: "#8b5cf6",
  violetBg: "#140f20",
  rose: "#f43f5e",
  teal: "#14b8a6",
  tealBg: "#0f1c1a",
  orange: "#f97316",
  slate: "#64748b",
  cyan: "#06b6d4",
};

export const stratColor = (s) =>
  s === "MOMENTUM" ? C.red : s === "DIVIDEND" ? C.teal : s === "ROTATION" ? C.orange : C.blue;

export const stratBg = (s) =>
  s === "MOMENTUM" ? C.redBg : s === "DIVIDEND" ? C.tealBg : s === "ROTATION" ? "#1c1608" : C.blueBg;

export const SECTOR_COLORS = [
  "#ef4444", "#3b82f6", "#14b8a6", "#f59e0b", "#8b5cf6",
  "#f97316", "#06b6d4", "#ec4899", "#22c55e",
];
