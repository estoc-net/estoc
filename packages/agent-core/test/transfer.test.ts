import { describe, expect, it } from "vitest";
import { createSeedKeystore } from "@estoc/keystore";

import {
  CONFIG_PATH,
  DELIVERIES_DIR,
  MESSAGES_DIR,
  MemoryBackend,
  Vault,
  deliveryStatusOf,
  foldDeliveries,
  importVault,
  newContact,
  newMessageRecord,
  snapshotVault,
  type ContactRecord,
  type PlainMessage,
  type VaultBackend,
} from "../src/index.js";

const SEED_A = new Uint8Array(32).map((_, i) => i);
const SEED_B = new Uint8Array(32).map((_, i) => 255 - i);
const dec = new TextDecoder();

function msg(id: string): PlainMessage {
  return { id, type: "https://didcomm.org/basicmessage/2.0/message", body: { content: id } };
}

async function vaultWith(seed: Uint8Array, label = "Alice"): Promise<{ backend: VaultBackend; vault: Vault }> {
  const backend = new MemoryBackend();
  const { doc, seedKey } = await createSeedKeystore("pw", { seed });
  const vault = await Vault.create(backend, {
    label,
    keystore: doc,
    seedKey,
    mediatorDid: "did:web:mediator.example",
  });
  return { backend, vault };
}

/** A second device of the same identity: restored from a snapshot of the first. */
async function restoreOf(backend: VaultBackend): Promise<{ backend: VaultBackend; vault: Vault }> {
  const other = new MemoryBackend();
  const outcome = await importVault(other, await snapshotVault(backend));
  expect(outcome.kind).toBe("restored");
  return { backend: other, vault: await Vault.open(other) };
}

