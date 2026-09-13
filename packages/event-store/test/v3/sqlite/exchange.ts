/**
 * A portable snapshot crossing platforms, in the parts either side
 * runs: a sample vault filled with what the format carries — text
 * with control characters and numbers of every JSON kind in the
 * events' data, a type outside ASCII, an event of a second author, the
 * empty object, one across a chunk boundary and one of bytes that are
 * no text — to be exported; the inspection of a snapshot, every
 * logical value in it as the vault reads them, which the two platforms
 * must agree on for one file; and the continuation, a restore of the
 * snapshot with one more commit, exported again to travel back the way
 * it came.
 */

import { MemoryVault, SqliteVault, exportVault, restoreVault, validatePortable, type Cid, type Draft, type Event, type Exported, type OpenDestination, type PortableDatabase, type Validated, type VaultMetadata, type VaultRuntime, type WrappedSeed } from "../../../src/v3/index.js";
import { ANCHOR, META, WRAPPED } from "../fixtures.js";
import { authorN } from "../suite/helpers.js";
import { HELLO, HELLO_CID, MIB, all, bytesOf, cidOf, drain, rootsOf } from "./vault-cases.js";

const EMPTY = new Uint8Array(0);
const EMPTY_CID = cidOf(EMPTY);
const ACROSS = bytesOf(MIB + 1, 3);
const ACROSS_CID = cidOf(ACROSS);
const NO_TEXT = bytesOf(300, 5);
const NO_TEXT_CID = cidOf(NO_TEXT);
const REPLY = new TextEncoder().encode("from the other platform");
const REPLY_CID = cidOf(REPLY);

const KINDS = {
  text: `héllo 🌍 nul${String.fromCharCode(0)} tab${String.fromCharCode(9)} quote" backslash${String.fromCharCode(92)}`,
  negative: -1,
  largest: Number.MAX_SAFE_INTEGER,
  fraction: 0.1,
  exponent: 1e21,
  yes: true,
  nothing: null,
  list: [1, "two", [3, { four: 4 }]],
  nested: { a: { b: "c" } },
};

/** Fills `runtime` with the sample: two commits of its own a second apart, then a second author's event ingested. Returns every event, in the order made. */
export async function fillSample(runtime: VaultRuntime, clock: { now: () => number; advance: (ms: number) => void }): Promise<Event[]> {
  const own = await runtime.vault.commit(
    [
      { cid: HELLO_CID, source: HELLO },
      { cid: EMPTY_CID, source: EMPTY },
      { cid: ACROSS_CID, source: ACROSS },
    ],
    [
      { type: "test.événement", roots: [HELLO_CID, EMPTY_CID], data: KINDS },
      { type: "test.plain", roots: [ACROSS_CID], data: {} },
    ]
  );
  clock.advance(1000);
  const later = await runtime.vault.commit([{ cid: NO_TEXT_CID, source: NO_TEXT }], [{ type: "test.binary", roots: [NO_TEXT_CID], data: { n: 2 } }]);
  const other = new MemoryVault({ metadata: META, wrapped: WRAPPED, author: authorN(7), now: clock.now });
  const foreign = await other.vault.commit([{ cid: HELLO_CID, source: HELLO }], [{ type: "test.foreign", roots: [HELLO_CID], data: { from: "elsewhere" } }]);
  await runtime.ingest(foreign);
  return [...own, ...later, ...foreign];
}

export interface InspectedObject {
  cid: Cid;
  codec: string;
  size: number;
  bytes: number[];
}

/** Every logical value of a snapshot, as the vault over it reads them: what one file must inspect as on either platform. */
export interface Inspection {
  metadata: VaultMetadata;
  wrapped: WrappedSeed;
  validated: Validated;
  events: Event[];
  objects: InspectedObject[];
}

export async function inspectPortable(portable: PortableDatabase): Promise<Inspection> {
  const validated = await validatePortable(portable, { heldRoots: rootsOf });
  const events = await all(portable.vault.events.scan());
  const objects: InspectedObject[] = [];
  for await (const cid of portable.vault.objects.list()) {
    const info = await portable.vault.objects.stat(cid);
    const stream = await portable.vault.objects.open(cid);
    if (info === null || stream === null) throw new Error(`${cid} is listed but not there`);
    objects.push({ cid, codec: info.codec, size: info.size, bytes: Array.from(await drain(stream)) });
  }
  objects.sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  return { metadata: portable.metadata, wrapped: portable.wrapped, validated, events, objects };
}

const reply: Draft = { type: "test.reply", roots: [REPLY_CID], data: { from: "the other platform" } };

/** Restores `snapshot` into the runtime `restoreTo` creates, commits one more event over one more object there, and exports that runtime to `exportTo`. */
export async function continued(snapshot: PortableDatabase, restoreTo: OpenDestination, exportTo: OpenDestination, now: () => number): Promise<Exported> {
  const { runtime } = await restoreVault(snapshot, restoreTo, { heldRoots: rootsOf, anchor: ANCHOR });
  const vault = new SqliteVault(runtime, { now });
  try {
    await vault.vault.commit([{ cid: REPLY_CID, source: REPLY }], [reply]);
    return await exportVault(vault, exportTo, { heldRoots: rootsOf });
  } finally {
    await vault.close();
  }
}
