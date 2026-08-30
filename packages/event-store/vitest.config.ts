import { defineConfig } from "vitest/config";

// Chunked-blob tests hash a little over 1 MiB; a cold CI runner takes seconds for one.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    include: ["test/**/*.test.ts"],
  },
});
