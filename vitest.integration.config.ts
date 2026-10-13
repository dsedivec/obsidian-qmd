import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.itest.ts"],
    testTimeout: 600_000,
    fileParallelism: false,
  },
});
