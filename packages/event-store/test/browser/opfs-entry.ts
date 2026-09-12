/**
 * What runs in the browser: the backend cases against OPFS, each in a
 * directory of its own under the origin's root. Bundled by
 * `../opfs.test.ts`, which reads the results back.
 */

import { OpfsBackend } from "../../src/backend/opfs.js";
import { backendCases } from "../suite/backend-cases.js";

export interface CaseResult {
  name: string;
  error?: string;
}

declare global {
  interface Window {
    runBackendCases: () => Promise<CaseResult[]>;
  }
}

window.runBackendCases = async (): Promise<CaseResult[]> => {
  const root = await navigator.storage.getDirectory();
  let n = 0;
  const fresh = async (): Promise<OpfsBackend> => new OpfsBackend(await root.getDirectoryHandle(`case-${n++}`, { create: true }));
  const results: CaseResult[] = [];
  for (const c of backendCases) {
    try {
      await c.run(fresh);
      results.push({ name: c.name });
    } catch (err) {
      results.push({ name: c.name, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    }
  }
  return results;
};
