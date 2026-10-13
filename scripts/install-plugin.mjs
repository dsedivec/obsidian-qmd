#!/usr/bin/env node
// Copies the built plugin into a vault:
//   node scripts/install-plugin.mjs <vault path> [--allow-protected]
// It refuses a vault listed in .protected-vaults unless --allow-protected is given. That file sits
// beside the README and is not in Git. It holds one vault path a line, for the vaults a build
// must not land in by accident; a leading ~ is the home folder, and a line that starts with # is
// a comment.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROTECTED_LIST = ".protected-vaults";
const ALLOW = "--allow-protected";
const PLUGIN_ID = "qmd-search";
const FILES = ["main.js", "manifest.json", "styles.css"];
const USAGE = `Usage: node scripts/install-plugin.mjs <vault path> [${ALLOW}]`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isDirectory(path) {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** True when both paths name one directory, whatever symlink or letter case they were written with. */
function sameDirectory(a, b) {
  const [statA, statB] = [a, b].map((path) =>
    statSync(path, { throwIfNoEntry: false }),
  );
  return (
    statA !== undefined &&
    statB !== undefined &&
    statA.dev === statB.dev &&
    statA.ino === statB.ino
  );
}

/** The vaults listed in the file at `listPath`, as absolute paths. None when there is no such file. */
function protectedVaults(listPath) {
  if (!existsSync(listPath)) return [];
  return readFileSync(listPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) =>
      line === "~" || line.startsWith("~/")
        ? join(homedir(), line.slice(1))
        : resolve(line),
    );
}

const args = process.argv.slice(2);
const options = args.filter((arg) => arg.startsWith("--"));
const paths = args.filter((arg) => !arg.startsWith("--"));
const unknown = options.find((option) => option !== ALLOW);
if (unknown !== undefined) fail(`Unknown option ${unknown}\n${USAGE}`);
if (paths.length !== 1) fail(USAGE);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const vault = resolve(paths[0]);
const guarded = protectedVaults(join(root, PROTECTED_LIST)).find(
  (listed) => vault === listed || sameDirectory(vault, listed),
);
if (guarded !== undefined && !options.includes(ALLOW)) {
  fail(
    `Refusing to install into ${guarded}, which ${PROTECTED_LIST} lists, without ${ALLOW}.`,
  );
}
if (!isDirectory(join(vault, ".obsidian"))) {
  fail(`${vault} is not an Obsidian vault: it has no .obsidian folder.`);
}

const missing = FILES.filter((file) => !existsSync(join(root, file)));
if (missing.length > 0)
  fail(`Missing ${missing.join(", ")} in ${root}. Run "npm run build" first.`);

const target = join(vault, ".obsidian", "plugins", PLUGIN_ID);
mkdirSync(target, { recursive: true });
for (const file of FILES) copyFileSync(join(root, file), join(target, file));
console.log(`Installed ${FILES.join(", ")} into ${target}`);
