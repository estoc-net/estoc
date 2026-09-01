import { defineConfig } from "vitest/config";

// One vitest run over every package: their test files share one pool of
// workers, instead of each package's run waiting for the one before it.
// A package's own vitest.config.ts still applies to its project.
export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});
