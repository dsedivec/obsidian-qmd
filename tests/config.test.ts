import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  applySettingsPatch,
  buildPath,
  deriveCollectionName,
  expandHome,
  isValidCollectionName,
  sanitizeSettings,
  withHomeExpanded,
  type QmdSearchSettings,
} from "../src/config";

describe("config", () => {
  it.each([
    ["Main", "Main"],
    ["My Vault", "My-Vault"],
    ["  Notes (2024)!  ", "Notes-2024"],
    ["a__b--c", "a__b--c"],
    ["日本語", "vault"],
    ["", "vault"],
  ])("deriveCollectionName(%j) is %j", (input, expected) => {
    expect(deriveCollectionName(input)).toBe(expected);
  });

  it.each([
    ["x", true],
    ["Main", true],
    ["a-b_c", true],
    ["_x", true],
    ["9", true],
    ["x-", true],
    ["", false],
    ["has space", false],
    ["a/b", false],
    // qmd takes the name as a positional argument, and would read a leading hyphen as an option
    ["-x", false],
    ["-", false],
    ["--name", false],
  ])("isValidCollectionName(%j) is %j", (name, expected) => {
    expect(isValidCollectionName(name)).toBe(expected);
  });

  it("falls back to defaults for junk", () => {
    expect(sanitizeSettings(null, "Main")).toEqual({
      ...DEFAULT_SETTINGS,
      collectionName: "Main",
    });
    expect(sanitizeSettings("nope", "Main")).toEqual({
      ...DEFAULT_SETTINGS,
      collectionName: "Main",
    });
  });
  it.each([
    ["abc", 8181],
    [0, 8181],
    [70000, 8181],
    [8080.4, 8080],
    ["9000", 9000],
  ])("port %j becomes %j", (port, expected) =>
    expect(sanitizeSettings({ port }, "X").port).toBe(expected),
  );
  it.each([
    [0, 1],
    [999, 50],
    [7.6, 8],
    ["x", 10],
  ])("resultCount %j becomes %j", (resultCount, expected) =>
    expect(sanitizeSettings({ resultCount }, "X").resultCount).toBe(expected),
  );
  it.each([
    [0, 1],
    [-5, 1],
    [100000, 1440],
    ["x", 60],
  ])("idleTimeoutMinutes %j becomes %j", (v, expected) =>
    expect(
      sanitizeSettings({ idleTimeoutMinutes: v }, "X").idleTimeoutMinutes,
    ).toBe(expected),
  );
  it.each([
    [0, 1],
    [500, 120],
    ["x", 5],
  ])("reindexQuietMinutes %j becomes %j", (v, expected) =>
    expect(
      sanitizeSettings({ reindexQuietMinutes: v }, "X").reindexQuietMinutes,
    ).toBe(expected),
  );
  // A cleared settings field is "", which Number() reads as 0: that must not become the minimum.
  describe.each([
    "port",
    "idleTimeoutMinutes",
    "reindexQuietMinutes",
    "resultCount",
  ] as const)("%s", (key) => {
    it.each([
      [""],
      ["  "],
      [null],
      [undefined],
      [true],
      [false],
      [[]],
      [[7]],
      [{}],
    ])("is the default when the saved value is %j", (value) => {
      expect(sanitizeSettings({ [key]: value }, "X")[key]).toBe(
        DEFAULT_SETTINGS[key],
      );
    });
    it("still reads a number written as a string, spaces around it or not", () => {
      expect(sanitizeSettings({ [key]: " 7 " }, "X")[key]).toBe(7);
    });
  });
  it("repairs strings", () => {
    expect(
      sanitizeSettings({ collectionName: "has space" }, "My Vault")
        .collectionName,
    ).toBe("My-Vault");
    expect(
      sanitizeSettings({ collectionName: "-x" }, "My Vault").collectionName,
    ).toBe("My-Vault");
    expect(
      sanitizeSettings({ collectionName: "kept_1" }, "X").collectionName,
    ).toBe("kept_1");
    expect(sanitizeSettings({ extraPath: " /a : :/b:" }, "X").extraPath).toBe(
      "/a:/b",
    );
    expect(sanitizeSettings({ qmdPath: "   " }, "X").qmdPath).toBe("qmd");
    expect(sanitizeSettings({ qmdPath: " /opt/q md/qmd " }, "X").qmdPath).toBe(
      "/opt/q md/qmd",
    );
  });

  it("builds PATH: qmd's directory, extras, inherited, without duplicates", () => {
    expect(
      buildPath(
        "/Users/d/.npm-packages/bin/qmd",
        "/opt/homebrew/bin:/usr/local/bin",
        "/usr/bin:/bin",
      ),
    ).toBe(
      "/Users/d/.npm-packages/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    );
    expect(
      buildPath("qmd", "/opt/homebrew/bin", "/usr/bin:/opt/homebrew/bin"),
    ).toBe("/opt/homebrew/bin:/usr/bin");
    expect(buildPath("qmd", "", undefined)).toBe("");
  });
});

// What a settings field does with what was typed into it. None of the values in use here is a
// default, and the collection name is not the one the vault's name gives ("Scratch-Vault"), so a
// value that was kept shows as kept and not as a default that happens to be the same.
describe("applySettingsPatch", () => {
  const VAULT = "Scratch Vault";
  const before: QmdSearchSettings = {
    qmdPath: "/opt/q/qmd",
    extraPath: "/a:/b",
    collectionName: "Custom_1",
    port: 9000,
    idleTimeoutMinutes: 30,
    reindexQuietMinutes: 7,
    resultCount: 12,
  };
  /** The settings after `patch`, as the fields that differ from `before`. */
  const changed = (patch: Record<string, unknown>) => {
    const after = applySettingsPatch(before, patch, VAULT);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    return Object.fromEntries(
      Object.entries(after).filter(
        ([key, value]) => value !== before[key as keyof QmdSearchSettings],
      ),
    );
  };

  it("leaves every field that is not in the patch as it was", () => {
    expect(applySettingsPatch(before, {}, VAULT)).toEqual(before);
    expect(changed({ resultCount: 7 })).toEqual({ resultCount: 7 });
    expect(changed({ noSuchSetting: 1 })).toEqual({});
  });
  it("returns new settings and leaves the ones it was given alone", () => {
    const given = { ...before };
    const after = applySettingsPatch(given, { port: 9001 }, VAULT);
    expect(after).not.toBe(given);
    expect(given).toEqual(before);
  });

  describe("collection name", () => {
    it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
      ["a typo with a space", { collectionName: "has space" }, {}],
      ["a leading hyphen", { collectionName: "-x" }, {}],
      ["an empty name", { collectionName: "" }, {}],
      ["a blank name", { collectionName: "   " }, {}],
      ["a value that is not a string", { collectionName: 5 }, {}],
      ["undefined", { collectionName: undefined }, {}],
      [
        "a valid name",
        { collectionName: "Notes_2" },
        { collectionName: "Notes_2" },
      ],
      [
        "a valid name with spaces around it",
        { collectionName: " Notes_2 " },
        { collectionName: "Notes_2" },
      ],
      ["the name already in use", { collectionName: "Custom_1" }, {}],
      ["another setting only", { resultCount: 7 }, { resultCount: 7 }],
      [
        "a typo beside a QMD path change",
        { collectionName: "has space", qmdPath: "/new/qmd" },
        { qmdPath: "/new/qmd" },
      ],
      [
        "a valid name beside a QMD path change",
        { collectionName: "Notes_2", qmdPath: "/new/qmd" },
        { collectionName: "Notes_2", qmdPath: "/new/qmd" },
      ],
    ])("%s changes %j by %j", (_name, patch, expected) => {
      expect(changed(patch)).toEqual(expected);
    });
    // The name made from the vault's is what loading falls back to. Here it would be a collection
    // that the indexer creates and nothing ever removes.
    it("never puts the name made from the vault's in place of an invalid one", () => {
      for (const collectionName of ["has space", "-x", "", "a/b", 5, null])
        expect(
          applySettingsPatch(before, { collectionName }, VAULT).collectionName,
        ).toBe("Custom_1");
    });
  });

  describe.each([
    ["port", 1, 65_535],
    ["idleTimeoutMinutes", 1, 1440],
    ["reindexQuietMinutes", 1, 120],
    ["resultCount", 1, 50],
  ] as const)("%s", (key, min, max) => {
    it.each<[string, unknown]>([
      ["a cleared field", ""],
      ["blanks", "  "],
      ["text", "abc"],
      ["text that begins with digits", "12abc"],
      ["null", null],
      ["undefined", undefined],
      ["true", true],
      ["false", false],
      ["an empty array", []],
      ["an array of one number", [7]],
      ["an object", {}],
      ["NaN", Number.NaN],
      ["infinity", Number.POSITIVE_INFINITY],
      ["infinity written as text", "Infinity"],
    ])(
      "keeps the previous value when given %s, which is not a number",
      (_name, value) => {
        expect(changed({ [key]: value })).toEqual({});
      },
    );
    it("takes a number, and a number written as a string, spaces around it or not", () => {
      expect(changed({ [key]: 40 })).toEqual({ [key]: 40 });
      expect(changed({ [key]: " 41 " })).toEqual({ [key]: 41 });
    });
    it("rounds to a whole number", () => {
      expect(changed({ [key]: 40.4 })).toEqual({ [key]: 40 });
      expect(changed({ [key]: "40.6" })).toEqual({ [key]: 41 });
    });
    it("takes the ends of its range", () => {
      expect(changed({ [key]: min })).toEqual({ [key]: min });
      expect(changed({ [key]: max })).toEqual({ [key]: max });
    });
  });

  it.each([
    ["idleTimeoutMinutes", 0, 1],
    ["idleTimeoutMinutes", -5, 1],
    ["idleTimeoutMinutes", 100_000, 1440],
    ["reindexQuietMinutes", 0, 1],
    ["reindexQuietMinutes", "500", 120],
    ["resultCount", 0, 1],
    ["resultCount", -3, 1],
    ["resultCount", 999, 50],
    ["resultCount", "51", 50],
  ])(
    "%s %j is out of range and becomes %j, the nearest value allowed",
    (key, value, expected) => {
      expect(changed({ [key]: value })).toEqual({ [key]: expected });
    },
  );
  // A port is not a quantity: the nearest allowed one is no more what was meant than any other.
  it.each([[0], [-1], [65_536], [70_000], ["0"], ["99999"], [0.4], [65_535.5]])(
    "port %j is out of range and the previous port is kept",
    (port) => {
      expect(changed({ port })).toEqual({});
    },
  );

  describe("QMD path", () => {
    it("is trimmed", () => {
      expect(changed({ qmdPath: " /opt/q md/qmd " })).toEqual({
        qmdPath: "/opt/q md/qmd",
      });
    });
    it.each([[""], ["   "], [5], [null], [undefined]])(
      "keeps the previous path when given %j",
      (qmdPath) => {
        expect(changed({ qmdPath })).toEqual({});
      },
    );
  });

  describe("extra PATH directories", () => {
    it("are normalised: trimmed, with empty entries dropped", () => {
      expect(changed({ extraPath: " /c : :/d:" })).toEqual({
        extraPath: "/c:/d",
      });
    });
    it.each([[""], ["   "], [" : "]])(
      "may be blank (%j), which means none",
      (extraPath) => {
        expect(changed({ extraPath })).toEqual({ extraPath: "" });
      },
    );
    it.each([[5], [null], [undefined]])(
      "keep the previous value when given %j, which is not text",
      (extraPath) => {
        expect(changed({ extraPath })).toEqual({});
      },
    );
  });

  it("applies every field of one patch by its own rule", () => {
    expect(
      changed({
        qmdPath: "  ",
        extraPath: "",
        collectionName: "bad name",
        port: "abc",
        idleTimeoutMinutes: 5000,
        reindexQuietMinutes: "3",
        resultCount: null,
      }),
    ).toEqual({
      extraPath: "",
      idleTimeoutMinutes: 1440,
      reindexQuietMinutes: 3,
    });
  });
});

