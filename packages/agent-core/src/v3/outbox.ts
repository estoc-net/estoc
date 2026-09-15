/**
 * The outbox is the runtime's pass over the outbound messages still
 * owed work. What is owed is read from the fold on every pass; all the
 * outbox keeps of a message is when to try it again and how many times
 * it has been posted in this runtime's life. A message is prepared when
 * it needs a package and submitted once one is ready, one message after
 * another in message order. An attempt that may succeed later waits
 * before the next one: thirty seconds, doubling up to six hours, never
 * past the message's expiry, where the expired failure is recorded
 * instead. No message is posted more times than its budget. A new
 * runtime counts from nothing again, which is safe because what a retry
 * posts is the same package. A pass asked for while one runs is run
 * once after it, however often it was asked for.
 */

import type { VaultRuntime } from "@estoc/event-store/v3";
import { scanVault, type Keys, type MessageId, type Outbound } from "@estoc/vault/v3";

import { prepare, type Prepared } from "./prepare.js";
import { submit, type SubmitOptions, type Submitted } from "./submit.js";

export interface RetryPolicy {
  /** the wait after an attempt that may succeed later; each such attempt in a row doubles it */
  firstWaitMs: number;
  /** the longest wait */
  longestWaitMs: number;
  /** the most posts of one message in this runtime's life */
  posts: number;
}

export const RETRY_POLICY: RetryPolicy = { firstWaitMs: 30_000, longestWaitMs: 21_600_000, posts: 32 };

