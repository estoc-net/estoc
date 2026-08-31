import { describe, expect, it } from "vitest";

import { readObject, signRoot, verifyTree } from "@estoc/folder-object";

import { attachmentsOf, closureOf, OBJECT_SHARE, RAW_MEDIA_TYPE, verifyShare } from "../../src/index.js";
import type { MessageRecord, PlainMessage } from "../../src/v2/index.js";
import type { FakeMediator } from "../fake-mediator.js";
import { newMediator, newParty, recordsOf, withTimeout, type Party } from "./fixture.js";

describe("v2 agent sharing objects", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const files = {
    "index.json": enc(JSON.stringify({ format: "https://estoc.dev/post/1.0", id: "01900000-0000-7000-8000-000000000000", title: "Sea day" })),
    "files/body.dj": enc("# Sea day\n\nWaves.\n"),
    "files/images/dot.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]),
  };
  const object = readObject(files);

  async function eventually(cond: () => Promise<boolean>, what: string): Promise<void> {
    await withTimeout(
      (async () => {
        while (!(await cond())) await new Promise((r) => setTimeout(r, 5));
      })(),
      8000,
      what
    );
  }

  async function connected(): Promise<{ mediator: FakeMediator; alice: Party; bob: Party }> {
    const mediator = await newMediator();
    const alice = await newParty("Alice", 1, mediator);
    const bob = await newParty("Bob", 2, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]), 8000, "both live");
    await alice.agent.addContact(bob.agent.did as string, "Bob");
    return { mediator, alice, bob };
  }

  /** The one object-share record in `party`'s log. */
  async function shareRecordOf(party: Party): Promise<MessageRecord> {
    return (await recordsOf(party)).find((r) => r.msg?.type === OBJECT_SHARE) as MessageRecord;
  }

  it("hands a contact a whole tree in one message, signed by the anchor, kept block by block", async () => {
    const { alice, bob } = await connected();
    const { root, blocks } = await closureOf(files);
    expect(blocks.size).toBe(6); // three directory nodes, three raw files
    const sent = await alice.agent.shareObject(bob.agent.did as string, object, { sign: true });
    expect(sent.msg?.type).toBe(OBJECT_SHARE);
    expect((sent.msg?.body as { root: string }).root).toBe(root);
    expect(sent.msg?.attachments).toHaveLength(blocks.size);
    // the sender keeps the blocks too, and the record's skeleton holds the root
    expect(sent.skeleton.attachments).toEqual([root]);
    expect(await alice.v.vault.blobs.has(root)).toBe(true);

    await eventually(() => bob.v.vault.blobs.has(root), "bob's copy");
    const fromBlobs = new Map<string, Uint8Array>();
    for (const cid of blocks.keys()) {
      expect(await bob.v.vault.blobs.has(cid)).toBe(true);
      fromBlobs.set(cid, (await bob.v.vault.blobs.getBlock(cid)) as Uint8Array);
    }
    const tree = await verifyTree(root, fromBlobs);
    expect([...tree.files.keys()].sort()).toEqual(["files/body.dj", "files/images/dot.png", "index.json"]);

    // the record is in Bob's log naming the root, and its card names
    // Alice's anchor — not the pairwise DID the envelope came from
    const record = await shareRecordOf(bob);
    expect(record.skeleton.attachments).toEqual([root]);
    const share = await verifyShare(record.msg as PlainMessage);
    expect(share.card).toEqual({ did: alice.v.anchor.did, root });
    expect(share.card?.did).toMatch(/^did:key:/);
    expect(share.object.meta.title).toBe("Sea day");
    expect(bob.log.some((l) => /post\/1.0 .* \(signed by did:key:.*\): 3 files kept/.test(l))).toBe(true);
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("shares an object without a card: the envelope says who handed it over, nobody stands behind it", async () => {
    const { alice, bob } = await connected();
    const { root } = await closureOf(files);
    const sent = await alice.agent.shareObject(bob.agent.did as string, object);
    expect(sent.msg?.body).toEqual({ root });
    await eventually(() => bob.v.vault.blobs.has(root), "bob's copy");
    const share = await verifyShare((await shareRecordOf(bob)).msg as PlainMessage);
    expect(share.card).toBeNull();
    expect(share.root).toBe(root);
    expect(share.object.meta.title).toBe("Sea day");
    expect(bob.log.some((l) => /post\/1.0 .* \(unsigned\): 3 files kept/.test(l))).toBe(true);
    // one card per share: sign it or pass one on, not both
    await expect(alice.agent.shareObject(bob.agent.did as string, object, { sign: true, card: "x.y.z" })).rejects.toThrow(
      /one card/
    );
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("does not keep a share whose card is about another root, or one with no root at all", async () => {
    const { alice, bob } = await connected();
    const { root, blocks } = await closureOf(files);
    const other = await closureOf({ ...files, "files/body.dj": enc("edited") });
    const anchor = alice.v.anchor;
    const signer = (await alice.v.keys.derive(anchor.key)).signer;
    const card = await signRoot(anchor.did, other.root, signer);
    await alice.agent.send(bob.agent.did as string, OBJECT_SHARE, { root, card }, { attachments: attachmentsOf(blocks) });
    await eventually(async () => bob.log.some((l) => /does not verify.*the card is about/.test(l)), "bob's refusal");
    await alice.agent.send(bob.agent.did as string, OBJECT_SHARE, { card: await signRoot(anchor.did, root, signer) }, {
      attachments: attachmentsOf(blocks),
    });
    await eventually(async () => bob.log.some((l) => /does not verify.*object-share message has no root/.test(l)), "no root");
    for (const cid of blocks.keys()) {
      expect(await bob.v.vault.blobs.has(cid)).toBe(false);
    }
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("passes a signed object on under its author's card, and refuses a card about another object", async () => {
    const { mediator, alice, bob } = await connected();
    const carol = await newParty("Carol", 3, mediator);
    await carol.agent.start();
    await withTimeout(carol.live, 8000, "carol live");
    const { root } = await closureOf(files);
    await alice.agent.shareObject(bob.agent.did as string, object, { sign: true });
    await eventually(() => bob.v.vault.blobs.has(root), "bob's copy");
    const record = await shareRecordOf(bob);
    const card = (record.msg?.body as { card: string }).card;

    await bob.agent.addContact(carol.agent.did as string, "Carol");
    await bob.agent.shareObject(carol.agent.did as string, object, { card });
    await eventually(() => carol.v.vault.blobs.has(root), "carol's copy");
    const carols = await shareRecordOf(carol);
    expect((await verifyShare(carols.msg as PlainMessage)).card?.did).toBe(alice.v.anchor.did);

    await expect(
      bob.agent.shareObject(carol.agent.did as string, readObject({ ...files, "files/body.dj": enc("edited") }), { card })
    ).rejects.toThrow(/not this object/);
    alice.agent.destroy();
    bob.agent.destroy();
    carol.agent.destroy();
  });

  it("logs but does not keep a share whose blocks do not match its card", async () => {
    const { alice, bob } = await connected();
    const { root, blocks } = await closureOf(files);
    const anchor = alice.v.anchor;
    const card = await signRoot(anchor.did, root, (await alice.v.keys.derive(anchor.key)).signer);
    const attachments = attachmentsOf(blocks).map((a) =>
      a.media_type === RAW_MEDIA_TYPE && a.byte_count === files["files/body.dj"].length
        ? { ...a, data: { base64: attachmentsOf(new Map([[a.id, enc("# Forged\n")]]))[0]!.data.base64 } }
        : a
    );
    await alice.agent.send(bob.agent.did as string, OBJECT_SHARE, { root, card }, { attachments });
    await eventually(async () => bob.log.some((l) => /does not verify/.test(l)), "bob's refusal");
    for (const cid of blocks.keys()) {
      expect(await bob.v.vault.blobs.has(cid)).toBe(false);
    }
    // recorded as it came all the same: a fact about what arrived
    expect((await recordsOf(bob)).some((r) => r.msg?.type === OBJECT_SHARE)).toBe(true);
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("does not keep a well-hashed tree that is not an object", async () => {
    const { alice, bob } = await connected();
    const notAnObject = { "readme.txt": enc("just a folder") };
    const { root, blocks } = await closureOf(notAnObject);
    await alice.agent.send(bob.agent.did as string, OBJECT_SHARE, { root }, { attachments: attachmentsOf(blocks) });
    await eventually(async () => bob.log.some((l) => /does not verify.*malformed object/.test(l)), "bob's refusal");
    for (const cid of blocks.keys()) {
      expect(await bob.v.vault.blobs.has(cid)).toBe(false);
    }
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("refuses to share more than one message should carry", async () => {
    const mediator = await newMediator();
    const alice = await newParty("Alice", 1, mediator, { maxShareBytes: 16 });
    const bob = await newParty("Bob", 2, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]), 8000, "both live");
    await expect(alice.agent.shareObject(bob.agent.did as string, object)).rejects.toThrow(/at most 16/);
    alice.agent.destroy();
    bob.agent.destroy();
  });
});
