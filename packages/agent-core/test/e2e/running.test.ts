import { afterEach, describe, expect, it } from "vitest";

import type { DidId, MessageId } from "@estoc/vault";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { RECIPIENT_QUERY } from "../../src/protocol/mediation.js";
import { FORWARD } from "../../src/protocol/spec.js";
import { newMediator } from "../helpers.js";
import { LONG, channelOf, dieAt, restart, run, stopAll } from "./running.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const FROM_ALICE = "019b0000-0000-7000-8000-000000000101" as MessageId;
const FROM_BOB = "019b0000-0000-7000-8000-000000000102" as MessageId;

afterEach(stopAll);

const hello = (content: string) => ({ type: BASIC_MESSAGE, body: { content } });

function gate(): { opened: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe("the death of a running party", () => {
  it("is met by its own forward alone: what the peer sends while another call of the armed party is held is queued as ever", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, { liveDelivery: false });
    const bob = await run(mediator, 2, BOB, { liveDelivery: false });
    const account = bob.party.created.data.me.did;
    const querying = gate();
    const answered = gate();
    mediator.intercept = async (message, from) => {
      if (message.type !== RECIPIENT_QUERY || from !== account) return undefined;
      querying.open();
      await answered.opened;
      return undefined;
    };
    dieAt(bob, "unsent");
    const connecting = bob.agent.connect();
    await querying.opened;
    const sent = await alice.agent.send({ channel: channelOf(alice.party.did, bob.party.did), recipientDid: bob.party.longFormDid }, hello("only alice is sending"), { messageId: FROM_ALICE });
    expect(sent.dispatched).toMatchObject({ outcome: "submitted" });
    expect(mediator.queues.get(account)).toHaveLength(1);
    answered.open();
    await connecting;
    expect([bob.dead, bob.inbounds.length]).toEqual([false, 1]);

    await bob.agent.send({ channel: channelOf(bob.party.did, alice.party.did) }, hello("and now bob"), { messageId: FROM_BOB });
    expect(bob.dead).toBe(true);
    expect(mediator.queues.get(alice.party.created.data.me.did) ?? []).toEqual([]);
  });

  it("frees its file only once the work its runtime had admitted is done: a restart waits for that", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, { liveDelivery: false });
    const bob = await run(mediator, 2, BOB, { liveDelivery: false });
    const { runtime } = bob;
    const admitted = gate();
    const finishing = gate();
    let held: Promise<void> | null = null;
    mediator.intercept = async (message) => {
      if (message.type !== FORWARD || held !== null) return undefined;
      held = runtime.locked(async () => {
        admitted.open();
        await finishing.opened;
      });
      await admitted.opened;
      return undefined;
    };
    dieAt(bob, "unrecorded");
    await bob.agent.send({ channel: channelOf(bob.party.did, alice.party.did), recipientDid: alice.party.longFormDid }, hello("hello"), { messageId: FROM_BOB });
    expect(bob.dead).toBe(true);

    let restarted = false;
    const restarting = restart(bob).then(() => (restarted = true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(restarted).toBe(false);
    finishing.open();
    await restarting;
    await held;
    expect(bob.dead).toBe(false);
    expect((await bob.agent.outbounds()).map(({ outbound }) => [outbound.messageId, outbound.outcome.status])).toEqual([[FROM_BOB, "prepared"]]);
  });
});
