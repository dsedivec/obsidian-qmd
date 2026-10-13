import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/"] },
  // main.js is the minified bundle that `npm run build` writes, and
  // tests/fixtures holds captured files that must stay byte-exact.
  { ignores: ["main.js", "tests/fixtures/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
