import { describe, expect, it } from "vitest";
import { FromPrior, Message } from "didcomm-node";
import { createSeedKeystore, deriveIdentity, importSeed } from "@estoc/keystore";
import { hashTree } from "@estoc/signed-dir";

import {
  Agent,
  MemoryBackend,
  Vault,
  decodeCard,
  queryPublicFolder,
  readPublicFolder,
  type TreeFiles,
} from "../src/index.js";
import { FakeMediator, MEDIATOR_HTTP } from "./fake-mediator.js";

const didcomm = { Message, FromPrior };
const seedOf = (fill: number) => new Uint8Array(32).map((_, i) => (i * 7 + fill) & 0xff);
const utf8 = (text: string) => new TextEncoder().encode(text);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function newMediator(): Promise<FakeMediator> {
  return new FakeMediator(await deriveIdentity(await importSeed(seedOf(200)), "anchor"));
}

async function newOwner(mediator: FakeMediator, fill = 1) {
  const backend = new MemoryBackend();
  const { doc, seedKey } = await createSeedKeystore("", { seed: seedOf(fill) });
  const vault = await Vault.create(backend, {
    label: "owner",
    keystore: doc,
    seedKey,
    mediatorDid: mediator.did,
  });
  const agent = new Agent({
    vault,
    seedKey,
    didcomm,
    fetch: mediator.fetch,
    WebSocket: mediator.WebSocket,
  });
  await agent.start();
  return { vault, seedKey, agent };
}

function folder(): TreeFiles {
  return {
    "profile.json": utf8('{"name":"owner"}'),
    "posts/hello.md": utf8("# hello"),
  };
}

