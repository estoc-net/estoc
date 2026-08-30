import { describe, it } from "vitest";

import { backendCases, type Fresh } from "./backend-cases.js";

/** The backend cases as a vitest suite: memory and disk run it here, OPFS runs the same cases in a browser. */
export function backendSuite(name: string, fresh: Fresh): void {
  describe(`${name} backend`, () => {
    for (const c of backendCases) {
      it(c.name, () => c.run(fresh));
    }
  });
}
