const DEFAULT_ALLOWED_CODES = ["-", "R", "G", "B", "Y", "W", "K"];
const ALIAS_MAP = new Map([
  ["", "-"],
  ["-", "-"],
  ["NONE", "-"],
  ["EMPTY", "-"],
  ["N", "-"],
]);

function buildAllowedSet(allowed) {
  const source = Array.isArray(allowed) && allowed.length ? allowed : DEFAULT_ALLOWED_CODES;
  const set = new Set(
    source.map((item) => (item == null ? "" : item.toString().trim().toUpperCase())).filter(Boolean)
  );
  set.add("-");
  return set;
}

function normalizeShelfCode(value, allowedSet) {
  if (value == null) {
    return "-";
  }
  const raw = value.toString().trim();
  const upper = raw.toUpperCase();
  const normalized = ALIAS_MAP.has(upper) ? ALIAS_MAP.get(upper) : upper;
  if (!normalized || !allowedSet.has(normalized)) {
    throw new Error(`Unsupported shelf code: ${value}`);
  }
  return normalized;
}

export function validateShelfGrid(grid, allowedCodes = DEFAULT_ALLOWED_CODES) {
  if (!Array.isArray(grid)) {
    throw new Error("Shelf grid must be an array");
  }
  if (grid.length !== 3) {
    throw new Error("Shelf grid must have 3 rows");
  }

  const allowedSet = buildAllowedSet(allowedCodes);
  return grid.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== 3) {
      throw new Error(`Shelf grid row ${rowIndex} must have 3 columns`);
    }
    return row.map((cell) => normalizeShelfCode(cell, allowedSet));
  });
}

export function createEmptyShelfGrid() {
  return Array.from({ length: 3 }, () => ["-", "-", "-"]);
}

export { DEFAULT_ALLOWED_CODES as SHELF_ALLOWED_CODES };
