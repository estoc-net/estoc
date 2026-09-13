/**
 * What the conformance suites get as `vitest` when they are bundled for
 * the Worker, where no test runner is: `describe` and `it` collect the
 * tests in the order they are declared instead of registering them,
 * and `expect` is vitest's own matchers over chai, so a suite asserts
 * in the Worker exactly what it asserts under vitest. The Worker takes
 * what was collected and runs it one test at a time.
 */

import { JestAsymmetricMatchers, JestChaiExpect, JestExtend, type ExpectStatic } from "@vitest/expect";
import * as chai from "chai";

chai.use(JestExtend);
chai.use(JestChaiExpect);
chai.use(JestAsymmetricMatchers);

export const expect = chai.expect as unknown as ExpectStatic;

export interface CollectedTest {
  /** The `describe` names down to the test's own, joined with ` > `. */
  name: string;
  run: () => Promise<void> | void;
}

const path: string[] = [];
const tests: CollectedTest[] = [];

export function describe(name: string, body: () => void): void {
  path.push(name);
  try {
    body();
  } finally {
    path.pop();
  }
}

export function it(name: string, body: () => Promise<void> | void): void {
  tests.push({ name: [...path, name].join(" > "), run: body });
}

export const test = it;

/** Takes every test collected since the last take. */
export function collected(): CollectedTest[] {
  return tests.splice(0);
}
