import { describe, expect, it } from "vitest";

import { scanVault, type DidId, type MessageId } from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { Dispatcher, LiveAction, send, type Content, type DispatcherOptions } from "../../src/v3/index.js";
import { didcomm, directParty, handTimers, posting, until, type DirectParty } from "./helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const MESSAGE = "019b0000-0000-7000-8000-000000000101" as MessageId;
const SECOND = "019b0000-0000-7000-8000-000000000102" as MessageId;
const HELLO: Content = { type: BASIC_MESSAGE, body: { content: "hello" } };
const T0 = 1_700_000_000_000;

const accepted = (): Response => new Response(null, { status: 202 });

interface Scene {
  alice: DirectParty;
  bob: DirectParty;
  timers: ReturnType<typeof handTimers>;
  wire: ReturnType<typeof posting>;
  log: string[];
  dispatcher: Dispatcher;
  close(): Promise<void>;
}

async function scene(over: Partial<DispatcherOptions> = {}, answer: () => Response | Promise<Response> = accepted): Promise<Scene> {
  const alice = await directParty(1, "https://alice.example/didcomm", ALICE);
  const bob = await directParty(2, "https://bob.example/didcomm", BOB);
  const timers = handTimers();
  const wire = posting(answer);
  const log: string[] = [];
  const dispatcher = new Dispatcher(alice.runtime, alice.keys, { didcomm, fetch: wire.fetch, timers, now: () => T0, log: (line) => log.push(line), ...over });
  return {
    alice,
    bob,
    timers,
    wire,
    log,
    dispatcher,
    close: async () => {
      dispatcher.close();
      await alice.runtime.close();
      await bob.runtime.close();
    },
  };
}

/** A message to Bob's short form: its long form is not in evidence, so the package waits for it. */
const toShortForm = (s: Scene, messageId: MessageId) => send(s.alice.runtime, s.alice.keys, { channel: { localDid: s.alice.did, peerDid: s.bob.did } }, HELLO, { messageId });
/** A message to Bob's long form: it brings the long form into evidence for every message to Bob. */
const toLongForm = (s: Scene, messageId: MessageId) => send(s.alice.runtime, s.alice.keys, { channel: { localDid: s.alice.did, peerDid: s.bob.longFormDid } }, HELLO, { messageId });

describe("Dispatcher", () => {
  it("waits out a prerequisite for as long as the action lives, doubling the wait, and makes the call once it is there", async () => {
    const s = await scene();
    const sent = await toShortForm(s, MESSAGE);
    const first = await s.dispatcher.run(sent.action);
    expect(first).toMatchObject({ outcome: "pending", messageId: MESSAGE });
    expect(s.dispatcher.waiting()).toEqual([{ messageId: MESSAGE, kind: "initial", attempts: 1, nextAt: T0 + 30_000, reason: expect.stringMatching(/no long form of/) }]);
    expect(s.timers.waits.map((wait) => wait.ms)).toEqual([30_000]);

    s.timers.waits[0]!.fire();
    await until("the second attempt waited", () => s.timers.waits.length === 2);
    expect(s.dispatcher.waiting()).toMatchObject([{ attempts: 2, nextAt: T0 + 60_000 }]);
    expect(s.timers.waits[1]!.ms).toBe(60_000);
    expect(s.wire.posts).toEqual([]);

    await toLongForm(s, SECOND);
    s.timers.waits[1]!.fire();
    await until("the message was carried", () => s.dispatcher.waiting().length === 0);
    expect(s.wire.posts).toHaveLength(1);
    expect(sent.action.spent).toBe(true);
    const fold = await scanVault(s.alice.runtime.vault, s.alice.keys);
    expect(fold.outbound.outbounds.get(MESSAGE)!.submitted).toBe(true);
    expect(fold.outbound.outbounds.get(SECOND)!.outcome).toEqual({ status: "queued" });
    expect((await s.dispatcher.pending()).map((entry) => [entry.outbound.messageId, entry.waiting])).toEqual([[SECOND, null]]);
    expect(s.log).toEqual([]);
    await s.close();
  });

  it("gives the action up once its attempts are spent, and says so", async () => {
    const s = await scene({ retry: { attempts: 2 } });
    const sent = await toShortForm(s, MESSAGE);
    await s.dispatcher.run(sent.action);
    s.timers.waits[0]!.fire();
    await until("the action was given up on", () => s.dispatcher.waiting().length === 0);
    expect(s.timers.waits).toHaveLength(1);
    expect(s.log).toEqual([expect.stringMatching(/given up on after 2 attempts: no long form of/)]);
    expect(sent.action.spent).toBe(false);
    expect((await s.dispatcher.pending()).map((entry) => [entry.outbound.messageId, entry.waiting])).toEqual([[MESSAGE, null]]);
    await s.close();
  });

  it("a call that was refused is not made again on its own: a retry mints a fresh manual action", async () => {
    const answers: (() => Response)[] = [() => new Response("later", { status: 503 }), accepted];
    const s = await scene({}, () => answers.shift()!());
    const sent = await toLongForm(s, MESSAGE);
    expect(await s.dispatcher.run(sent.action)).toMatchObject({ outcome: "failed", reason: "the endpoint answered 503" });
    expect(s.dispatcher.waiting()).toEqual([]);
    expect(s.timers.waits).toEqual([]);
    expect(await s.dispatcher.retry(MESSAGE)).toMatchObject({ outcome: "submitted", messageId: MESSAGE });
    expect(s.wire.posts).toHaveLength(2);
    expect(s.wire.posts[0]!.body).toBe(s.wire.posts[1]!.body);
    await s.close();
  });

  it("lists what is pending with the wait on it; cancelling drops the wait and terminates the message", async () => {
    const s = await scene();
    const sent = await toShortForm(s, MESSAGE);
    await toShortForm(s, SECOND);
    await s.dispatcher.run(sent.action);
    expect((await s.dispatcher.pending()).map((entry) => [entry.outbound.messageId, entry.waiting?.attempts ?? null])).toEqual([
      [MESSAGE, 1],
      [SECOND, null],
    ]);
    expect(await s.dispatcher.cancel(MESSAGE)).toMatchObject({ outcome: "cancelled", messageId: MESSAGE });
    expect(s.timers.waits[0]!.cleared).toBe(true);
    expect(s.dispatcher.waiting()).toEqual([]);
    expect((await s.dispatcher.pending()).map((entry) => entry.outbound.messageId)).toEqual([SECOND]);
    expect(sent.action.spent).toBe(false);
    await s.close();
  });

  it("a newer action for the message replaces the one waiting; closing drops every wait and takes no more", async () => {
    const s = await scene();
    const sent = await toShortForm(s, MESSAGE);
    await s.dispatcher.run(sent.action);
    const manual = new LiveAction(MESSAGE, "manual");
    expect(await s.dispatcher.run(manual)).toMatchObject({ outcome: "pending" });
    expect(s.timers.waits.map((wait) => wait.cleared)).toEqual([true, false]);
    expect(s.dispatcher.waiting()).toMatchObject([{ messageId: MESSAGE, kind: "manual", attempts: 1 }]);

    s.dispatcher.close();
    expect(s.timers.waits.map((wait) => wait.cleared)).toEqual([true, true]);
    expect(s.dispatcher.waiting()).toEqual([]);
    expect(await s.dispatcher.run(new LiveAction(MESSAGE, "manual"))).toEqual({ outcome: "none", messageId: MESSAGE, because: "the dispatcher is closed" });
    await s.close();
  });
});
