import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      // Lets a test collect garbage before it measures what JavaScript holds, so what is not yet freed does not count.
      forks: { execArgv: ["--expose-gc"] },
    },
  },
});
