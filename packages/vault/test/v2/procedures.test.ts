import { describe, expect, it } from "vitest";

import { MemoryVault, exportVault, importVault } from "@estoc/event-store";

import {
  VaultFold,
  collectBlobs,
  deleteContact,
  eraseMessage,
  holdImported,
  importPolicy,
  noteFirstSeen,
  notePeerResolved,
  readRoot,
  record,
  recordMessage,
  sweepDeleted,
  drafts,
} from "../../src/v2/index.js";
import { DEV_A, DEV_B, Line, peerKey } from "./helpers.js";

const enc = new TextEncoder();

/** A vault whose clock the test moves, with no collection grace. */
function vaultAt(self: string): { vault: MemoryVault; tick: (ms: number) => void } {
  let t = new Date("2026-08-30T00:00:00.000Z").getTime();
  const vault = new MemoryVault({ self, clock: () => new Date((t += 1)), graceMs: 0 });
  return { vault, tick: (ms) => (t += ms) };
}

const bob = peerKey(31);
const pair = { myKey: "did/k1", peerKey: bob.fingerprint };

describe("v2 procedures: bodies and erasing", () => {
  it("records a message body first, skeleton naming it, blobs listed twice", async () => {
    const { vault } = vaultAt(DEV_A);
    const fold = new VaultFold(DEV_A);
    const mid = new Line().id();
    const event = await recordMessage(vault, fold, "out", enc.encode("hello"), { ...pair, mid, wireId: "w", msgType: "m", attachments: [] });
    const message = fold.message(mid);
    expect(message?.direction).toBe("out");
    expect(message?.skeleton.bytes).toBe(5);
    expect(event.blobs).toEqual([message?.skeleton.body]);
    expect(await vault.blobs.get(message?.skeleton.body as string)).toEqual(enc.encode("hello"));
    expect(message?.delivery?.status).toBe("pending");
  });

  it("erases: event first, collection unlinks what nothing holds, the reader sees erased", async () => {
    const { vault, tick } = vaultAt(DEV_A);
    const fold = new VaultFold(DEV_A);
    const mid = new Line().id();
    await recordMessage(vault, fold, "in", enc.encode("secret"), { ...pair, mid, wireId: "w", msgType: "m", attachments: [] });
    const body = fold.message(mid)?.skeleton.body as string;
    expect(await readRoot(vault.blobs, fold, mid, body)).toEqual({ state: "present" });

    const erased = await eraseMessage(vault.events, fold, mid, "user");
    expect(erased?.type).toBe("message.erased");
    expect(erased?.blobs).toEqual([]); // an erase references nothing (§8.1)
    // erased is asked before the blocks: the bytes are still there
    expect(await vault.blobs.has(body)).toBe(true);
    expect(await readRoot(vault.blobs, fold, mid, body)).toEqual({ state: "erased" });

    tick(1000);
    const collected = await collectBlobs(vault.blobs, fold);
    expect(collected.unlinked).toEqual([body]);
    expect(await vault.blobs.has(body)).toBe(false);
    expect(await readRoot(vault.blobs, fold, mid, body)).toEqual({ state: "erased" });
    // erasing again drops nothing new
    expect(await eraseMessage(vault.events, fold, mid, "user")).toBeNull();
  });

  it("a root absent with no erase reads as missing, never as a deletion", async () => {
    const { vault } = vaultAt(DEV_A);
    const other = new MemoryVault();
    const fold = new VaultFold(DEV_A);
    const mid = new Line().id();
    const body = await other.blobs.put(enc.encode("never copied"));
    await record(vault.events, fold, drafts.messageIn({ ...pair, mid, wireId: "w", msgType: "m", bytes: 12, body, attachments: [] }));
    expect(await readRoot(vault.blobs, fold, mid, body)).toEqual({ state: "missing" });
  });

  it("dedupes channel.firstSeen per device and peer.resolved per result", async () => {
    const { vault } = vaultAt(DEV_A);
    const fold = new VaultFold(DEV_A);
    const seen = { ...pair, peerPublicKey: bob.multibase, kind: "authcrypt" as const };
    expect(await noteFirstSeen(vault.events, fold, seen)).not.toBeNull();
    expect(await noteFirstSeen(vault.events, fold, seen)).toBeNull();

    const resolved = { ...pair, did: "did:peer:4bob", keys: [bob.multibase], service: "did:peer:2r" };
    expect(await notePeerResolved(vault.events, fold, resolved)).not.toBeNull();
    expect(await notePeerResolved(vault.events, fold, resolved)).toBeNull();
    expect(await notePeerResolved(vault.events, fold, { ...resolved, keys: [] })).not.toBeNull();
    // and back: the latest for the DID is what differs or not
    expect(await notePeerResolved(vault.events, fold, resolved)).not.toBeNull();
  });
});

