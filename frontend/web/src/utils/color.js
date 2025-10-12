export function contrastTextColor(hex) {
  if (!hex || typeof hex !== "string") {
    return "var(--color-text)";
  }
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6 && normalized.length !== 3) {
    return "var(--color-text)";
  }
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized;
  const r = Number.parseInt(expanded.slice(0, 2), 16);
  const g = Number.parseInt(expanded.slice(2, 4), 16);
  const b = Number.parseInt(expanded.slice(4, 6), 16);
  if ([r, g, b].some((component) => Number.isNaN(component))) {
    return "var(--color-text)";
  }
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#0f172a" : "#f8fafc";
}
