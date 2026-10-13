import { describe, expect, it, vi } from "vitest";
import { createExclusionCheck, matchesFilters } from "../src/exclusions";

describe("exclusions", () => {
  it.each([
    ["Archive/old.md", ["Archive/"], true], ["Archive/old.md", ["Archive"], true], ["Archived.md", ["Archive/"], false],
    ["Daily/2026-09-30.md", ["/^Daily\\/\\d{4}/"], true], ["x/Daily/2026.md", ["/^Daily\\//"], false],
    ["Templates/t.md", ["Other/", "/\\.excalidraw\\.md$/", "Templates/"], true],
    ["a.md", [], false], ["a.md", ["", "  ", 7, null], false], ["a.md", ["/[/"], false],
  ])("matchesFilters(%j, %j) is %j", (path, filters, expected) => {
    expect(matchesFilters(path, filters)).toBe(expected);
  });

  it("prefers Obsidian's own check", () => {
    const check = createExclusionCheck({ metadataCache: { isUserIgnored: (p: string) => p === "x.md" }, vault: {} });
    expect([check("x.md"), check("y.md")]).toEqual([true, false]);
  });
  it("falls back to the filter list and reads it on every call", () => {
    let filters = ["Archive/"];
    const check = createExclusionCheck({ metadataCache: {}, vault: { getConfig: (k: string) => (k === "userIgnoreFilters" ? filters : undefined) } });
    expect(check("Archive/a.md")).toBe(true);
    filters = [];
    expect(check("Archive/a.md")).toBe(false);
  });
  it("excludes nothing and warns once when neither exists or the call throws", () => {
    const warn = vi.fn();
    const none = createExclusionCheck({ metadataCache: {}, vault: {} }, warn);
    expect([none("a.md"), none("b.md")]).toEqual([false, false]);
    expect(warn).toHaveBeenCalledTimes(1);
    const throwing = createExclusionCheck({ metadataCache: { isUserIgnored: () => { throw new Error("x"); } }, vault: {} }, vi.fn());
    expect(throwing("a.md")).toBe(false);
  });
});
