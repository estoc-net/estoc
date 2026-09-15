import { describe, expect, it } from "vitest";

import { scanVault, type DidId, type MessageId } from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { EXPIRED, Outbox, send, type Content, type OutboxOptions, type Timers } from "../../src/v3/index.js";
import { didcomm, directParty, posting, refuseSubmissions, type DirectParty } from "./helpers.js";

const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;
const MESSAGE = "019b0000-0000-7000-8000-000000000101" as MessageId;
const SECOND = "019b0000-0000-7000-8000-000000000102" as MessageId;
const BOB_ENDPOINT = "https://bob.example/didcomm";
const START = 1_800_000_000_000;

const HELLO: Content = { type: BASIC_MESSAGE, body: { content: "hello" } };

const accepted = (): Response => new Response(null, { status: 202 });
const later = (): Response => new Response("later", { status: 503 });

type Wait = { fire: () => void; ms: number; cleared: boolean };

/** Timers the test fires by hand: every wait set, in order, and whether it was cleared. */
function handTimers(): Timers & { waits: Wait[] } {
  const waits: Wait[] = [];
  return {
    waits,
    set: (fire, ms) => {
      const wait = { fire, ms, cleared: false };
      waits.push(wait);
      return wait;
    },
    clear: (handle) => {
      (handle as Wait).cleared = true;
    },
  };
}

async function pair(): Promise<{ a: DirectParty; b: DirectParty; sendTo: (messageId: MessageId, content?: Content) => Promise<unknown> }> {
  const a = await directParty(1, "https://alice.example/didcomm", DID);
  const b = await directParty(101, BOB_ENDPOINT, DID);
  const sendTo = (messageId: MessageId, content: Content = HELLO) => send(a.runtime, a.keys, { peerDid: b.longFormDid, sender: { didId: DID } }, content, { messageId });
  return { a, b, sendTo };
}

