import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, buildPath, deriveCollectionName, isValidCollectionName, sanitizeSettings } from "../src/config";

describe("config", () => {
it.each([
  ["Main", "Main"], ["My Vault", "My-Vault"], ["  Notes (2024)!  ", "Notes-2024"],
  ["a__b--c", "a__b--c"], ["日本語", "vault"], ["", "vault"],
])("deriveCollectionName(%j) is %j", (input, expected) => {
  expect(deriveCollectionName(input)).toBe(expected);
});

it.each([
  ["x", true], ["Main", true], ["a-b_c", true], ["_x", true], ["9", true], ["x-", true],
  ["", false], ["has space", false], ["a/b", false],
  // qmd takes the name as a positional argument, and would read a leading hyphen as an option
  ["-x", false], ["-", false], ["--name", false],
])("isValidCollectionName(%j) is %j", (name, expected) => {
  expect(isValidCollectionName(name)).toBe(expected);
});

it("falls back to defaults for junk", () => {
  expect(sanitizeSettings(null, "Main")).toEqual({ ...DEFAULT_SETTINGS, collectionName: "Main" });
  expect(sanitizeSettings("nope", "Main")).toEqual({ ...DEFAULT_SETTINGS, collectionName: "Main" });
});
it.each([["abc", 8181], [0, 8181], [70000, 8181], [8080.4, 8080], ["9000", 9000]])(
  "port %j becomes %j", (port, expected) => expect(sanitizeSettings({ port }, "X").port).toBe(expected));
it.each([[0, 1], [999, 50], [7.6, 8], ["x", 10]])(
  "resultCount %j becomes %j", (resultCount, expected) => expect(sanitizeSettings({ resultCount }, "X").resultCount).toBe(expected));
it.each([[0, 1], [-5, 1], [100000, 1440], ["x", 60]])(
  "idleTimeoutMinutes %j becomes %j", (v, expected) => expect(sanitizeSettings({ idleTimeoutMinutes: v }, "X").idleTimeoutMinutes).toBe(expected));
it.each([[0, 1], [500, 120], ["x", 5]])(
  "reindexQuietMinutes %j becomes %j", (v, expected) => expect(sanitizeSettings({ reindexQuietMinutes: v }, "X").reindexQuietMinutes).toBe(expected));
// A cleared settings field is "", which Number() reads as 0: that must not become the minimum.
describe.each(["port", "idleTimeoutMinutes", "reindexQuietMinutes", "resultCount"] as const)("%s", (key) => {
  it.each([[""], ["  "], [null], [undefined], [true], [false], [[]], [[7]], [{}]])(
    "is the default when the saved value is %j", (value) => {
      expect(sanitizeSettings({ [key]: value }, "X")[key]).toBe(DEFAULT_SETTINGS[key]);
    });
  it("still reads a number written as a string, spaces around it or not", () => {
    expect(sanitizeSettings({ [key]: " 7 " }, "X")[key]).toBe(7);
  });
});
it("repairs strings", () => {
  expect(sanitizeSettings({ collectionName: "has space" }, "My Vault").collectionName).toBe("My-Vault");
  expect(sanitizeSettings({ collectionName: "-x" }, "My Vault").collectionName).toBe("My-Vault");
  expect(sanitizeSettings({ collectionName: "kept_1" }, "X").collectionName).toBe("kept_1");
  expect(sanitizeSettings({ extraPath: " /a : :/b:" }, "X").extraPath).toBe("/a:/b");
  expect(sanitizeSettings({ qmdPath: "   " }, "X").qmdPath).toBe("qmd");
  expect(sanitizeSettings({ qmdPath: " /opt/q md/qmd " }, "X").qmdPath).toBe("/opt/q md/qmd");
});

it("builds PATH: qmd's directory, extras, inherited, without duplicates", () => {
  expect(buildPath("/Users/d/.npm-packages/bin/qmd", "/opt/homebrew/bin:/usr/local/bin", "/usr/bin:/bin"))
    .toBe("/Users/d/.npm-packages/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  expect(buildPath("qmd", "/opt/homebrew/bin", "/usr/bin:/opt/homebrew/bin")).toBe("/opt/homebrew/bin:/usr/bin");
  expect(buildPath("qmd", "", undefined)).toBe("");
});
});
