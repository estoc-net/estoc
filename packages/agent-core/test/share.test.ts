import { describe, expect, it } from "vitest";

import { blobHash, encodeCar, isDagPbCid, readObject, signRoot, verifyTree } from "@estoc/folder-object";

import { MemoryBackend } from "@estoc/event-store";

import {
  BLOB_PUT_RESULT,
  OBJECT_SHARE,
  PROBLEM_REPORT,
  RAW_MEDIA_TYPE,
  attachmentsOf,
  closureOf,
  closureSize,
  encryptStream,
  missingBytes,
  placePackage,
  verifyShare,
  type MediatorLink,
  type MessageRecord,
  type Placing,
  type PlainMessage,
  type WireNote,
} from "../src/index.js";
import { BLOB_MAX, MEDIATOR_HTTP, network, type FakeMediator } from "./fake-mediator.js";
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

    // anything short of a blob-coded problem-report settles nothing: the bytes stay for the retry
    for (const answer of [
      { type: "https://didcomm.org/basicmessage/2.0/message", body: {} },
      { type: PROBLEM_REPORT, body: { code: "e.p.me.res.storage", comment: "not about blobs" } },
      { type: PROBLEM_REPORT, body: { code: "e.p.blob.internal", comment: "a code the spec does not define" } },
    ]) {
      const odd = new Map<string, Placing>();
      const oddLink = { roundTrip: async () => ({ id: "answer", ...answer }) } as unknown as MediatorLink;
      await expect(placePackage(oddLink, odd, "m", closure, okPut, 500, note, quiet)).rejects.toThrow(/answered .* to the put/);
      const held = [...odd.values()][0] as Placing;
      expect(held.prepared).not.toBeNull();
      const heldHash = held.prepared?.hash as string;
      // the mediator comes back to its senses: the retry sends the very same hash
      const retried = await placePackage(link, odd, "m", closure, okPut, 500, note, quiet);
      expect(retried.hash).toBe(heldHash);
    }
  });

  it("takes the package road when the closure does not fit: skeleton and index.json inline, the closure as an encrypted CAR at the mediator", async () => {
    const mediator = await newMediator({ blobs: true });
    const { root, blocks, minimal } = await closureOf(files);
    expect(minimal.size).toBe(4); // three directory nodes and index.json
    const { alice, bob } = await squeezedOver(mediator, [1, 2]);
    const sent = await alice.agent.shareObject(bob.agent.did as string, object, { sign: true });
    const attachments = (sent.msg as PlainMessage).attachments as { id: string; media_type: string; byte_count: number; data: Record<string, unknown> }[];
    expect(attachments).toHaveLength(5);
    expect(attachments.slice(0, 4).map((a) => a.id).sort()).toEqual([...minimal.keys()].sort());
    const pkg = attachments[4] as (typeof attachments)[number];
    expect(pkg.media_type).toBe("application/vnd.ipld.car");
    // the store holds the ciphertext, whole, checked against its hash, served at an id that is not the hash
    const stored = mediator.blobs?.get(pkg.id);
    expect(stored?.bytes?.length).toBe(pkg.byte_count);
    expect(pkg.data).toEqual({ links: [`${MEDIATOR_HTTP}b/${stored?.id}`], hash: pkg.id });
    expect(stored?.id).not.toBe(pkg.id);
    const named = ((sent.msg as PlainMessage).body as { package: { attachment_id: string; ciphering: { algorithm: string; parameters: { key: string } }; available_until: string } }).package;
    expect(named.attachment_id).toBe(pkg.id);
    expect(named.ciphering.algorithm).toBe("AES256_GCM_HKDF_1MB");
    expect(Date.parse(named.available_until)).toBeGreaterThan(Date.now());
    // the sender keeps every block regardless
    for (const cid of blocks.keys()) expect(await alice.v.vault.blobs.has(cid)).toBe(true);

    // Bob has the skeleton; the leaves are named, sized and packaged, not here
    await eventually(() => bob.v.vault.blobs.has(root), "bob's skeleton");
    const bodyCid = [...blocks.keys()].find((c) => !minimal.has(c)) as string;
    expect(await bob.v.vault.blobs.has(bodyCid)).toBe(false);
    const record = await shareRecordOf(bob);
    const partial = await verifyShare(record.msg as PlainMessage);
    expect(partial.complete).toBe(false);
    expect(partial.card?.did).toBe(alice.v.anchor.did);
    expect(partial.object.meta.title).toBe("Sea day");
    expect(Object.keys(partial.object.tree)).toEqual(["index.json"]);
    expect([...partial.tree.partial.keys()].sort()).toEqual(["files/body.dj", "files/images/dot.png"]);
    const lacking = files["files/body.dj"].length + files["files/images/dot.png"].length;
    expect(missingBytes(partial.tree)).toBe(lacking);
    expect(partial.package).toMatchObject({ hash: pkg.id, byteCount: pkg.byte_count, url: `${MEDIATOR_HTTP}b/${stored?.id}`, availableUntil: named.available_until });
    expect(partial.packageProblem).toBeNull();
    expect(partial.package?.key.length).toBe(32);
    expect(bob.log.some((l) => l.includes(`3 files kept, 2 awaiting ${lacking} bytes (${pkg.byte_count} bytes packaged at`))).toBe(true);

    // whenever Bob likes: fetch, check, open, fill in
    const whole = await bob.agent.fetchPackage(record);
    expect(whole.complete).toBe(true);
    expect(Object.keys(whole.object.tree).sort()).toEqual(["files/body.dj", "files/images/dot.png", "index.json"]);
    expect(await bob.v.vault.blobs.has(bodyCid)).toBe(true);
    expect((await verifyShare(record.msg as PlainMessage)).complete).toBe(false); // the message alone is still what it was
    expect((await verifyShare(record.msg as PlainMessage, (cid) => bob.v.vault.blobs.getBlock(cid))).complete).toBe(true);
    expect(await bob.agent.fetchPackage(record)).toMatchObject({ complete: true }); // already whole: nothing fetched

    // a second share of the same object reuses the one package
    const carol = await newParty("Carol", 3, mediator);
    await carol.agent.start();
    await withTimeout(carol.live, 8000, "carol live");
    await alice.agent.addContact(carol.agent.did as string, "Carol");
    const again = await alice.agent.shareObject(carol.agent.did as string, object);
    expect(((again.msg as PlainMessage).attachments as { id: string }[])[4]?.id).toBe(pkg.id);
    expect(mediator.blobs?.size).toBe(1);
    alice.agent.destroy();
    bob.agent.destroy();
    carol.agent.destroy();
  });

  it("fetches a package only from the one http(s) URL it names, and only byte_count bytes of it", async () => {
    const mediator = await newMediator({ blobs: true });
    const { alice, bob } = await squeezedOver(mediator, [1, 2]);
    await alice.agent.shareObject(bob.agent.did as string, object, { sign: true });
    await eventually(async () => (await recordsOf(bob)).some((r) => r.msg?.type === OBJECT_SHARE), "bob's share");
    const record = await shareRecordOf(bob);
    type Pkg = { id: string; media_type: string; byte_count: number; data: { links: string[]; hash: string } };
    const pkgOf = (msg: PlainMessage): Pkg => (msg.attachments as Pkg[])[4] as Pkg;
    const url = pkgOf(record.msg as PlainMessage).data.links[0];
    const variant = (edit: (pkg: Pkg) => void): MessageRecord => {
      const msg = structuredClone(record.msg) as PlainMessage;
      edit(pkgOf(msg));
      return { ...record, msg };
    };

    // not one URL, or not an http(s) one without credentials: a package named but unusable, said so
    for (const links of [[], [url, url], ["ftp://fake-mediator/b/x"], [`http://user:pw@fake-mediator/b/x`], ["/b/x"], [42]]) {
      const bad = variant((pkg) => {
        pkg.data.links = links as string[];
      });
      const seen = await verifyShare(bad.msg as PlainMessage);
      expect(seen.package).toBeNull();
      expect(seen.packageProblem).toMatch(/exactly one http\(s\) URL/);
      expect(seen.complete).toBe(false); // the skeleton is still a verified, partial share
      await expect(bob.agent.fetchPackage(bad)).rejects.toThrow(/cannot use: .*exactly one http/);
    }
    // the body entry itself: unknown cipher, no attachment, no date — each its own problem; absent is no package at all
    type Body = { package?: { attachment_id: string; ciphering: { algorithm: string }; available_until?: string } };
    const bodyVariant = (edit: (body: Body) => void): MessageRecord => {
      const msg = structuredClone(record.msg) as PlainMessage;
      edit(msg.body as Body);
      return { ...record, msg };
    };
    const cases: [(body: Body) => void, RegExp][] = [
      [
        (b) => {
          (b.package as { ciphering: { algorithm: string } }).ciphering.algorithm = "XCHACHA20_POLY1305";
        },
        /unsupported ciphering XCHACHA20_POLY1305/,
      ],
      [
        (b) => {
          (b.package as { attachment_id: string }).attachment_id = "bciqnope";
        },
        /no attachment bciqnope/,
      ],
      [
        (b) => {
          delete (b.package as { available_until?: string }).available_until;
        },
        /no available_until/,
      ],
      [
        (b) => {
          (b as { package: unknown }).package = "yes";
        },
        /not an object/,
      ],
    ];
    for (const [edit, problem] of cases) {
      const seen = await verifyShare(bodyVariant(edit).msg as PlainMessage);
      expect(seen.package).toBeNull();
      expect(seen.packageProblem).toMatch(problem);
    }
    const none = await verifyShare(
      bodyVariant((b) => {
        delete b.package;
      }).msg as PlainMessage
    );
    expect(none.package).toBeNull();
    expect(none.packageProblem).toBeNull();
    await expect(
      bob.agent.fetchPackage(
        bodyVariant((b) => {
          delete b.package;
        })
      )
    ).rejects.toThrow(/names no package to fetch/);
    // the store's bytes must be exactly byte_count: fewer promised, the download stops short of the rest
    const short = variant((pkg) => {
      pkg.byte_count -= 1;
    });
    await expect(bob.agent.fetchPackage(short)).rejects.toThrow(/should be \d+ bytes, the response/);
    const long = variant((pkg) => {
      pkg.byte_count += 1;
    });
    await expect(bob.agent.fetchPackage(long)).rejects.toThrow(/should be \d+ bytes, the response/);
    // a package attachment that is not a CAR: named but unusable
    const notCar = variant((pkg) => {
      pkg.media_type = "application/zip";
    });
    expect((await verifyShare(notCar.msg as PlainMessage)).packageProblem).toMatch(/application\/zip, not application\/vnd\.ipld\.car/);
    // one id, one attachment: a second under the same name is malformed, whatever it carries
    const twice = variant(() => undefined);
    ((twice.msg as PlainMessage).attachments as unknown[]).push(structuredClone(((twice.msg as PlainMessage).attachments as unknown[])[0]));
    await expect(verifyShare(twice.msg as PlainMessage)).rejects.toThrow(/appears twice/);
    // a package that decrypts fine but is some other object's: rooted elsewhere, discarded whole
    const key = (await verifyShare(record.msg as PlainMessage)).package?.key as Uint8Array;
    const other = await closureOf({ "index.json": files["index.json"], "files/other.txt": enc("other") });
    const stray = await encryptStream(key, encodeCar([other.root], other.blocks));
    const strayHash = await blobHash(stray);
    mediator.blobs?.set(strayHash, { id: "stray", size: stray.length, bytes: stray, token: null });
    const elsewhere = variant((pkg) => {
      pkg.id = strayHash;
      pkg.data = { links: [`${MEDIATOR_HTTP}b/stray`], hash: strayHash };
      pkg.byte_count = stray.length;
    });
    ((elsewhere.msg as PlainMessage).body as { package: { attachment_id: string } }).package.attachment_id = strayHash;
    await expect(bob.agent.fetchPackage(elsewhere)).rejects.toThrow(/rooted at \[.*\], not the object shared/);
    // and the genuine one still opens
    expect((await bob.agent.fetchPackage(record)).complete).toBe(true);
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("cannot take the package road past a mediator that keeps no blobs, or past its cap", async () => {
    const mediator = await newMediator();
    const { alice, bob } = await squeezedOver(mediator, [1, 2]);
    await expect(alice.agent.shareObject(bob.agent.did as string, object)).rejects.toThrow(/e\.p\.blob\.refused: this mediator does not store blobs/);
    alice.agent.destroy();

    const storing = await newMediator({ blobs: true });
    const big = readObject({ ...files, "files/big.bin": new Uint8Array(BLOB_MAX + 1) });
    const roomy = await newParty("Alice", 3, storing, { maxShareBytes: closureSize((await closureOf(big.tree)).minimal), packageTimeoutMs: 200 });
    const bobToo = await newParty("Bob", 4, storing);
    await Promise.all([roomy.agent.start(), bobToo.agent.start()]);
    await withTimeout(Promise.all([roomy.live, bobToo.live]), 8000, "both live");
    await expect(roomy.agent.shareObject(bobToo.agent.did as string, big)).rejects.toThrow(/e\.p\.blob\.too-large/);
    roomy.agent.destroy();
    bob.agent.destroy();
    bobToo.agent.destroy();
  });

  it("a package that is gone leaves a partial object; one that lies is not opened", async () => {
    const mediator = await newMediator({ blobs: true });
    const { alice, bob } = await squeezedOver(mediator, [1, 2]);
    const sent = await alice.agent.shareObject(bob.agent.did as string, object);
    const hash = ((sent.msg as PlainMessage).attachments as { id: string }[])[4]?.id as string;
    await eventually(async () => (await recordsOf(bob)).some((r) => r.msg?.type === OBJECT_SHARE), "bob's share");
    const record = await shareRecordOf(bob);

    // the bytes there are not the package: refused before any key is used
    const blob = mediator.blobs?.get(hash) as { bytes: Uint8Array | null };
    const real = blob.bytes as Uint8Array;
    blob.bytes = new Uint8Array(real.length).fill(1);
    await expect(bob.agent.fetchPackage(record)).rejects.toThrow(/do not hash to the package/);
    // retention ran out
    mediator.blobs?.delete(hash);
    await expect(bob.agent.fetchPackage(record)).rejects.toThrow(/not there: .*404/);
    const still = await verifyShare(record.msg as PlainMessage, (cid) => bob.v.vault.blobs.getBlock(cid));
    expect(still.complete).toBe(false);
    expect(still.object.meta.title).toBe("Sea day");
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("does not keep a share without index.json's bytes: not the minimal share", async () => {
    const { alice, bob } = await connected();
    const { root, blocks } = await closureOf(files);
    const skeleton = new Map([...blocks].filter(([cid]) => isDagPbCid(cid)));
    await alice.agent.send(bob.agent.did as string, OBJECT_SHARE, { root }, { attachments: attachmentsOf(skeleton) });
    await eventually(async () => bob.log.some((l) => /does not verify; recorded as it came: .*no index.json/.test(l)), "bob's refusal");
    // none of the share's blocks are kept (the record's own body lives in blobs/ regardless)
    for (const cid of blocks.keys()) {
      expect(await bob.v.vault.blobs.has(cid)).toBe(false);
    }
    alice.agent.destroy();
    bob.agent.destroy();
  });
});
