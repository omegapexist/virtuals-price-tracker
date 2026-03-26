export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Küçük fiyatlar için bilimsel olmayan kısa gösterim ($0.000059 gibi) */
export function formatUsdPrice(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  const a = Math.abs(n);
  if (a >= 1) return `$${n.toFixed(4).replace(/\.?0+$/, "")}`;
  if (a >= 0.0001) return `$${n.toFixed(6).replace(/\.?0+$/, "")}`;
  return `$${n.toFixed(8).replace(/\.?0+$/, "")}`;
}

/** FDV: $136.49K / $1.52M */
export function formatFdvUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

export function pctChangeEmoji(pct: number): string {
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.005) return "⚪";
  return pct > 0 ? "🟢" : "🔴";
}

/** Listede (emoji ayrı): %0.00, +%0.63, %-0.45 */
export function formatListDeltaPercent(pct: number): string {
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.005) return `%0.00`;
  if (pct > 0) return `+%${pct.toFixed(2)}`;
  return `%${pct.toFixed(2)}`;
}