describe("the outbox", () => {
  it("a pass prepares and submits every message owed work, in message order, and keeps nothing once they are submitted", async () => {
    const { a, b, sendTo } = await pair();
    await sendTo(SECOND);
    await sendTo(MESSAGE);
    const wire = posting(accepted);
    const timers = handTimers();
    const outbox = new Outbox(a.runtime, a.keys, { didcomm, fetch: wire.fetch, timers });
    const steps = await outbox.drain();
    expect(steps.map((step) => [step.messageId, step.prepared?.outcome, step.submitted?.outcome, step.error])).toEqual([
      [MESSAGE, "prepared", "submitted", null],
      [SECOND, "prepared", "submitted", null],
    ]);
    expect(wire.posts).toHaveLength(2);
    expect(outbox.waiting()).toEqual([]);
    expect(timers.waits).toEqual([]);
    expect(await outbox.drain()).toEqual([]);
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect([MESSAGE, SECOND].map((messageId) => fold.outbound.outbounds.get(messageId)?.outcome)).toEqual(["submitted", "submitted"]);
    await outbox.close();
    await a.runtime.close();
    await b.runtime.close();
  });

  it("an attempt that may succeed later waits, from the first wait doubling up to the longest; posts stop at the budget, and a new outbox counts from nothing and posts the same package", async () => {
    const { a, b, sendTo } = await pair();
    await sendTo(MESSAGE);
    let clock = START;
    const wire = posting(later);
    const timers = handTimers();
    const options: OutboxOptions = { didcomm, fetch: wire.fetch, timers, now: () => clock, retry: { firstWaitMs: 30_000, longestWaitMs: 100_000, posts: 4 } };
    const outbox = new Outbox(a.runtime, a.keys, options);
    const waits = [30_000, 60_000, 100_000];
    for (const [i, waitMs] of waits.entries()) {
      const [step] = await outbox.drain();
      expect(step?.submitted?.outcome).toBe("retry");
      expect(outbox.waiting()).toEqual([{ messageId: MESSAGE, posts: i + 1, failures: i + 1, nextAt: clock + waitMs, reason: "the endpoint answered 503" }]);
      expect(timers.waits.at(-1)).toMatchObject({ ms: waitMs, cleared: false });
      clock += waitMs - 1;
      expect(await outbox.drain()).toEqual([]);
      clock += 1;
    }
    const [last] = await outbox.drain();
    expect(last?.submitted?.outcome).toBe("retry");
    expect(outbox.waiting()).toMatchObject([{ posts: 4, failures: 4 }]);
    expect(timers.waits.every((wait) => wait.cleared)).toBe(true);
    clock += 1_000_000;
    expect(await outbox.drain()).toEqual([]);
    expect(wire.posts).toHaveLength(4);
    expect(new Set(wire.posts.map((post) => post.body)).size).toBe(1);

    const again = posting(accepted);
    const next = new Outbox(a.runtime, a.keys, { ...options, fetch: again.fetch });
    const [step] = await next.drain();
    expect(step?.submitted?.outcome).toBe("submitted");
    expect(again.posts.map((post) => post.body)).toEqual([wire.posts[0]!.body]);
    await outbox.close();
    await next.close();
    await a.runtime.close();
    await b.runtime.close();
  });

  it("a wait that ends runs a pass by itself", async () => {
    const { a, b, sendTo } = await pair();
    await sendTo(MESSAGE);
    let clock = START;
    const answers = [later, accepted];
    const wire = posting(() => answers.shift()!());
    const timers = handTimers();
    const outbox = new Outbox(a.runtime, a.keys, { didcomm, fetch: wire.fetch, timers, now: () => clock });
    await outbox.drain();
    const wait = timers.waits.at(-1)!;
    expect(wait.ms).toBe(30_000);
    clock += wait.ms;
    wait.fire();
    await outbox.drain();
    expect(wire.posts).toHaveLength(2);
    expect((await scanVault(a.runtime.vault, a.keys)).outbound.outbounds.get(MESSAGE)?.outcome).toBe("submitted");
    expect(outbox.waiting()).toEqual([]);
    await outbox.close();
    await a.runtime.close();
    await b.runtime.close();
  });

  it("no wait runs past the message's expiry, where the expired failure is recorded instead of another post", async () => {
    const { a, b, sendTo } = await pair();
    await sendTo(MESSAGE, { ...HELLO, expiresTime: START / 1000 + 45 });
    let clock = START;
    const wire = posting(later);
    const timers = handTimers();
    const outbox = new Outbox(a.runtime, a.keys, { didcomm, fetch: wire.fetch, timers, now: () => clock });
    await outbox.drain();
    expect(outbox.waiting()).toMatchObject([{ nextAt: START + 30_000 }]);
    clock = START + 30_000;
    await outbox.drain();
    expect(outbox.waiting()).toMatchObject([{ failures: 2, nextAt: START + 45_000 }]);
    expect(timers.waits.at(-1)?.ms).toBe(15_000);
    clock = START + 45_000;
    const [step] = await outbox.drain();
    expect(step?.submitted).toMatchObject({ outcome: "failed", code: EXPIRED });
    expect(outbox.waiting()).toEqual([]);
    expect(wire.posts).toHaveLength(2);
    await outbox.close();
    await a.runtime.close();
    await b.runtime.close();
  });

  it("a message out of posts is still failed at its expiry: the pass woken there records the failure without a post, and a clock set back after it posts nothing", async () => {
    const { a, b, sendTo } = await pair();
    await sendTo(MESSAGE, { ...HELLO, expiresTime: START / 1000 + 45 });
    let clock = START;
    const wire = posting(later);
    const timers = handTimers();
    const options: OutboxOptions = { didcomm, fetch: wire.fetch, timers, now: () => clock, retry: { posts: 1 } };
    const outbox = new Outbox(a.runtime, a.keys, options);
    await outbox.drain();
    expect(outbox.waiting()).toEqual([{ messageId: MESSAGE, posts: 1, failures: 1, nextAt: null, reason: "the endpoint answered 503" }]);
    expect(timers.waits.at(-1)).toMatchObject({ ms: 45_000, cleared: false });
    clock = START + 44_999;
    expect(await outbox.drain()).toEqual([]);
    const wait = timers.waits.at(-1)!;
    expect(wait).toMatchObject({ ms: 1, cleared: false });
    clock = START + 45_000;
    wait.fire();
    await outbox.drain();
    const fold = await scanVault(a.runtime.vault, a.keys);
    const outbound = fold.outbound.outbounds.get(MESSAGE)!;
    expect(outbound).toMatchObject({ outcome: "failed", failed: EXPIRED });
    expect(fold.held.has([...outbound.packages.values()][0]!.data.envelopeCid)).toBe(false);
    expect(outbox.waiting()).toEqual([]);
    expect(timers.waits.at(-1)).toBe(wait);
    expect(wire.posts).toHaveLength(1);

    clock = START;
    const next = new Outbox(a.runtime, a.keys, { ...options, timers: handTimers() });
    expect(await next.drain()).toEqual([]);
    expect(wire.posts).toHaveLength(1);
    await outbox.close();
    await next.close();
    await a.runtime.close();
    await b.runtime.close();
  });

  it("an acceptance of the last post the budget allows, not recorded at first, is recorded by the passes its waits wake, with no other post and no expired failure in its place", async () => {
    for (const expiresTime of [undefined, START / 1000 + 45]) {
      const { a, b, sendTo } = await pair();
      await sendTo(MESSAGE, { ...HELLO, expiresTime });
      refuseSubmissions(a.runtime, 2);
      let clock = START;
      const wire = posting(accepted);
      const timers = handTimers();
      const outbox = new Outbox(a.runtime, a.keys, { didcomm, fetch: wire.fetch, timers, now: () => clock, retry: { posts: 1 } });
      const [first] = await outbox.drain();
      expect(first?.error).toBe("the disk is full for now");
      expect(outbox.waiting()).toEqual([{ messageId: MESSAGE, posts: 1, failures: 1, nextAt: START + 30_000, reason: "the disk is full for now" }]);
      expect(timers.waits.at(-1)).toMatchObject({ ms: 30_000, cleared: false });

      clock = START + 45_000;
      timers.waits.at(-1)!.fire();
      expect(await outbox.drain()).toEqual([]);
      expect(outbox.waiting()).toMatchObject([{ posts: 1, failures: 2, nextAt: START + 105_000 }]);
      expect(timers.waits.at(-1)).toMatchObject({ ms: 60_000, cleared: false });

      clock = START + 105_000;
      timers.waits.at(-1)!.fire();
      expect(await outbox.drain()).toEqual([]);
      expect((await scanVault(a.runtime.vault, a.keys)).outbound.outbounds.get(MESSAGE)).toMatchObject({ outcome: "submitted", submitted: true, failed: null });
      expect(outbox.waiting()).toEqual([]);
      expect(wire.posts).toHaveLength(1);
      await outbox.close();
      await a.runtime.close();
      await b.runtime.close();
    }
  });

  it("a wait that comes while a later message is worked on runs the next pass at once", async () => {
    const { a, b, sendTo } = await pair();
    await sendTo(MESSAGE);
    await sendTo(SECOND);
    let clock = START;
    const wire = posting(() => {
      if (wire.posts.length === 1) return later();
      clock = START + 40_000;
      return accepted();
    });
    const timers = handTimers();
    const outbox = new Outbox(a.runtime, a.keys, { didcomm, fetch: wire.fetch, timers, now: () => clock });
    const steps = await outbox.drain();
    expect(steps.map((step) => [step.messageId, step.submitted?.outcome])).toEqual([
      [MESSAGE, "retry"],
      [SECOND, "submitted"],
    ]);
    expect(outbox.waiting()).toMatchObject([{ messageId: MESSAGE, nextAt: START + 30_000 }]);
    expect(timers.waits.at(-1)).toMatchObject({ ms: 0, cleared: false });
    timers.waits.at(-1)!.fire();
    expect(await outbox.drain()).toEqual([]);
    expect((await scanVault(a.runtime.vault, a.keys)).outbound.outbounds.get(MESSAGE)?.outcome).toBe("submitted");
    expect(wire.posts).toHaveLength(3);
    await outbox.close();
    await a.runtime.close();
    await b.runtime.close();
  });

  it("an expiry that comes while a later message is worked on runs the next pass at once", async () => {
    const { a, b, sendTo } = await pair();
    await sendTo(MESSAGE, { ...HELLO, expiresTime: START / 1000 + 45 });
    await sendTo(SECOND);
    let clock = START;
    const wire = posting(() => {
      if (wire.posts.length === 1) return later();
      clock = START + 50_000;
      return accepted();
    });
    const timers = handTimers();
    const outbox = new Outbox(a.runtime, a.keys, { didcomm, fetch: wire.fetch, timers, now: () => clock, retry: { posts: 1 } });
    const steps = await outbox.drain();
    expect(steps.map((step) => [step.messageId, step.submitted?.outcome])).toEqual([
      [MESSAGE, "retry"],
      [SECOND, "submitted"],
    ]);
    expect(outbox.waiting()).toMatchObject([{ messageId: MESSAGE, nextAt: null }]);
    expect(timers.waits.at(-1)).toMatchObject({ ms: 0, cleared: false });
    timers.waits.at(-1)!.fire();
    expect(await outbox.drain()).toEqual([]);
    expect((await scanVault(a.runtime.vault, a.keys)).outbound.outbounds.get(MESSAGE)).toMatchObject({ outcome: "failed", failed: EXPIRED });
    expect(wire.posts).toHaveLength(2);
    await outbox.close();
    await a.runtime.close();
    await b.runtime.close();
  });

  it("an expiry further off than a timer can wait is reached by the longest waits a timer takes, the passes before it posting nothing", async () => {
    const { a, b, sendTo } = await pair();
    const expiresAt = START + 30 * 24 * 60 * 60 * 1000;
    await sendTo(MESSAGE, { ...HELLO, expiresTime: expiresAt / 1000 });
    let clock = START;
    const wire = posting(later);
    const timers = handTimers();
    const outbox = new Outbox(a.runtime, a.keys, { didcomm, fetch: wire.fetch, timers, now: () => clock, retry: { posts: 1 } });
    await outbox.drain();
    expect(timers.waits.at(-1)).toMatchObject({ ms: 2 ** 31 - 1, cleared: false });

    clock += 2 ** 31 - 1;
    timers.waits.at(-1)!.fire();
    expect(await outbox.drain()).toEqual([]);
    expect(timers.waits.at(-1)).toMatchObject({ ms: expiresAt - clock, cleared: false });
    expect((await scanVault(a.runtime.vault, a.keys)).outbound.outbounds.get(MESSAGE)?.failed).toBeNull();

    clock = expiresAt;
    const wake = timers.waits.at(-1)!;
    wake.fire();
    expect(await outbox.drain()).toEqual([]);
    expect((await scanVault(a.runtime.vault, a.keys)).outbound.outbounds.get(MESSAGE)).toMatchObject({ outcome: "failed", failed: EXPIRED });
    expect(timers.waits.at(-1)).toBe(wake);
    expect(timers.waits.map((wait) => wait.ms)).toEqual([2 ** 31 - 1, wake.ms, wake.ms]);
    expect(wire.posts).toHaveLength(1);
    await outbox.close();
    await a.runtime.close();
    await b.runtime.close();
  });

  it("passes asked for while one runs are run once, after it", async () => {
    const { a, b, sendTo } = await pair();
    await sendTo(MESSAGE);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const paused = new Promise<void>((resolve) => (release = resolve));
    const wire = posting(async () => {
      entered();
      await paused;
      return accepted();
    });
    const outbox = new Outbox(a.runtime, a.keys, { didcomm, fetch: wire.fetch, timers: handTimers() });
    const first = outbox.drain();
    await started;
    const second = outbox.drain();
    const third = outbox.drain();
    expect(third).toBe(second);
    release();
    expect((await first).map((step) => step.submitted?.outcome)).toEqual(["submitted"]);
    expect(await second).toEqual([]);
    expect(wire.posts).toHaveLength(1);
    await outbox.close();
    await a.runtime.close();
    await b.runtime.close();
  });

  it("a closed outbox keeps no wait and runs no pass", async () => {
    const { a, b, sendTo } = await pair();
    await sendTo(MESSAGE);
    const wire = posting(later);
    const timers = handTimers();
    const outbox = new Outbox(a.runtime, a.keys, { didcomm, fetch: wire.fetch, timers });
    await outbox.drain();
    expect(timers.waits.at(-1)?.cleared).toBe(false);
    await outbox.close();
    expect(timers.waits.at(-1)?.cleared).toBe(true);
    expect(await outbox.drain()).toEqual([]);
    expect(wire.posts).toHaveLength(1);
    await a.runtime.close();
    await b.runtime.close();
  });
});
