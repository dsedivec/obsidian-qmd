import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanSnippet,
  highlightSegments,
  toSearchResults,
} from "../src/results";

const fixture = JSON.parse(
  readFileSync("tests/fixtures/mcp-query-response.json", "utf8"),
);
const SNIP =
  "11: @@ -11,3 @@ (10 before, 4 after)\n11: ## Roles\n12: IRSA lets a   pod assume a role.\n13: ";
const raw = (file: unknown, extra: object = {}) => ({
  file,
  line: 12,
  score: 0.93,
  snippet: SNIP,
  ...extra,
});

describe("toSearchResults", () => {
  it("cleans snippets", () => {
    expect(cleanSnippet(SNIP)).toBe("## Roles IRSA lets a pod assume a role.");
    expect(cleanSnippet("no prefix here")).toBe("no prefix here");
    expect(cleanSnippet("")).toBe("");
  });
  it("maps a result", () => {
    expect(toSearchResults([raw("Main/AWS EKS.md")], "Main")).toEqual([
      {
        path: "AWS EKS.md",
        title: "AWS EKS",
        folder: "",
        line: 12,
        score: 0.93,
        snippet: "## Roles IRSA lets a pod assume a role.",
      },
    ]);
  });
  it.each([
    [
      "Main/Projects/Platform/EKS migration plan.md",
      "Projects/Platform/EKS migration plan.md",
      "EKS migration plan",
      "Projects/Platform",
    ],
    ['Main/"Office" Chairs.md', '"Office" Chairs.md', '"Office" Chairs', ""],
    ["Main/Café ☕ notes.md", "Café ☕ notes.md", "Café ☕ notes", ""],
    ["Main/HTML & markup.md", "HTML & markup.md", "HTML & markup", ""],
    ["Main/Main/Main.md", "Main/Main.md", "Main", "Main"],
    ["Main/Archive/notes.v2.MD", "Archive/notes.v2.MD", "notes.v2", "Archive"],
  ])("maps %j", (file, path, title, folder) => {
    expect(toSearchResults([raw(file)], "Main")[0]).toMatchObject({
      path,
      title,
      folder,
    });
  });
  it("drops results from other collections and malformed entries", () => {
    expect(
      toSearchResults(
        [
          raw("Other/x.md"),
          raw("MainExtra/x.md"),
          raw("Main"),
          raw("Main/"),
          raw(42),
          null,
          "str",
        ],
        "Main",
      ),
    ).toEqual([]);
  });
  it("repairs missing fields", () => {
    expect(
      toSearchResults(
        [raw("Main/a.md", { line: "7", score: undefined, snippet: null })],
        "Main",
      )[0],
    ).toMatchObject({ line: 1, score: 0, snippet: "" });
  });
  it("handles the response captured from the real server", () => {
    const results = toSearchResults(
      fixture.result.structuredContent.results,
      "probe",
    );
    expect(results[0].path).toBe("HTML & markup.md");
    for (const r of results) {
      expect(existsSync(join("tests/fixtures/vault", r.path))).toBe(true);
      expect(r.snippet).not.toMatch(/@@ -|^\d+: /);
    }
  });
});

describe("highlightSegments", () => {
  it("bolds whole query words of three or more characters, case-insensitively", () => {
    expect(
      highlightSegments("IRSA lets a pod assume a role", "pod role a"),
    ).toEqual([
      { text: "IRSA lets a ", bold: false },
      { text: "pod", bold: true },
      { text: " assume a ", bold: false },
      { text: "role", bold: true },
    ]);
    expect(highlightSegments("The Pod and the podcast", "pod")).toEqual([
      { text: "The ", bold: false },
      { text: "Pod", bold: true },
      { text: " and the podcast", bold: false },
    ]);
  });
  it("treats markup and regex characters as plain text", () => {
    expect(
      highlightSegments('<b>x</b> <img src=x onerror="alert(1)">', "img"),
    ).toEqual([
      { text: "<b>x</b> <", bold: false },
      { text: "img", bold: true },
      { text: ' src=x onerror="alert(1)">', bold: false },
    ]);
    expect(highlightSegments("a.b.c", ".*. a.b")).toEqual([
      { text: "a.b", bold: true },
      { text: ".c", bold: false },
    ]);
  });
  it("handles empty input", () => {
    expect(highlightSegments("plain", "")).toEqual([
      { text: "plain", bold: false },
    ]);
    expect(highlightSegments("", "pod")).toEqual([]);
  });
});
