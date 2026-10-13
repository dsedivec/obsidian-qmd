import { describe, expect, it } from "vitest";
import type { IndexState } from "../src/indexer";
import { folderLabel, footerText, formatAge, moveSelection, scorePercent, statusText } from "../src/view-model";

const NOW = 10_000_000;
const idle = (agoMs?: number): IndexState => ({ kind: "idle", lastIndexedAt: agoMs === undefined ? undefined : NOW - agoMs });

describe("view-model", () => {
  it.each([[0, "just now"], [59_000, "just now"], [60_000, "1 min ago"], [150_000, "2 min ago"],
    [3_600_000, "1 h ago"], [7_300_000, "2 h ago"], [90_000_000, "1 d ago"]])("formatAge(%i) is %j", (ms, text) => {
    expect(formatAge(ms)).toBe(text);
  });

  it.each([
    [7, idle(120_000), "7 results · indexed 2 min ago", false], [1, idle(120_000), "1 result · indexed 2 min ago", false],
    [0, idle(120_000), "0 results · indexed 2 min ago", false], [null, idle(120_000), "Indexed 2 min ago", false],
    [null, idle(), "", false], [7, idle(), "7 results", false],
    [null, { kind: "running", step: "setup" }, "Indexing… (setting up)", false],
    [7, { kind: "running", step: "update" }, "7 results · indexing… (scanning)", false],
    [null, { kind: "running", step: "embed" }, "Indexing… (embedding)", false],
    [null, { kind: "failed", message: "m" }, "Index failed: m", true], [3, { kind: "failed", message: "m" }, "3 results · index failed: m", true],
  ] as const)("footerText(%j, %j)", (count, state, text, error) => {
    expect(footerText(count, state, NOW)).toEqual({ text, error });
  });

  it("formats status", () => {
    expect(statusText("starting", 6400)).toBe("Starting QMD server… 6s");
    expect(statusText("searching", 900)).toBe("Searching… 0s");
  });

  it.each([[null, "ArrowDown", 3, 0], [null, "ArrowDown", 0, null], [null, "ArrowUp", 3, null],
    [0, "ArrowUp", 3, null], [1, "ArrowUp", 3, 0], [1, "ArrowDown", 3, 2], [2, "ArrowDown", 3, 2]] as const)(
    "moveSelection(%j, %s, %i) is %j", (current, key, count, expected) => expect(moveSelection(current, key, count)).toBe(expected));

  it.each([[0.93, "93%"], [0.005, "1%"], [1, "100%"], [1.7, "100%"], [-1, "0%"], [NaN, "0%"]])(
    "scorePercent(%j) is %s", (score, text) => expect(scorePercent(score)).toBe(text));

  it.each([["Daily", "Daily"], ["Projects/Platform", "Projects / Platform"], ["a/b c/d", "a / b c / d"], ["", ""]])(
    "folderLabel(%j) is %j", (folder, text) => expect(folderLabel(folder)).toBe(text));
});
