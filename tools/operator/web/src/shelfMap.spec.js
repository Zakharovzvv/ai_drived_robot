import { describe, expect, it } from "vitest";
import { createEmptyShelfGrid, SHELF_ALLOWED_CODES, validateShelfGrid } from "./shelfMap.js";

describe("validateShelfGrid", () => {
  it("normalizes aliases and case", () => {
    const grid = [
      ["r", "g", "b"],
      ["y", "w", "k"],
      ["none", "", null],
    ];
    expect(validateShelfGrid(grid)).toEqual([
      ["R", "G", "B"],
      ["Y", "W", "K"],
      ["-", "-", "-"],
    ]);
  });

  it("respects explicit allowed palette", () => {
    const palette = ["-", "R", "G"];
    const grid = [
      ["r", "g", "-"],
      ["r", "g", "-"],
      ["r", "g", "-"],
    ];
    expect(validateShelfGrid(grid, palette)).toEqual(grid.map((row) => row.map((cell) => cell.toUpperCase())));
    expect(() => validateShelfGrid([["B", "R", "G"], ["R", "G", "-"], ["-", "-", "-"]], palette)).toThrow(
      /Unsupported shelf code/i
    );
  });

  it("throws when grid shape is invalid", () => {
    expect(() => validateShelfGrid([["R", "G"], ["B", "Y"], ["W", "K"]])).toThrow(/3 columns/i);
    expect(() => validateShelfGrid([["R", "G", "B"], ["Y", "W", "K"]])).toThrow(/3 rows/i);
  });

  it("throws on unsupported codes", () => {
    expect(() => validateShelfGrid([["R", "G", "B"], ["Y", "W", "K"], ["Q", "-", "-"]])).toThrow(
      /Unsupported shelf code/i
    );
  });
});

describe("createEmptyShelfGrid", () => {
  it("creates a 3x3 grid filled with empty cells", () => {
    const grid = createEmptyShelfGrid();
    expect(grid).toHaveLength(3);
    grid.forEach((row) => {
      expect(row).toEqual(["-", "-", "-"]);
    });
  });
});

describe("SHELF_ALLOWED_CODES", () => {
  it("includes the default codes", () => {
    expect(SHELF_ALLOWED_CODES).toEqual(["-", "R", "G", "B", "Y", "W", "K"]);
  });
});
