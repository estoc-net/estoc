import { describe, expect, it } from "vitest";
import { Message } from "didcomm-node";

import { resolveDIDCommDoc } from "@estoc/did-peer";

import { BASIC_MESSAGE, PLAIN_TYP, secretsResolverFor, type IMessage } from "../../src/index.js";
import { Pickup, createDid, ensureRoute, establish, reconcile, type Opened } from "../../src/v3/index.js";
import { newMediator, party, reloaded } from "./helpers.js";

const resolver = { resolve: resolveDIDCommDoc };

/** An envelope sealed anonymously to `to`, as a stranger would send a first message. */
async function sealedTo(to: string, content: string): Promise<string> {
  const plain = { id: crypto.randomUUID(), typ: PLAIN_TYP, type: BASIC_MESSAGE, to: [to], created_time: 1, body: { content } } as IMessage;
  const [packed] = await new Message(plain).pack_encrypted(to, null, null, resolver, secretsResolverFor([]), { forward: false });
  return packed;
}

describe("pickup over the v3 ring", () => {
  it("drains what the mediator holds for the account, opens it with a communication DID's key and acknowledges what was taken", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    await establish(p.link, p.runtime, p.keys, p.mediationId);
    const routeId = await ensureRoute(p.runtime, p.keys, p.mediationId);
    const { minted } = await createDid(p.runtime, p.keys, routeId);
    await reloaded(p);
    await reconcile(p.link, p.runtime, p.keys, p.mediationId);
    const account = p.created.data.me.did;
    mediator.queues.set(account, [
      { id: "q1", packed: await sealedTo(minted.longFormDid, "hello") },
      { id: "q2", packed: await sealedTo(minted.longFormDid, "skip me") },
    ]);
    const taken: Opened[] = [];
    const pickup = new Pickup(p.link, (opened) => {
      taken.push(opened);
      return (opened.msg.body as { content: string }).content === "hello" ? "acked" : "skip";
    });
    const drained = await pickup.drain();
    expect(drained).toEqual({ acked: 1, ended: "left" });
    // two rounds: the first takes both and acknowledges one; the second fetches the one left and acknowledges nothing
    expect(taken.map((opened) => [opened.recipient, opened.sender, (opened.msg.body as { content: string }).content])).toEqual([
      [minted.longFormDid, null, "hello"],
      [minted.longFormDid, null, "skip me"],
      [minted.longFormDid, null, "skip me"],
    ]);
    expect(mediator.queues.get(account)?.map((item) => item.id)).toEqual(["q2"]);
    expect((await p.trace.read({ stream: "envelope" })).filter((entry) => entry.type === "envelope.open").length).toBeGreaterThanOrEqual(2);
    await p.runtime.close();
  });
});