describe("expandHome", () => {
  it.each([
    ["~", "/Users/alex"],
    ["~/", "/Users/alex/"],
    ["~/.npm-packages/bin/qmd", "/Users/alex/.npm-packages/bin/qmd"],
    ["~/my tools/qmd", "/Users/alex/my tools/qmd"],
  ])("reads a leading ~ in %j as the home folder", (path, expected) => {
    expect(expandHome(path, "/Users/alex")).toBe(expected);
  });

  it.each([
    ["qmd"],
    ["/usr/local/bin/qmd"],
    // Only the user's own home: no other user's, and no shell variables.
    ["~alex/bin/qmd"],
    ["~qmd"],
    ["~~/qmd"],
    ["$HOME/bin/qmd"],
    ["${HOME}/bin/qmd"],
    // Only at the start.
    ["bin/~/qmd"],
    ["/opt/~/qmd"],
    ["/opt/qmd~"],
    [""],
  ])("leaves %j as it is", (path) => {
    expect(expandHome(path, "/Users/alex")).toBe(path);
  });

  it.each([
    ["~/bin/qmd", "/Users/alex/", "/Users/alex/bin/qmd"],
    ["~", "/Users/alex/", "/Users/alex/"],
    ["~/bin/qmd", "/", "/bin/qmd"],
    ["~", "/", "/"],
  ])(
    "does not double the slash: %j with home %j is %j",
    (path, home, expected) => {
      expect(expandHome(path, home)).toBe(expected);
    },
  );

  // "~/bin/qmd" must never become "/bin/qmd", which is some other program.
  it.each([["~"], ["~/bin/qmd"]])(
    "leaves %j as it is when the home folder is not known",
    (path) => {
      expect(expandHome(path, "")).toBe(path);
    },
  );
});

