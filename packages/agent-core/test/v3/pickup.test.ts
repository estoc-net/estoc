import { describe, expect, it } from "vitest";
import { Message } from "@estoc/didcomm-node";

import { resolveDIDCommDoc } from "@estoc/did-peer";

import { BASIC_MESSAGE, PLAIN_TYP, STATUS, plainMessage, secretsResolverFor, type IMessage } from "../../src/index.js";
import { Pickup, createDid, ensureRoute, establish, reconcile, type Delivered, type Opened } from "../../src/v3/index.js";
import { newMediator, party, reloaded, until } from "./helpers.js";

const resolver = { resolve: resolveDIDCommDoc };

/** An envelope sealed anonymously to `to`, as a stranger would send a first message. */
async function sealedTo(to: string, content: string): Promise<string> {
  const plain = { id: crypto.randomUUID(), typ: PLAIN_TYP, type: BASIC_MESSAGE, to: [to], created_time: 1, body: { content } } as IMessage;
  const [packed] = await new Message(plain).pack_encrypted(to, null, null, resolver, secretsResolverFor([]), { forward: false });
  return packed;
}

describe("pickup over the v3 ring", () => {
  it("drains what the mediator holds for the account, hands each attachment over unopened and acknowledges what was taken", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    await establish(p.link, p.runtime, p.keys, p.mediationId);
    const routeId = await ensureRoute(p.runtime, p.keys, p.mediationId);
    const { minted } = await createDid(p.runtime, p.keys, routeId);
    await reloaded(p);
    await reconcile(p.link, p.runtime, p.keys, p.mediationId);
    const account = p.created.data.me.did;
    const hello = await sealedTo(minted.longFormDid, "hello");
    const skipped = await sealedTo(minted.longFormDid, "skip me");
    mediator.queues.set(account, [
      { id: "q1", packed: hello },
      { id: "q2", packed: skipped },
    ]);
    const taken: Delivered[] = [];
    const pickup = new Pickup(p.link, (delivered) => {
      taken.push(delivered);
      return delivered.attachmentId === "q1" ? "acked" : "skip";
    });
    const drained = await pickup.drain();
    expect(drained).toEqual({ acked: 1, ended: "left" });
    // two rounds: the first takes both and acknowledges one; the second fetches the one left and acknowledges nothing
    expect(taken.map((delivered) => ["packed" in delivered ? JSON.parse(delivered.packed) : delivered.unreadable, delivered.attachmentId])).toEqual([
      [JSON.parse(hello), "q1"],
      [JSON.parse(skipped), "q2"],
      [JSON.parse(skipped), "q2"],
    ]);
    expect(mediator.queues.get(account)?.map((item) => item.id)).toEqual(["q2"]);
    await p.runtime.close();
  });

  it("a frame down the socket is the mediator's with its sender protected, and dropped when another sealed it", async () => {
    const mediator = await newMediator();
    mediator.protectSender = true;
    const p = await party(mediator);
    await establish(p.link, p.runtime, p.keys, p.mediationId);
    const frames: Opened[] = [];
    let arrived = (): void => undefined;
    const next = (): Promise<void> => new Promise((resolve) => (arrived = resolve));
    const status = next();
    p.link.openSocket((opened) => {
      frames.push(opened);
      arrived();
    });
    await status;
    expect(frames.map((opened) => [opened.msg.type, opened.sender, opened.metadata.anonymous_sender])).toEqual([[STATUS, mediator.did, true]]);

    const impostor = await newMediator(201, "http://impostor/");
    const stray = plainMessage(STATUS, impostor.did, p.link.me, { live_delivery: true });
    const [packed] = await new Message(stray).pack_encrypted(p.link.me, impostor.did, null, resolver, secretsResolverFor(impostor.secrets), { forward: false });
    mediator.socketOf(p.link.me)?.deliver(packed);
    await until("the stray frame's drop", () => p.log.length > 0);
    expect(frames).toHaveLength(1);
    expect(p.log).toEqual([`a socket frame was dropped: the reply was not sealed by the mediator to this account: sealed by ${impostor.did}`]);
    p.link.closeSocket();
    await p.runtime.close();
  });
});
