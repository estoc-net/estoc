/**
 * What JavaScript holds on Node once garbage is collected: the heap
 * and the backing stores of its array buffers. The collector is taken
 * from V8 here, whatever flags the process was started with, so the
 * measure is the same under vitest's forks and under any other
 * runner. Collected twice: the backing stores of the array buffers a
 * collection frees are swept after it, concurrently, and the count
 * only drops once the sweep is done — which the next collection waits
 * for. `node:sqlite` exposes no count of what SQLite's allocator holds,
 * so none is reported.
 */

import v8 from "node:v8";
import vm from "node:vm";

import type { MemoryHeld } from "./driver-cases.js";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

export function heldOnNode(): MemoryHeld {
  gc();
  gc();
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return { javascript: heapUsed + arrayBuffers };
}