describe("snapshot + import", () => {
  it("restores byte for byte into an empty backend", async () => {
    const { backend, vault } = await vaultWith(SEED_A);
    const bob = newContact("Bob", "did:peer:4bob", new Date(1_000));
    await vault.contacts.put(bob);
    await vault.messages.append(newMessageRecord({ direction: "out", msg: msg("m1") }, new Date(2_000)));
    await vault.messages.append(
      newMessageRecord({ direction: "in", sender: "did:peer:4bob", msg: msg("m2") }, new Date(3_000))
    );

    const files = await snapshotVault(backend);
    expect(Object.keys(files).sort()).toEqual([
      ".estoc/config.json",
      ".estoc/contacts/Bob.json",
      ".estoc/keystore.json",
      ".estoc/messages/0001.jsonl",
    ]);

    const other = new MemoryBackend();
    // m1 was written and never delivered: restored, it is held for a retry by hand
    expect(await importVault(other, files)).toEqual({ kind: "restored", files: 4, held: 1 });
    for (const path of Object.keys(files)) {
      expect(dec.decode((await other.read(path)) as Uint8Array)).toBe(dec.decode(files[path] as Uint8Array));
    }
    const restored = await Vault.open(other);
    expect(restored.config.identity.anchor.did).toBe(vault.config.identity.anchor.did);
    const records = await restored.messages.read();
    expect(records.map((r) => r.msg.id)).toEqual(["m1", "m2"]);
    expect((await restored.contacts.all()).map((c) => c.name)).toEqual(["Bob"]);
    const states = foldDeliveries(await restored.deliveries.read());
    expect(deliveryStatusOf(records[0]!, states)).toBe("held");
    expect(deliveryStatusOf(records[1]!, states)).toBeNull();
    expect((await other.list(DELIVERIES_DIR)).sort()).toEqual(["0001.jsonl"]);
  });

  it("carries deliveries along: sent stays sent, undelivered is held, and a hold is one device's own", async () => {
    const { backend: a, vault: va } = await vaultWith(SEED_A);
    const sent = newMessageRecord({ direction: "out", msg: msg("sent") }, new Date(2_000));
    const failed = newMessageRecord({ direction: "out", msg: msg("failed") }, new Date(3_000));
    const pending = newMessageRecord({ direction: "out", msg: msg("pending") }, new Date(4_000));
    for (const record of [sent, failed, pending]) await va.messages.append(record);
    await va.deliveries.append({ mid: sent.mid, at: "2026-08-17T00:00:01.000Z", status: "sent", attempt: 1, to: "did:peer:4bob" });
    await va.deliveries.append({ mid: failed.mid, at: "2026-08-17T00:00:02.000Z", status: "failed", attempt: 1, error: "fetch failed" });

    // restored elsewhere: the sent one is sent, the other two held — the
    // failed one keeping its count of tries
    const { backend: b, vault: vb } = await restoreOf(a);
    const onB = foldDeliveries(await vb.deliveries.read());
    expect(onB.get(sent.mid)).toMatchObject({ status: "sent", attempts: 1 });
    expect(onB.get(failed.mid)).toMatchObject({ status: "held", attempts: 1, error: expect.stringMatching(/retry by hand/) });
    expect(onB.get(pending.mid)).toMatchObject({ status: "held", attempts: 0 });

    // B tries the failed one by hand and it goes; B also writes one of its own and never sends it
    await vb.deliveries.append({ mid: failed.mid, at: "2026-08-17T00:01:00.000Z", status: "sent", attempt: 2, to: "did:peer:4bob" });
    const b1 = newMessageRecord({ direction: "out", msg: msg("b1") }, new Date(5_000));
    await vb.messages.append(b1);

    // B into A: A learns the failed one went (2 tries), b1 arrives and is
    // held here, and B's holds on A's own messages do not travel — the
    // pending one is still A's to send
    const outcome = await importVault(a, await snapshotVault(b));
    expect(outcome).toMatchObject({ kind: "merged", messagesAdded: 1, deliveriesAdded: 1, held: 1 });
    const onA = foldDeliveries(await va.deliveries.read());
    expect(onA.get(sent.mid)).toMatchObject({ status: "sent", attempts: 1 });
    expect(onA.get(failed.mid)).toMatchObject({ status: "sent", attempts: 2 });
    expect(onA.get(pending.mid)).toBeUndefined();
    expect(onA.get(b1.mid)).toMatchObject({ status: "held", attempts: 0 });
    expect((await a.list(DELIVERIES_DIR)).sort()).toEqual(["0001.jsonl", "0002.jsonl"]);

    // again: nothing new, nothing held twice
    expect(await importVault(a, await snapshotVault(b))).toMatchObject({ deliveriesAdded: 0, held: 0 });
    // A's tries after the merge count on from what it knows
    expect(foldDeliveries(await va.deliveries.read()).get(b1.mid)?.attempts).toBe(0);
  });

  it("merges a second device's snapshot: new messages in a new segment, contacts by updatedAt, nothing twice", async () => {
    // device A: two messages, one contact
    const { backend: a, vault: va } = await vaultWith(SEED_A);
    const bob = newContact("Bob", "did:peer:4bob", new Date(1_000));
    await va.contacts.put(bob);
    await va.messages.append(newMessageRecord({ direction: "out", msg: msg("a1") }, new Date(2_000)));
    await va.messages.append(
      newMessageRecord({ direction: "in", sender: "did:peer:4bob", msg: msg("a2") }, new Date(3_000))
    );

    // device B starts as a restore of A, then both diverge
    const { backend: b, vault: vb } = await restoreOf(a);
    await va.messages.append(newMessageRecord({ direction: "out", msg: msg("a3") }, new Date(4_000)));
    await vb.messages.append(newMessageRecord({ direction: "out", msg: msg("b1") }, new Date(5_000)));
    // the same wire message picked up on both devices: different mids, one message
    const shared = msg("shared");
    await va.messages.append(
      newMessageRecord({ direction: "in", sender: "did:peer:4bob", msg: shared }, new Date(6_000))
    );
    await vb.messages.append(
      newMessageRecord({ direction: "in", sender: "did:peer:4bob", msg: shared }, new Date(6_500))
    );
    // B renames Bob later than A last touched him (a tick later: put stamps
    // updatedAt to the millisecond, and a tie keeps ours); B also meets Carol
    await new Promise((resolve) => setTimeout(resolve, 5));
    const bobOnB = (await vb.contacts.byCid(bob.cid)) as ContactRecord;
    bobOnB.name = "Robert";
    await vb.contacts.put(bobOnB);
    const carol = newContact("Carol", "did:peer:4carol", new Date(7_000));
    await vb.contacts.put(carol);

    // B's snapshot into A
    const outcome = await importVault(a, await snapshotVault(b));
    expect(outcome).toMatchObject({
      kind: "merged",
      messagesAdded: 1, // b1
      messagesSkipped: 3, // a1, a2 (same mid), shared (same wire message)
      segment: "0002.jsonl",
      deliveriesAdded: 0,
      held: 1, // b1: written on B, never sent
      contactsAdded: 1, // Carol
      contactsUpdated: 1, // Bob → Robert
      contactsKept: 0,
      damaged: [],
    });
    expect((await a.list(MESSAGES_DIR)).sort()).toEqual(["0001.jsonl", "0002.jsonl"]);
    const merged = await Vault.open(a);
    expect((await merged.messages.read()).map((r) => r.msg.id)).toEqual(["a1", "a2", "a3", "shared", "b1"]);
    expect((await merged.contacts.all()).map((c) => c.name)).toEqual(["Robert", "Carol"]);
    // the file followed the name, and the old one is gone
    expect((await a.list(".estoc/contacts")).sort()).toEqual(["Carol.json", "Robert.json"]);
    // B's stamp survived the merge (no restamping on relay)
    expect(((await merged.contacts.byCid(bob.cid)) as ContactRecord).updatedAt).toBe(bobOnB.updatedAt);

    // importing the same snapshot again changes nothing
    expect(await importVault(a, await snapshotVault(b))).toMatchObject({
      kind: "merged",
      messagesAdded: 0,
      messagesSkipped: 4,
      segment: null,
      contactsAdded: 0,
      contactsUpdated: 0,
      contactsKept: 2,
    });
    expect((await a.list(MESSAGES_DIR)).sort()).toEqual(["0001.jsonl", "0002.jsonl"]);

    // A's local rename beats an older stamp from B on the way back
    await new Promise((resolve) => setTimeout(resolve, 5));
    const bobOnA = (await merged.contacts.byCid(bob.cid)) as ContactRecord;
    bobOnA.name = "Bobby";
    await merged.contacts.put(bobOnA);
    expect(await importVault(a, await snapshotVault(b))).toMatchObject({ contactsUpdated: 0, contactsKept: 2 });
    expect(((await merged.contacts.byCid(bob.cid)) as ContactRecord).name).toBe("Bobby");
  });

  it("carries invitations along: added when missing, marked taken when the other device saw the answer", async () => {
    const { backend: a, vault: va } = await vaultWith(SEED_A);
    const { seedKey } = await createSeedKeystore("pw", { seed: SEED_A });
    // (the seed key of A's keystore is not exposed by vaultWith; deriving on a
    // parallel keystore of the same seed mints the same DIDs)
    const first = await va.createInvitation(seedKey, "did:web:mediator.example", "Write to Alice");
    const { backend: b, vault: vb } = await restoreOf(a);
    expect((await vb.invitations.byId(first.record.id))?.did).toBe(first.record.did);

    // A issues a second one; B sees the first taken
    const second = await va.createInvitation(seedKey, "did:web:mediator.example", "Come talk");
    const takenOnB = { ...(await vb.invitations.byId(first.record.id))!, acceptedBy: "cid-bob", acceptedAt: "2026-08-15T00:00:00.000Z" };
    await vb.invitations.put(takenOnB);

    // merging B into A: the second stays, the first becomes taken here too
    const outcome = await importVault(a, await snapshotVault(b));
    expect(outcome.kind).toBe("merged");
    if (outcome.kind !== "merged") return;
    expect(outcome.invitationsAdded).toBe(0);
    const va2 = await Vault.open(a);
    expect((await va2.invitations.byId(first.record.id))?.acceptedBy).toBe("cid-bob");
    expect((await va2.invitations.byId(second.record.id))?.acceptedBy).toBeUndefined();
    // and A into B: the second arrives
    const back = await importVault(b, await snapshotVault(a));
    expect(back.kind === "merged" && back.invitationsAdded).toBe(1);
    expect((await Vault.open(b).then((v) => v.invitations.all())).map((i) => i.id).sort()).toEqual([first.record.id, second.record.id].sort());
  });

  it("refuses another identity's vault, and things that are not vaults", async () => {
    const { backend: a } = await vaultWith(SEED_A);
    const { backend: b } = await vaultWith(SEED_B, "Mallory");
    await expect(importVault(a, await snapshotVault(b))).rejects.toThrow(/different identity/);
    await expect(importVault(new MemoryBackend(), {})).rejects.toThrow(/not a vault/);
    const files = await snapshotVault(b);
    delete files[".estoc/keystore.json"];
    const empty = new MemoryBackend();
    await expect(importVault(empty, files)).rejects.toThrow(/keystore/);
    // it refused before writing anything
    expect(await empty.read(CONFIG_PATH)).toBeNull();
  });
});
