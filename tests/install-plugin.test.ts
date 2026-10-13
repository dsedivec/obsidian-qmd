import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../scripts/install-plugin.mjs");
const FILES = ["main.js", "manifest.json", "styles.css"];

// The script finds the built files, and the list of protected vaults, beside its own folder. Each
// test runs a copy of it in a throwaway "repository", with a home folder of its own.
describe("install-plugin", () => {
  let tmp: string;
  let repo: string;
  let home: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "qmd-search-install-")));
    repo = join(tmp, "repo");
    home = join(tmp, "home");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    mkdirSync(home);
    copyFileSync(SCRIPT, join(repo, "scripts", "install-plugin.mjs"));
    for (const file of FILES) writeFileSync(join(repo, file), `built ${file}`);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeVault(path: string): string {
    mkdirSync(join(path, ".obsidian"), { recursive: true });
    return path;
  }
  function protect(...lines: string[]): void {
    writeFileSync(join(repo, ".protected-vaults"), lines.join("\n") + "\n");
  }
  function run(...args: string[]): { code: number | null; err: string } {
    const result = spawnSync(
      process.execPath,
      [join(repo, "scripts", "install-plugin.mjs"), ...args],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    );
    return { code: result.status, err: result.stderr };
  }
  function installed(vault: string): boolean {
    return FILES.every((file) =>
      existsSync(join(vault, ".obsidian", "plugins", "qmd-search", file)),
    );
  }

  it("copies the three built files into a vault", () => {
    const vault = makeVault(join(tmp, "Notes"));
    expect(run(vault)).toEqual({ code: 0, err: "" });
    for (const file of FILES)
      expect(
        readFileSync(
          join(vault, ".obsidian", "plugins", "qmd-search", file),
          "utf8",
        ),
      ).toBe(`built ${file}`);
  });

  it("refuses a folder that is not a vault", () => {
    const folder = join(tmp, "Plain");
    mkdirSync(folder);
    const { code, err } = run(folder);
    expect(code).toBe(1);
    expect(err).toContain("is not an Obsidian vault");
  });

  it("refuses a vault listed in .protected-vaults, and installs nothing", () => {
    const vault = makeVault(join(tmp, "Real"));
    protect(vault);
    const { code, err } = run(vault);
    expect(code).toBe(1);
    expect(err).toContain(vault);
    expect(err).toContain("--allow-protected");
    expect(installed(vault)).toBe(false);
  });

  it("installs into a protected vault when given --allow-protected", () => {
    const vault = makeVault(join(tmp, "Real"));
    protect(vault);
    expect(run(vault, "--allow-protected")).toEqual({ code: 0, err: "" });
    expect(installed(vault)).toBe(true);
  });

  it("refuses a protected vault that is reached through a symlink", () => {
    const vault = makeVault(join(tmp, "Real"));
    const link = join(tmp, "Link");
    symlinkSync(vault, link);
    protect(vault);
    expect(run(link).code).toBe(1);
    expect(installed(vault)).toBe(false);
  });

  it("reads one vault a line, skipping blank lines and comments", () => {
    const real = makeVault(join(tmp, "Real"));
    const other = makeVault(join(tmp, "Other"));
    const free = makeVault(join(tmp, "Free"));
    protect("# vaults a build must not land in by accident", "", other, real);
    expect(run(real).code).toBe(1);
    expect(run(other).code).toBe(1);
    expect(run(free).code).toBe(0);
    expect([installed(real), installed(other), installed(free)]).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("reads a leading ~ in a listed path as the home folder", () => {
    const vault = makeVault(join(home, "Vaults", "Real"));
    protect("~/Vaults/Real");
    expect(run(vault).code).toBe(1);
    expect(installed(vault)).toBe(false);
  });

  it("installs anywhere when there is no .protected-vaults file", () => {
    const vault = makeVault(join(home, "Vaults", "Real"));
    expect(run(vault).code).toBe(0);
    expect(installed(vault)).toBe(true);
  });

  it("refuses an option it does not know", () => {
    const vault = makeVault(join(tmp, "Notes"));
    const { code, err } = run(vault, "--allow-main");
    expect(code).toBe(1);
    expect(err).toContain("Unknown option --allow-main");
    expect(installed(vault)).toBe(false);
  });
});
