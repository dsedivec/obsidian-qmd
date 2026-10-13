#!/usr/bin/env node
// Copies the built plugin into a vault:
//   node scripts/install-plugin.mjs <vault path> [--allow-main]
// It refuses Dale's Main vault unless --allow-main is given.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAIN_VAULT = "/Users/alex/Documents/Obsidian/Main";
const PLUGIN_ID = "qmd-search";
const FILES = ["main.js", "manifest.json", "styles.css"];
const USAGE =
  "Usage: node scripts/install-plugin.mjs <vault path> [--allow-main]";

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

const args = process.argv.slice(2);
const options = args.filter((arg) => arg.startsWith("--"));
const paths = args.filter((arg) => !arg.startsWith("--"));
const unknown = options.find((option) => option !== "--allow-main");
if (unknown !== undefined) fail(`Unknown option ${unknown}\n${USAGE}`);
if (paths.length !== 1) fail(USAGE);

const vault = resolve(paths[0]);
if (
  (vault === MAIN_VAULT || sameDirectory(vault, MAIN_VAULT)) &&
  !options.includes("--allow-main")
) {
  fail(
    `Refusing to install into the Main vault (${MAIN_VAULT}) without --allow-main.`,
  );
}
if (!isDirectory(join(vault, ".obsidian"))) {
  fail(`${vault} is not an Obsidian vault: it has no .obsidian folder.`);
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const missing = FILES.filter((file) => !existsSync(join(root, file)));
if (missing.length > 0)
  fail(`Missing ${missing.join(", ")} in ${root}. Run "npm run build" first.`);

const target = join(vault, ".obsidian", "plugins", PLUGIN_ID);
mkdirSync(target, { recursive: true });
for (const file of FILES) copyFileSync(join(root, file), join(target, file));
console.log(`Installed ${FILES.join(", ")} into ${target}`);
