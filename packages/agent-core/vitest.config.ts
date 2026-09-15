import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20000,
    include: ["test/**/*.test.ts"],
    poolOptions: { forks: { execArgv: ["--expose-gc"] } },
  },
});
