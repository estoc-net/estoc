import { defineConfig } from "vitest/config";

// The chunked-file tests hash a few MiB with a pure-JS sha-256; a cold CI runner
// takes several seconds for one, past vitest's default 5 s.
export default defineConfig({ test: { testTimeout: 30_000 } });
