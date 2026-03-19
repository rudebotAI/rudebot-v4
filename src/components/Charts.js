/* SVG chart components â Sparkline and Equity Curve */

import React from "react";

export function Spark({ prices, color, w = 100, h = 36 }) {
  if (!prices || prices.length < 2) return null;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const pts = prices
    .map((p, i) => `${(i / (prices.length - 1)) * w},${h - ((p - min) / range) * h}`)
    .join(" ");
  return (
    <svg width={w} height={h}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function EquityCurve({ data, color, w = 320, h = 80 }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data
    .map((p, i) => `${(i / (data.length - 1)) * w},${h - 4 - ((p - min) / range) * (h - 8)}`)
    .join(" ");
  const fillPts = `0,${h} ${pts} ${w},${h}`;
  const lastY = h - 4 - ((data[data.length - 1] - min) / range) * (h - 8);
  const isUp = data[data.length - 1] >= data[0];
  const c = isUp ? color || "#16a34a" : "#dc2626";
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <defs>
        <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c} stopOpacity="0.12" />
          <stop offset="100%" stopColor={c} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={fillPts} fill="url(#eqFill)" />
      <polyline points={pts} fill="none" stroke={c} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={w} cy={lastY} r="3" fill={c} />
    </svg>
  );
}
