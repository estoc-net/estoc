import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      // Lets a test collect garbage before it reads the resident set, so what it measures is what is held, not what is not yet freed.
      forks: { execArgv: ["--expose-gc"] },
    },
  },
});
