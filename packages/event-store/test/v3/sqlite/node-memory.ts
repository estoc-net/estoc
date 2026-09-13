/**
 * What JavaScript holds on Node once garbage is collected: the heap
 * and the backing stores of its array buffers. `gc` is there when
 * `--expose-gc` is given, as `vitest.config.ts` gives it to the forks;
 * without it, what is not yet freed counts too. Collected twice: the
 * backing stores of the array buffers a collection frees are swept
 * after it, concurrently, and the count only drops once the sweep is
 * done — which the next collection waits for.
 */
export function heldOnNode(): number {
  const { gc } = globalThis as { gc?: () => void };
  gc?.();
  gc?.();
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
}