describe("withHomeExpanded", () => {
  const typed: QmdSearchSettings = {
    qmdPath: "~/.npm-packages/bin/qmd",
    extraPath: "~/.local/bin:/opt/homebrew/bin:~:/srv/~/bin",
    collectionName: "Custom_1",
    port: 9000,
    idleTimeoutMinutes: 30,
    reindexQuietMinutes: 7,
    resultCount: 12,
  };

  it("expands the QMD path and each extra PATH directory, and nothing else", () => {
    expect(withHomeExpanded(typed, "/Users/alex")).toEqual({
      qmdPath: "/Users/alex/.npm-packages/bin/qmd",
      extraPath:
        "/Users/alex/.local/bin:/opt/homebrew/bin:/Users/alex:/srv/~/bin",
      collectionName: "Custom_1",
      port: 9000,
      idleTimeoutMinutes: 30,
      reindexQuietMinutes: 7,
      resultCount: 12,
    });
  });

  it("leaves the settings it was given as they were typed", () => {
    const before = { ...typed };
    withHomeExpanded(typed, "/Users/alex");
    expect(typed).toEqual(before);
  });

  it("gives the PATH of the spawned qmd the expanded directories", () => {
    const { qmdPath, extraPath } = withHomeExpanded(typed, "/Users/alex");
    expect(buildPath(qmdPath, extraPath, "/usr/bin:/bin")).toBe(
      "/Users/alex/.npm-packages/bin:/Users/alex/.local/bin:/opt/homebrew/bin:/Users/alex:/srv/~/bin:/usr/bin:/bin",
    );
  });
});