describe("v2 procedures: deleting a contact (§9)", () => {
  async function contactScene() {
    const { vault, tick } = vaultAt(DEV_A);
    const fold = new VaultFold(DEV_A);
    const line = new Line();
    const cid = line.id();
    const mid1 = line.id();
    const mid2 = line.id();
    await record(vault.events, fold, drafts.didMinted({ key: "did/k1", did: "did:peer:4k1", routingDid: "did:peer:2r", mediation: null }));
    await record(vault.events, fold, drafts.didPublished({ key: "did/k1", as: "oob", uses: "one", oobId: "o1" }));
    await record(vault.events, fold, drafts.contactCreated({ cid }));
    await record(vault.events, fold, drafts.contactAttached({ ...pair, cid, because: "invitation", oobId: "o1" }));
    await recordMessage(vault, fold, "in", enc.encode("hello"), { ...pair, mid: mid1, wireId: "w1", msgType: "m", attachments: [] });
    await recordMessage(vault, fold, "out", enc.encode("welcome"), { ...pair, mid: mid2, wireId: "w2", msgType: "m", attachments: [] });
    return { vault, tick, fold, cid, mid1, mid2 };
  }

  it("tombstones, erases the channels, retires the key, collects", async () => {
    const { vault, tick, fold, cid, mid1, mid2 } = await contactScene();
    const bodies = [fold.message(mid1)?.skeleton.body, fold.message(mid2)?.skeleton.body] as string[];
    tick(1000);
    const deleted = await deleteContact(vault, fold, cid);
    expect(deleted.tombstones).toHaveLength(1);
    expect(deleted.erased).toHaveLength(2);
    expect(deleted.retired.map((event) => event.data)).toEqual([{ key: "did/k1", because: "contact-deleted" }]);
    expect(deleted.collected.unlinked.sort()).toEqual([...bodies].sort());
    expect(fold.contact(cid)).toBeNull();
    expect(fold.attribution(pair)).toEqual({ kind: "deleted", cids: [cid] });
    expect(fold.myKey("did/k1")?.retired?.because).toBe("contact-deleted");
    // idempotent: a second sweep sees nothing left to erase
    expect(await sweepDeleted(vault.events, fold)).toEqual([]);
  });

  it("another device sweeps what the deleting device had not seen", async () => {
    const { vault, fold, cid, mid1 } = await contactScene();
    await deleteContact(vault, fold, cid);
    // a late outbound of B's lands after the deletion
    const line = new Line("2026-08-30T01:00:00.000Z");
    const late = line.id();
    const other = new MemoryVault();
    const body = await other.blobs.put(enc.encode("late"));
    await vault.events.ingest([line.next(DEV_B, "message.out", { ...pair, mid: late, wireId: "w9", msgType: "m", bytes: 4, body, attachments: [] }, [body])]);
    const refolded = await VaultFold.of(vault.events, DEV_A);
    const swept = await sweepDeleted(vault.events, refolded);
    expect(swept).toHaveLength(1);
    expect(refolded.erased(late, body)).toBe(true);
    expect(refolded.erased(mid1, refolded.message(mid1)?.skeleton.body as string)).toBe(true);
  });

  it("finishes a deletion interrupted after the tombstone", async () => {
    const { vault, tick, fold, cid, mid1, mid2 } = await contactScene();
    await record(vault.events, fold, drafts.contactDeleted({ cid })); // the crash: only the tombstone landed
    tick(1000);
    const deleted = await deleteContact(vault, fold, cid);
    expect(deleted.tombstones).toEqual([]);
    expect(deleted.erased).toHaveLength(2);
    expect(deleted.retired.map((event) => event.data)).toEqual([{ key: "did/k1", because: "contact-deleted" }]);
    expect(deleted.collected.unlinked).toHaveLength(2);
    expect(fold.erased(mid1, fold.message(mid1)?.skeleton.body as string)).toBe(true);
    expect(fold.erased(mid2, fold.message(mid2)?.skeleton.body as string)).toBe(true);
    expect(fold.myKey("did/k1")?.retired?.because).toBe("contact-deleted");
  });

  it("a retry after a late merge touches nothing live", async () => {
    const { vault, fold, cid } = await contactScene();
    await deleteContact(vault, fold, cid);
    const line = new Line("2026-08-30T01:00:00.000Z");
    const other = line.id();
    await record(vault.events, fold, drafts.contactCreated({ cid: other }));
    await record(vault.events, fold, drafts.contactMerged({ cid: other, from: cid }));
    const again = await deleteContact(vault, fold, cid);
    expect(again.tombstones).toEqual([]); // the tombstone covers only what it names (§9 step 1)
    expect(again.retired).toEqual([]);
    expect(fold.contact(other)?.cid).toBe(other);
    expect(fold.contact(other)?.hidden).toEqual([cid]);
  });

  it("tombstones every member of a merged contact as one write", async () => {
    const { vault, fold, cid } = await contactScene();
    const line = new Line("2026-08-30T01:00:00.000Z");
    const other = line.id();
    await record(vault.events, fold, drafts.contactCreated({ cid: other }));
    await record(vault.events, fold, drafts.contactMerged({ cid: other, from: cid }));
    const deleted = await deleteContact(vault, fold, cid);
    expect(deleted.tombstones.map((event) => (event.data as { cid: string }).cid).sort()).toEqual([cid, other].sort());
    expect(new Set(deleted.tombstones.map((event) => event.at)).size).toBe(1); // one write, one instant
    expect(fold.contact(cid)).toBeNull();
    expect(fold.contact(other)).toBeNull();
    expect(fold.deletedContacts().map((entry) => [...entry.members].sort())).toEqual([[cid, other].sort()]);
  });

  it("keeps a key another contact still uses", async () => {
    const { vault, fold, cid } = await contactScene();
    const line = new Line("2026-08-30T01:00:00.000Z");
    const other = line.id();
    await record(vault.events, fold, drafts.contactCreated({ cid: other }));
    await record(vault.events, fold, drafts.contactUseKey({ cid: other, key: "did/k1", because: "minted" }));
    const deleted = await deleteContact(vault, fold, cid);
    expect(deleted.retired).toEqual([]);
    expect(fold.myKey("did/k1")?.retired).toBeNull();
  });
});

