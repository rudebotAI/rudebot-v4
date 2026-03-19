/* Formatting utilities */

export function fmt(n) {
  return (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtPct(n) {
  return `${n >= 0 ? "+" : ""}${(n || 0).toFixed(2)}%`;
}

export function fmtK(n) {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${fmt(n)}`;
}
