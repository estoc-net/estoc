import { MemoryVault } from "@estoc/event-store/v3";
import { importSeed } from "@estoc/keystore";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

import { Keys, closeErasures, collectGarbage, eraseMessage, erasureClosure, rawCidOfBytes, scanVault, vaultHeldRoots, type Cid, type MessageId } from "../../src/v3/index.js";
import { SEED, Scene, cidOf } from "./fold/helpers.js";
import { intent, packageOf, receipt, resolved, vaults } from "./fold/scene.js";

const encoder = new TextEncoder();

/** A vault in memory holding the scene's events and the bytes of every text named. */
async function vaultOf(scene: Scene, texts: readonly string[] = []): Promise<MemoryVault> {
  const vault = new MemoryVault({ metadata: { version: 3, anchor: await Keys.anchorOf(await importSeed(SEED)) } });
  for (const text of texts) await vault.stores.objects.putObject(cidOf(text), encoder.encode(text));
  await vault.ingest(scene.events);
  return vault;
}

const has = (vault: MemoryVault, cid: Cid) => vault.vault.objects.has(cid);

describe("erasing a message", () => {
  it("releases every root the message's events and packages still name in one erase, collects what nothing else holds, and erases nothing twice", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const attachment = cidOf("attachment");
    const out = intent(scene, a0, b0, { attachmentCids: [attachment] });
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    const other = intent(scene, a0, b0, { bodyCid: out.data.bodyCid });
    const vault = await vaultOf(scene, [`body ${out.data.messageId}`, "attachment", `envelope ${pkg.data.packageId}`]);
    expect(await has(vault, attachment)).toBe(true);

    const { events, collected } = await eraseMessage(vault, keys, out.data.messageId);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ messageId: out.data.messageId, dropCids: [attachment, out.data.bodyCid, pkg.data.envelopeCid].sort(), because: "user" });
    expect(events[0]!.roots).toEqual([]);
    expect(collected.removed.sort()).toEqual([attachment, pkg.data.envelopeCid].sort());
    expect(await has(vault, out.data.bodyCid)).toBe(true);
    expect(await has(vault, attachment)).toBe(false);
    const fold = await scanVault(vault.vault, keys);
    expect(fold.held.has(out.data.bodyCid)).toBe(true);
    expect(fold.retained.filter((edge) => edge.eventId === other.eventId)).toEqual([{ eventId: other.eventId, root: out.data.bodyCid }]);

    const again = await eraseMessage(vault, keys, out.data.messageId);
    expect(again.events).toEqual([]);
    expect(again.collected.removed).toEqual([]);
    expect((await eraseMessage(vault, keys, uuidv7() as MessageId)).events).toEqual([]);
  });

  it("the closure erases what an event learned later names under the same message, with the first erasure's reason", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const first = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1 });
    const before = scene.events.length;
    const attachment = cidOf("late attachment");
    const duplicate = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, wire: first.data.wireMessageId, overrides: { attachmentCids: [attachment] } });
    expect(duplicate.data.messageId).toBe(first.data.messageId);
    const late = scene.events.splice(before);
    const vault = await vaultOf(scene, [`body ${first.data.wireMessageId}`]);

    const erased = await eraseMessage(vault, keys, first.data.messageId, "contact-deleted");
    expect(erased.events.map((event) => event.data)).toEqual([{ messageId: first.data.messageId, dropCids: [first.data.bodyCid], because: "contact-deleted" }]);
    expect(erased.collected.removed).toEqual([first.data.bodyCid]);
    scene.add("message.erased", { messageId: first.data.messageId, dropCids: [first.data.bodyCid], because: "user" });

    await vault.stores.objects.putObject(attachment, encoder.encode("late attachment"));
    await vault.ingest(late);
    let fold = await scanVault(vault.vault, keys);
    expect(fold.held.has(attachment)).toBe(true);
    const owed = erasureClosure(fold);
    expect(owed.map((draft) => draft.data)).toEqual([{ messageId: first.data.messageId, dropCids: [attachment], because: "contact-deleted" }]);
    const closed = await closeErasures(vault, keys);
    expect(closed.events.map((event) => event.data)).toEqual(owed.map((draft) => draft.data));
    expect(closed.collected.removed).toEqual([attachment]);
    fold = await scanVault(vault.vault, keys);
    expect(erasureClosure(fold)).toEqual([]);
    expect((await closeErasures(vault, keys)).events).toEqual([]);
  });

  it("hands the event store the same retention for collection, export and validation", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const out = intent(scene, a0, b0);
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    scene.add("message.erased", { messageId: out.data.messageId, dropCids: [pkg.data.envelopeCid], because: "user" });
    const stray = rawCidOfBytes(encoder.encode("stray"));
    const vault = await vaultOf(scene, [`body ${out.data.messageId}`, `envelope ${pkg.data.packageId}`, "stray"]);
    expect(new Set(await vaultHeldRoots(keys)(vault.vault))).toEqual(new Set([root.data.documentCid, out.data.bodyCid]));
    const collected = await collectGarbage(vault, keys);
    expect(collected.removed.sort()).toEqual([pkg.data.envelopeCid, stray].sort());
    expect(await has(vault, out.data.bodyCid)).toBe(true);
  });
});
