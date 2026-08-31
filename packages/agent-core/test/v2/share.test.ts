import { describe, expect, it } from "vitest";

import { readObject, signRoot, verifyTree } from "@estoc/folder-object";

import { MemoryBackend } from "@estoc/event-store";

import { attachmentsOf, BLOB_PUT_RESULT, closureOf, closureSize, OBJECT_SHARE, RAW_MEDIA_TYPE, verifyShare } from "../../src/index.js";
import { placePackage, type MediatorLink, type MessageRecord, type PlainMessage, type Placing, type WireNote } from "../../src/v2/index.js";
import { network, type FakeMediator } from "../fake-mediator.js";
import { newMediator, newParty, recordsOf, until, withTimeout, type Party } from "./fixture.js";

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

  /** `maxShareBytes` set to the minimal closure's size: every share of `object` takes the package road. */
  async function squeezedOver(mediator: FakeMediator, fills: [number, number], over: { fetch?: typeof fetch; webSocket?: typeof WebSocket; packageTimeoutMs?: number; backend?: MemoryBackend } = {}): Promise<{ alice: Party; bob: Party }> {
    const { minimal } = await closureOf(files);
    const alice = await newParty("Alice", fills[0], mediator, { maxShareBytes: closureSize(minimal), packageTimeoutMs: 200, ...over });
    const bob = await newParty("Bob", fills[1], mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]), 8000, "both live");
    await alice.agent.addContact(bob.agent.did as string, "Bob");
    return { alice, bob };
  }

  it("a package upload that never settles fails the share at the deadline, signal or no signal", async () => {
    const mediator = await newMediator({ blobs: true });
    // the store grants the upload; the line to it swallows the PUT whole, ignoring its signal
    const deafPut: typeof fetch = (input, init) => (init?.method === "PUT" ? new Promise<Response>(() => undefined) : mediator.fetch(input, init));
    const { alice, bob } = await squeezedOver(mediator, [1, 2], { fetch: deafPut });
    await expect(alice.agent.shareObject(bob.agent.did as string, object)).rejects.toThrow(/timeout|abort/i);
    // the put was made, the bytes never arrived: the pending placement is the store's to expire
    expect([...(mediator.blobs?.values() ?? [])].every((blob) => blob.bytes === null)).toBe(true);
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("a trace store that never answers lets no upload out and fails the share at the deadline", async () => {
    const decoder = new TextDecoder();
    class Parked extends MemoryBackend {
      override async append(path: string, data: Uint8Array): Promise<void> {
        if (path.includes("/local/agent/trace/") && decoder.decode(data).includes('"what":"package"')) {
          await new Promise<void>(() => undefined);
        }
        return super.append(path, data);
      }
    }
    const mediator = await newMediator({ blobs: true });
    const { alice, bob } = await squeezedOver(mediator, [1, 2], { backend: new Parked() });
    await expect(alice.agent.shareObject(bob.agent.did as string, object)).rejects.toThrow(/timeout|abort/i);
    // the note before the PUT jammed: nothing went out, the put stayed pending
    expect([...(mediator.blobs?.values() ?? [])].every((blob) => blob.bytes === null)).toBe(true);
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("a package body that stalls after its headers fails the fetch at the deadline", async () => {
    const mediator = await newMediator({ blobs: true });
    const { minimal } = await closureOf(files);
    const alice = await newParty("Alice", 1, mediator, { maxShareBytes: closureSize(minimal) });
    // the GET answers at once and then never yields a byte, signal ignored
    const stalled: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({}), { status: 200 });
    const bob = await newParty("Bob", 2, mediator, { packageFetch: stalled, packageTimeoutMs: 200 });
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]), 8000, "both live");
    await alice.agent.addContact(bob.agent.did as string, "Bob");
    await alice.agent.shareObject(bob.agent.did as string, object);
    await eventually(async () => (await recordsOf(bob)).some((r) => r.msg?.type === OBJECT_SHARE), "bob's share");
    const record = await shareRecordOf(bob);
    await expect(bob.agent.fetchPackage(record)).rejects.toThrow(/timeout|abort/i);
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("two shares of one object at once are one package: the placing single-flights", async () => {
    const mediator = await newMediator({ blobs: true });
    const { alice, bob } = await squeezedOver(mediator, [1, 2]);
    const carol = await newParty("Carol", 3, mediator);
    await carol.agent.start();
    await withTimeout(carol.live, 8000, "carol live");
    await alice.agent.addContact(carol.agent.did as string, "Carol");
    const [toBob, toCarol] = await Promise.all([
      alice.agent.shareObject(bob.agent.did as string, object),
      alice.agent.shareObject(carol.agent.did as string, object),
    ]);
    expect(mediator.blobs?.size).toBe(1);
    expect([...(mediator.blobs?.values() ?? [])][0]?.bytes).not.toBeNull();
    const packageId = (msg: MessageRecord) => (msg.msg?.body as { package: { attachment_id: string } }).package.attachment_id;
    expect(packageId(toCarol)).toBe(packageId(toBob));
    alice.agent.destroy();
    bob.agent.destroy();
    carol.agent.destroy();
  });

  it("a package placed under one mediation is not probed under the next: the cache is the store's", async () => {
    const one = await newMediator({ blobs: true });
    const two = await newMediator({ blobs: true, fill: 230, http: "http://mediator-two/", ws: "ws://mediator-two/ws" });
    const net = network(one, two);
    // `network` routes by exact endpoint; blob uploads live under the mediator's path
    const routed: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const owner = [one, two].find((m) => url.startsWith(m.http));
      return owner === undefined ? Promise.resolve(new Response("not found", { status: 404 })) : owner.fetch(input, init);
    };
    const { minimal } = await closureOf(files);
    const alice = await newParty("Alice", 1, one, { maxShareBytes: closureSize(minimal), fetch: routed, webSocket: net.WebSocket });
    const bob = await newParty("Bob", 2, one);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]), 8000, "both live");
    await alice.agent.addContact(bob.agent.did as string, "Bob");
    await alice.agent.shareObject(bob.agent.did as string, object);
    expect(one.blobs?.size).toBe(1);

    await alice.agent.setMediator(two.did);
    await withTimeout(until(() => alice.agent.status.state === "live"), 8000, "live at two");
    const carol = await newParty("Carol", 3, one);
    await carol.agent.start();
    await withTimeout(carol.live, 8000, "carol live");
    await alice.agent.addContact(carol.agent.did as string, "Carol");
    await alice.agent.shareObject(carol.agent.did as string, object);
    // one placement at the new store, whole — no probe of the old mediation's hash left pending on its books
    expect(two.blobs?.size).toBe(1);
    expect([...(two.blobs?.values() ?? [])][0]?.bytes).not.toBeNull();
    alice.agent.destroy();
    bob.agent.destroy();
    carol.agent.destroy();
  });

  /** A fetch whose first PUT hangs forever, signal ignored; every later request goes through. */
  function flakyPut(mediator: FakeMediator): typeof fetch {
    const gate = { deaf: true };
    return (input, init) => {
      if (init?.method === "PUT" && gate.deaf) {
        gate.deaf = false;
        return new Promise<Response>(() => undefined);
      }
      return mediator.fetch(input, init);
    };
  }

  it("retries a failed upload with the same hash: one reservation on the books, then its bytes", async () => {
    const mediator = await newMediator({ blobs: true });
    const { alice, bob } = await squeezedOver(mediator, [1, 2], { fetch: flakyPut(mediator) });
    await expect(alice.agent.shareObject(bob.agent.did as string, object)).rejects.toThrow(/timeout|abort/i);
    expect(mediator.blobs?.size).toBe(1);
    // the line healed: the retry re-puts the same hash and sends the same bytes to the fresh grant
    await alice.agent.shareObject(bob.agent.did as string, object);
    expect(mediator.blobs?.size).toBe(1);
    const [blob] = [...(mediator.blobs?.values() ?? [])];
    expect(blob?.bytes?.length).toBe(blob?.size);
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("shares meeting a failure recover one at a time: one reservation, one upload", async () => {
    const mediator = await newMediator({ blobs: true });
    const { alice, bob } = await squeezedOver(mediator, [1, 2], { fetch: flakyPut(mediator) });
    const carol = await newParty("Carol", 3, mediator);
    const dave = await newParty("Dave", 4, mediator);
    await Promise.all([carol.agent.start(), dave.agent.start()]);
    await withTimeout(Promise.all([carol.live, dave.live]), 8000, "both live");
    await alice.agent.addContact(carol.agent.did as string, "Carol");
    await alice.agent.addContact(dave.agent.did as string, "Dave");
    const settled = await Promise.allSettled([
      alice.agent.shareObject(bob.agent.did as string, object),
      alice.agent.shareObject(carol.agent.did as string, object),
      alice.agent.shareObject(dave.agent.did as string, object),
    ]);
    // the first turn ate the dead line; the next retried the same hash, the last reused it
    expect(settled.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(mediator.blobs?.size).toBe(1);
    expect([...(mediator.blobs?.values() ?? [])][0]?.bytes).not.toBeNull();
    alice.agent.destroy();
    bob.agent.destroy();
    carol.agent.destroy();
    dave.agent.destroy();
  });

  it("frees a placement whose bytes the store lost before placing afresh", async () => {
    const mediator = await newMediator({ blobs: true });
    const { alice, bob } = await squeezedOver(mediator, [1, 2]);
    await alice.agent.shareObject(bob.agent.did as string, object);
    expect(mediator.blobs?.size).toBe(1);
    const before = [...(mediator.blobs?.keys() ?? [])][0] as string;
    // the store loses the bytes but keeps the reservation on its books
    const row = mediator.blobs?.get(before);
    if (row !== undefined) {
      row.bytes = null;
    }
    await alice.agent.shareObject(bob.agent.did as string, object);
    // our ciphertext is long gone: the dead reservation is deleted, not left beside the new one
    expect(mediator.blobs?.size).toBe(1);
    const [hash] = [...(mediator.blobs?.keys() ?? [])];
    expect(hash).not.toBe(before);
    expect(mediator.blobs?.get(hash as string)?.bytes).not.toBeNull();
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("a delete that fails fails the turn, the dead reservation still ours to free", async () => {
    const mediator = await newMediator({ blobs: true });
    const gate = { failAt: -1, count: 0 };
    const flaky: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "POST" && url === mediator.http) {
        gate.count += 1;
        if (gate.count === gate.failAt) {
          gate.failAt = -1;
          return Promise.reject(new Error("the line dropped"));
        }
      }
      return mediator.fetch(input, init);
    };
    const { alice, bob } = await squeezedOver(mediator, [1, 2], { fetch: flaky });
    await alice.agent.shareObject(bob.agent.did as string, object);
    expect(mediator.blobs?.size).toBe(1);
    const before = [...(mediator.blobs?.keys() ?? [])][0] as string;
    const row = mediator.blobs?.get(before);
    if (row !== undefined) {
      row.bytes = null;
    }
    // the renewal put goes through; the delete right behind it hits the cut
    gate.count = 0;
    gate.failAt = 2;
    await expect(alice.agent.shareObject(bob.agent.did as string, object)).rejects.toThrow(/line dropped/);
    // nothing was placed over the dead reservation while it stands
    expect([...(mediator.blobs?.keys() ?? [])]).toEqual([before]);
    // the next share finds the placement still held: the delete is retried, then placed afresh
    await alice.agent.shareObject(bob.agent.did as string, object);
    expect(mediator.blobs?.size).toBe(1);
    const [hash] = [...(mediator.blobs?.keys() ?? [])];
    expect(hash).not.toBe(before);
    expect(mediator.blobs?.get(hash as string)?.bytes).not.toBeNull();
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("a put the store refused lets the ciphertext go; a cut line keeps it for the retry", async () => {
    const closure = await closureOf(files);
    const note: WireNote = async () => undefined;
    const quiet = () => undefined;
    const okPut: typeof fetch = async () => new Response(null, { status: 200 });
    const store = { cut: true };
    const link = {
      roundTrip: async (_type: string, body: Record<string, unknown>) => {
        if (store.cut) {
          throw new Error("the line is down");
        }
        const hash = body.hash as string;
        return {
          id: "answer",
          type: BLOB_PUT_RESULT,
          body: {
            hash,
            url: `http://store/${hash}`,
            retain_until: "2027-01-01T00:00:00.000Z",
            upload: { url: `http://store/${hash}?token=t`, expires: "2027-01-01T00:00:00.000Z" },
          },
        };
      },
    } as unknown as MediatorLink;
    const packages = new Map<string, Placing>();
    // the line is down: the result is unknown, the ciphertext stays for the retry
    await expect(placePackage(link, packages, "m", closure, okPut, 500, note, quiet)).rejects.toThrow(/line is down/);
    const slot = [...packages.values()][0] as Placing;
    expect(slot.prepared).not.toBeNull();
    const kept = slot.prepared?.hash as string;
    store.cut = false;
    const placed = await placePackage(link, packages, "m", closure, okPut, 500, note, quiet);
    expect(placed.hash).toBe(kept); // the same bytes went up

    // a refusal is an answer: no reservation stands, the buffer goes with the turn
    const refusing = {
      roundTrip: async () => ({
        id: "answer",
        type: "https://didcomm.org/report-problem/2.0/problem-report",
        body: { code: "e.p.blob.too-large", comment: "at most 65536 bytes" },
      }),
    } as unknown as MediatorLink;
    const refused = new Map<string, Placing>();
    await expect(placePackage(refusing, refused, "m", closure, okPut, 500, note, quiet)).rejects.toThrow(/will not keep the package/);
    expect(([...refused.values()][0] as Placing).prepared).toBeNull();
  });
});
