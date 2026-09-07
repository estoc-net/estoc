/**
 * What only OPFS can show, as cases run in a browser by
 * `../browser/opfs-entry.ts`: the platform without
 * `FileSystemFileHandle.move()`, where a fresh destination cannot be
 * filled whole (r1-B). No test framework is imported here, and nothing
 * runs at import time, so `../opfs.test.ts` can name the cases in Node.
 */

import type { OpfsBackend } from "../../src/backend/opfs.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

async function rejects(work: Promise<unknown>, pattern: RegExp, what: string): Promise<void> {
  try {
    await work;
  } catch (err) {
    if (pattern.test(err instanceof Error ? err.message : String(err))) return;
    throw new Error(`${what}: rejected with the wrong error: ${String(err)}`);
  }
  throw new Error(`${what}: did not reject`);
}

async function* one(text: string): AsyncIterable<Uint8Array> {
  yield enc.encode(text);
}

/** `work` run with `FileSystemFileHandle.move()` hidden, as a browser without it would present. */
async function withoutMove<T>(work: () => Promise<T>): Promise<T> {
  const proto = FileSystemFileHandle.prototype as unknown as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(proto, "move");
  Object.defineProperty(proto, "move", { value: undefined, configurable: true, writable: true });
  try {
    return await work();
  } finally {
    if (had) Object.defineProperty(proto, "move", had);
    else delete proto["move"];
  }
}

/** What only OPFS can show: the platform without `move()`, where a fresh destination cannot be filled whole (r1-B of A07); ownership named by one path whatever handle reaches it (r1-B of A08). */
export const opfsCases: { name: string; run: (fresh: () => Promise<OpfsBackend>) => Promise<void> }[] = [
  {
    name: "A08 r1-B: one place reached through two root handles and bases names one lock — the second take is refused, and served once the first releases",
    run: async () => {
      const storage = await navigator.storage.getDirectory();
      const outer = await storage.getDirectoryHandle(`alias-${Math.random().toString(16).slice(2)}`, { create: true });
      const nested = await outer.getDirectoryHandle("nested", { create: true });
      const { OpfsBackend: Backend } = await import("../../src/backend/opfs.js");
      const high = new Backend(outer);
      const low = new Backend(nested);
      const held = await high.own("nested/.estoc/local/owner.pid");
      await rejects(low.own(".estoc/local/owner.pid"), /owned elsewhere/, "the same place through a deeper root");
      await rejects(high.own("nested/.estoc/local/owner.pid"), /owned elsewhere/, "the same place through the same root");
      const other = await low.own(".estoc/local/other.pid");
      await other.release();
      await held.release();
      const taken = await low.own(".estoc/local/owner.pid");
      await rejects(high.own("nested/.estoc/local/owner.pid"), /owned elsewhere/, "held through the deeper root now");
      await taken.release();
    },
  },
  {
    name: "r1-B: without move(), create to a fresh path and rename to a fresh path refuse before touching it; rename over an existing file still works",
    run: async (fresh) => {
      const b = await fresh();
      await b.write("o/existing", enc.encode("old"));
      await b.write("s/src", enc.encode("src"));
      await withoutMove(async () => {
        await rejects(b.create("o/fresh", one("new")), /move/, "create to a fresh path");
        same(await b.size("o/fresh"), null, "nothing at the fresh path");
        same(await b.read("s/src"), enc.encode("src"), "the source is untouched");
        await rejects(b.rename("s/src", "o/fresh2"), /move/, "rename to a fresh path");
        same(await b.size("o/fresh2"), null, "nothing at the fresh destination");
        same(dec.decode((await b.read("s/src")) as Uint8Array), "src", "the source still stands");
        same((await b.list("o")).sort(), ["existing"], "only the existing file in the directory");
        await b.create("o/existing", one("replaced"));
        same(dec.decode((await b.read("o/existing")) as Uint8Array), "replaced", "create over an existing file");
        await b.rename("s/src", "o/existing");
        same(dec.decode((await b.read("o/existing")) as Uint8Array), "src", "rename over an existing file");
        same(await b.read("s/src"), null, "and the source is gone");
      });
    },
  },
  {
    name: "r1-B: a rename or create to a fresh path whose move() fails leaves no file at the destination",
    run: async (fresh) => {
      const b = await fresh();
      await b.write("s/src", enc.encode("src"));
      const proto = FileSystemFileHandle.prototype as unknown as { move: (...args: unknown[]) => Promise<void> };
      const original = proto.move;
      proto.move = async () => {
        throw new Error("publication interrupted");
      };
      try {
        await rejects(b.rename("s/src", "o/fresh"), /interrupted/, "rename");
        same(await b.size("o/fresh"), null, "nothing at the destination");
        same(dec.decode((await b.read("s/src")) as Uint8Array), "src", "the source still stands");
        await rejects(b.create("o/fresh", one("new")), /interrupted/, "create");
        same(await b.size("o/fresh"), null, "nothing at the path");
        same(await b.list("o"), [], "and no temp file beside it");
      } finally {
        proto.move = original;
      }
    },
  },
];