describe("public folder", () => {
  it("publishes a folder and a stranger reads it over plain HTTP", async () => {
    const mediator = await newMediator();
    const { vault, agent } = await newOwner(mediator);
    const did = agent.did as string;

    const receipt = await agent.publishPublicFolder(folder());
    expect(receipt.did).toBe(did);

    // one file, relay named explicitly
    const file = await readPublicFolder({
      did,
      path: "posts/hello.md",
      relayUrl: MEDIATOR_HTTP,
      fetch: mediator.fetch,
    });
    expect(file.stale).toBe(false);
    expect(file.resolved?.kind).toBe("file");
    expect(text(file.resolved?.bytes as Uint8Array)).toBe("# hello");

    // the root listing, relay discovered from the owner's DID document alone
    const listing = await readPublicFolder({ did, fetch: mediator.fetch });
    expect(listing.entries?.map((entry) => entry.name)).toEqual(["posts", "profile.json"]);

    // the vault kept the card and the receipt — and nothing of the folder
    const state = await vault.publicFolder.get();
    expect(state?.receipt.card_id).toBe(receipt.card_id);
    expect(decodeCard(state?.card as string).did).toBe(did);

    agent.destroy();
  });

  it("reads over DIDComm from a one-time DID, inline and by links", async () => {
    const mediator = await newMediator();
    const { agent } = await newOwner(mediator);
    const did = agent.did as string;
    await agent.publishPublicFolder(folder());

    const inline = await queryPublicFolder({
      did,
      path: "posts/hello.md",
      didcomm,
      fetch: mediator.fetch,
    });
    expect(text(inline.resolved?.bytes as Uint8Array)).toBe("# hello");

    // every attachment degraded to a link: bytes travel over HTTP, trust stays in the hashes
    mediator.answerInlineLimit = 0;
    const linked = await queryPublicFolder({
      did,
      path: "posts/hello.md",
      didcomm,
      fetch: mediator.fetch,
    });
    expect(text(linked.resolved?.bytes as Uint8Array)).toBe("# hello");

    const head = await queryPublicFolder({ did, cardOnly: true, didcomm, fetch: mediator.fetch });
    expect(head.resolved).toBeNull();
    expect(head.card.root).not.toBeNull();

    agent.destroy();
  });

  it("refuses stale cards by default and tampered objects always", async () => {
    const mediator = await newMediator();
    const { agent } = await newOwner(mediator);
    const did = agent.did as string;

    await agent.publishPublicFolder(folder(), { expiresInDays: -1 });
    await expect(
      readPublicFolder({ did, relayUrl: MEDIATOR_HTTP, fetch: mediator.fetch })
    ).rejects.toThrow(/expired/);
    const stale = await readPublicFolder({
      did,
      relayUrl: MEDIATOR_HTTP,
      fetch: mediator.fetch,
      allowStale: true,
    });
    expect(stale.stale).toBe(true);
    expect(stale.entries?.length).toBe(2);

    // a relay swapping in other bytes is caught by the CID on the hop
    await agent.publishPublicFolder(folder());
    const tree = await hashTree(folder());
    const helloCid = [...tree.files].find(([, path]) => path === "posts/hello.md")?.[0] as string;
    mediator.objects.set(helloCid, utf8("something else"));
    await expect(
      readPublicFolder({
        did,
        path: "posts/hello.md",
        relayUrl: MEDIATOR_HTTP,
        fetch: mediator.fetch,
      })
    ).rejects.toThrow(/hash/);

    // a card served under somebody else's DID does not verify as theirs
    mediator.cards.set("did:example:squatter", mediator.cards.get(did) as string);
    await expect(
      readPublicFolder({
        did: "did:example:squatter",
        relayUrl: MEDIATOR_HTTP,
        fetch: mediator.fetch,
      })
    ).rejects.toThrow();

    agent.destroy();
  });

  it("takes the folder down with a signed null-root card", async () => {
    const mediator = await newMediator();
    const { vault, agent } = await newOwner(mediator);
    const did = agent.did as string;
    await agent.publishPublicFolder(folder());

    const receipt = await agent.takedownPublicFolder();
    expect(receipt.did).toBe(did);

    // every read now yields the signed "nothing is published", never an error
    const http = await readPublicFolder({
      did,
      path: "posts/hello.md",
      relayUrl: MEDIATOR_HTTP,
      fetch: mediator.fetch,
    });
    expect(http.card.root).toBeNull();
    expect(http.resolved).toBeNull();
    const over = await queryPublicFolder({ did, didcomm, fetch: mediator.fetch });
    expect(over.card.root).toBeNull();

    expect(decodeCard((await vault.publicFolder.get())?.card as string).root).toBeNull();

    agent.destroy();
  });

  it("renews a card nearing expiry at start, and leaves a fresh one alone", async () => {
    const mediator = await newMediator();
    const { vault, seedKey, agent } = await newOwner(mediator);
    const did = agent.did as string;

    await agent.publishPublicFolder(folder(), { expiresInDays: 5 });
    const before = mediator.cards.get(did) as string;
    agent.destroy();

    const second = new Agent({
      vault,
      seedKey,
      didcomm,
      fetch: mediator.fetch,
      WebSocket: mediator.WebSocket,
    });
    await second.start();
    const after = mediator.cards.get(did) as string;
    expect(after).not.toBe(before);
    const renewed = decodeCard(after);
    const old = decodeCard(before);
    expect(renewed.root).toBe(old.root);
    expect(renewed.id).not.toBe(old.id);
    expect(Date.parse(renewed.expires)).toBeGreaterThan(Date.parse(old.expires));
    expect((await vault.publicFolder.get())?.card).toBe(after);
    second.destroy();

    // a card with plenty of time left is not touched
    const third = new Agent({
      vault,
      seedKey,
      didcomm,
      fetch: mediator.fetch,
      WebSocket: mediator.WebSocket,
    });
    await third.start();
    expect(mediator.cards.get(did)).toBe(after);
    third.destroy();
  });

  it("renews when the relay's lease nears its end, even under a fresh card", async () => {
    const mediator = await newMediator();
    const { vault, seedKey, agent } = await newOwner(mediator);
    const did = agent.did as string;

    mediator.retainUntil = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await agent.publishPublicFolder(folder());
    const before = mediator.cards.get(did) as string;
    agent.destroy();

    const second = new Agent({
      vault,
      seedKey,
      didcomm,
      fetch: mediator.fetch,
      WebSocket: mediator.WebSocket,
    });
    await second.start();
    expect(mediator.cards.get(did)).not.toBe(before);
    second.destroy();
  });

  it("re-sends only what changed on the next publish", async () => {
    const mediator = await newMediator();
    const { agent } = await newOwner(mediator);
    await agent.publishPublicFolder(folder());

    mediator.receivedObjects.length = 0;
    const changed = { ...folder(), "posts/hello.md": utf8("# hello, again") };
    await agent.publishPublicFolder(changed);

    // the new file, the posts node, the root node — and never profile.json
    const tree = await hashTree(folder());
    const profileCid = [...tree.files].find(([, path]) => path === "profile.json")?.[0] as string;
    expect(mediator.receivedObjects).toHaveLength(3);
    expect(mediator.receivedObjects).not.toContain(profileCid);

    agent.destroy();
  });

  it("cannot publish without mediation", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await createSeedKeystore("", { seed: seedOf(9) });
    const vault = await Vault.create(backend, { label: "loner", keystore: doc, seedKey });
    const agent = new Agent({ vault, seedKey, didcomm });
    await agent.start();
    await expect(agent.publishPublicFolder(folder())).rejects.toThrow(/mediation/);
    agent.destroy();
  });
});