/** What waits are kept by: the global timers by default, a test's own otherwise. */
export interface Timers {
  set(fire: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const GLOBAL_TIMERS: Timers = {
  set: (fire, ms) => setTimeout(fire, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface OutboxOptions extends Omit<SubmitOptions, "beforePost"> {
  retry?: Partial<RetryPolicy>;
  timers?: Timers;
  /** a line for the human log: what a pass could not work on */
  log?: (line: string) => void;
}

/** What the outbox keeps of a message it has attempted. */
export interface Backoff {
  messageId: MessageId;
  /** posts made in this runtime's life */
  posts: number;
  /** attempts in a row that may succeed later */
  failures: number;
  /** when the message is tried again, in milliseconds since the epoch; null while no attempt waits */
  nextAt: number | null;
  /** why the last attempt that may succeed later did not */
  reason: string | null;
}

/** One message worked on in a pass: what preparing and submitting it came to, or what was thrown. */
export interface Step {
  messageId: MessageId;
  prepared: Prepared | null;
  submitted: Submitted | null;
  error: string | null;
}

export class Outbox {
  private readonly policy: RetryPolicy;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly backoffs = new Map<MessageId, Backoff>();
  private timer: unknown = null;
  private running: Promise<Step[]> | null = null;
  private queued: Promise<Step[]> | null = null;
  private closed = false;

  constructor(
    private readonly runtime: VaultRuntime,
    private readonly keys: Keys,
    private readonly options: OutboxOptions
  ) {
    this.policy = { ...RETRY_POLICY, ...options.retry };
    this.timers = options.timers ?? GLOBAL_TIMERS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  /**
   * One pass over the messages owed work: what the runtime runs on
   * open, on reconnecting, after a send, and when a wait ends. A
   * message still waiting, or out of posts, is left for later. Asked
   * while a pass runs, it runs once more after that one.
   */
  drain(): Promise<Step[]> {
    if (this.closed) return Promise.resolve([]);
    if (this.running === null) {
      const running = this.pass().finally(() => {
        if (this.running === running) this.running = null;
      });
      this.running = running;
      return running;
    }
    if (this.queued === null) {
      this.queued = this.running.then(
        () => this.again(),
        () => this.again()
      );
    }
    return this.queued;
  }

  /** What is kept of each message attempted, for display. */
  waiting(): Backoff[] {
    return [...this.backoffs.values()].map((backoff) => ({ ...backoff }));
  }

  /** No pass after this one, and no wait kept: resolves once the pass running, if any, has ended. */
  async close(): Promise<void> {
    this.closed = true;
    this.cancel();
    await Promise.allSettled([this.running, this.queued]);
  }

  private again(): Promise<Step[]> {
    this.queued = null;
    return this.drain();
  }

  private async pass(): Promise<Step[]> {
    const fold = await scanVault(this.runtime.vault, this.keys);
    const steps: Step[] = [];
    for (const outbound of fold.outbound.outbounds.values()) {
      if (this.closed) break;
      if (outbound.work.kind === "none") {
        this.settle(outbound);
        continue;
      }
      const backoff = this.backoffs.get(outbound.messageId);
      if (backoff !== undefined && (backoff.posts >= this.policy.posts || (backoff.nextAt !== null && backoff.nextAt > this.now()))) continue;
      steps.push(await this.step(outbound));
    }
    this.schedule();
    return steps;
  }

  private async step(outbound: Outbound): Promise<Step> {
    const { messageId } = outbound;
    const step: Step = { messageId, prepared: null, submitted: null, error: null };
    try {
      if (outbound.work.kind === "prepare" || outbound.work.kind === "repack") {
        step.prepared = await prepare(this.runtime, this.keys, messageId, this.options);
        if (step.prepared.outcome === "unavailable") {
          this.wait(outbound, step.prepared.reason);
          return step;
        }
        if (step.prepared.outcome === "failed") {
          this.backoffs.delete(messageId);
          return step;
        }
      }
      step.submitted = await submit(this.runtime, this.keys, messageId, { ...this.options, beforePost: () => this.backoffOf(messageId).posts++ });
      if (step.submitted.outcome === "retry") this.wait(outbound, step.submitted.reason);
      else if (step.submitted.outcome === "none") this.settle(outbound);
      else this.backoffs.delete(messageId);
    } catch (err) {
      step.error = err instanceof Error ? err.message : String(err);
      this.log(`the outbound message ${messageId} could not be worked on: ${step.error}`);
      this.wait(outbound, step.error);
    }
    return step;
  }

  private backoffOf(messageId: MessageId): Backoff {
    let backoff = this.backoffs.get(messageId);
    if (backoff === undefined) {
      backoff = { messageId, posts: 0, failures: 0, nextAt: null, reason: null };
      this.backoffs.set(messageId, backoff);
    }
    return backoff;
  }

  private wait(outbound: Outbound, reason: string): void {
    const backoff = this.backoffOf(outbound.messageId);
    backoff.failures++;
    backoff.reason = reason;
    const waitMs = Math.min(this.policy.longestWaitMs, this.policy.firstWaitMs * 2 ** (backoff.failures - 1));
    const expiresTime = outbound.intent?.expiresTime ?? null;
    backoff.nextAt = expiresTime === null ? this.now() + waitMs : Math.min(this.now() + waitMs, expiresTime * 1000);
  }

  /** A message with nothing to wait for: closed for good, its backoff forgotten; otherwise only its posts are kept, since they count for the runtime's whole life. */
  private settle(outbound: Outbound): void {
    if (outbound.submitted || outbound.failed !== null) {
      this.backoffs.delete(outbound.messageId);
      return;
    }
    const backoff = this.backoffs.get(outbound.messageId);
    if (backoff === undefined) return;
    backoff.failures = 0;
    backoff.nextAt = null;
  }

  /** One timer, for the earliest wait of a message that still has posts left. */
  private schedule(): void {
    this.cancel();
    if (this.closed) return;
    let at: number | null = null;
    for (const backoff of this.backoffs.values()) {
      if (backoff.nextAt === null || backoff.posts >= this.policy.posts) continue;
      if (at === null || backoff.nextAt < at) at = backoff.nextAt;
    }
    if (at === null) return;
    this.timer = this.timers.set(
      () => {
        this.timer = null;
        this.drain().catch((err: unknown) => this.log(`an outbox pass failed: ${err instanceof Error ? err.message : String(err)}`));
      },
      Math.max(0, at - this.now())
    );
  }

  private cancel(): void {
    if (this.timer === null) return;
    this.timers.clear(this.timer);
    this.timer = null;
  }
}