describe("v2 procedures: merge (§10)", () => {
  it("import policy: erased blobs stay out, purged extensions stay gone, foreign roots come along", async () => {
    const alice = vaultAt(DEV_A);
    const fold = new VaultFold(DEV_A);
    await alice.vault.files.write("config.json", enc.encode(JSON.stringify({ format: "estoc", version: 2 })));
    const line = new Line();
    const mid1 = line.id();
    const mid2 = line.id();
    const att = await alice.vault.blobs.put(enc.encode("a picture"));
    await recordMessage(alice.vault, fold, "in", enc.encode("hello"), { ...pair, mid: mid1, wireId: "w1", msgType: "m", attachments: [att] });
    await recordMessage(alice.vault, fold, "out", enc.encode("welcome"), { ...pair, mid: mid2, wireId: "w2", msgType: "m", attachments: [] });
    await record(alice.vault.events, fold, drafts.deliveryAttempted({ ...pair, mid: mid2, attempt: 1, outcome: "failed", error: "offline" }));
    await eraseMessage(alice.vault.events, fold, mid1, "user", [att]);
    // an extension with a store, then purged; another alive
    const gone = line.id();
    const alive = line.id();
    await alice.vault.extension(gone).events.append({ type: "onion.peeled", data: { layer: 1 } });
    const aliveRoot = await alice.vault.extension(alive).blobs.put(enc.encode("kept"));
    await alice.vault.extension(alive).events.append({ type: "onion.peeled", blobs: [aliveRoot], data: {} });
    await record(alice.vault.events, fold, drafts.extensionInstalled({ ext: gone, name: "gone" }));
    await record(alice.vault.events, fold, drafts.extensionInstalled({ ext: alive, name: "alive" }));
    await record(alice.vault.events, fold, drafts.extensionPurged({ ext: gone }));

    const files = await exportVault(alice.vault);
    const bob = new MemoryVault();
    const imported = await importVault(bob, files, importPolicy());
    expect(imported.kind).toBe("restored");
    const body1 = fold.message(mid1)?.skeleton.body as string;
    expect(await bob.blobs.has(body1)).toBe(true);
    expect(await bob.blobs.has(att)).toBe(false); // erased: never copied in again
    expect(await bob.extensions()).toEqual([alive].sort());
    expect(await bob.extension(alive).blobs.has(aliveRoot)).toBe(true);

    // held after merge: the other device's unsent out gets one hold from self, once
    const refolded = await VaultFold.of(bob.events);
    const held = await holdImported(bob.events, refolded);
    expect(held.map((event) => event.data["mid"])).toEqual([mid2]);
    expect(refolded.delivery(mid2)?.status).toBe("held");
    expect(await holdImported(bob.events, refolded)).toEqual([]);
  });

  it("does not hold self's own unsent outbox, nor what is sent", async () => {
    const { vault } = vaultAt(DEV_A);
    const fold = new VaultFold(DEV_A);
    const line = new Line();
    const mine = line.id();
    const sent = line.id();
    await recordMessage(vault, fold, "out", enc.encode("mine"), { ...pair, mid: mine, wireId: "w1", msgType: "m", attachments: [] });
    const other = new MemoryVault();
    const body = await other.blobs.put(enc.encode("sent already"));
    await vault.events.ingest([
      line.next(DEV_B, "message.out", { ...pair, mid: sent, wireId: "w2", msgType: "m", bytes: 12, body, attachments: [] }, [body]),
      line.next(DEV_B, "delivery.attempted", { ...pair, mid: sent, attempt: 1, outcome: "sent" }),
    ]);
    const refolded = await VaultFold.of(vault.events, DEV_A);
    expect(await holdImported(vault.events, refolded)).toEqual([]);
  });
});
