/**
 * The dispatcher holds the live actions of a runtime while their
 * prerequisites are waited for. A message whose call is held up by
 * something that may still come — a long form not yet in evidence, a
 * mediator out of reach, a registration not yet confirmed — is tried
 * again after a wait, thirty seconds doubling up to six hours, for as
 * long as its action lives: until the call is made, the message
 * closes, the attempts run out or the dispatcher closes. A call that
 * was made and refused, or whose outcome is unknown, is not tried
 * again: its action is spent, and only a manual retry, a fresh action,
 * calls again. Nothing here scans the vault for work to send: what an
 * open finds waiting is listed for the user, who retries or cancels.
 */

import type { VaultRuntime } from "@estoc/event-store/v3";
import { scanVault, unfinishedWork, type Keys, type MessageId, type Outbound } from "@estoc/vault/v3";

import { LiveAction, type ActionKind } from "./action.js";
import { cancel, dispatch, type Cancelled, type DispatchOptions, type Dispatched } from "./dispatch.js";
import { scanOptions } from "./prepare.js";

export interface RetryPolicy {
  /** the wait after an attempt held up by a prerequisite; each such attempt in a row doubles it */
  firstWaitMs: number;
  /** the longest wait */
  longestWaitMs: number;
  /** the most attempts one action makes */
  attempts: number;
}

export const RETRY_POLICY: RetryPolicy = { firstWaitMs: 30_000, longestWaitMs: 21_600_000, attempts: 32 };

/** Timers take no longer delay; a wait further off is reached by waits of this length. */
export const LONGEST_TIMER_MS = 2 ** 31 - 1;

/** What waits are kept by: the global timers by default, a test's own otherwise. */
export interface Timers {
  set(fire: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const GLOBAL_TIMERS: Timers = {
  set: (fire, ms) => setTimeout(fire, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface DispatcherOptions extends DispatchOptions {
  retry?: Partial<RetryPolicy>;
  timers?: Timers;
  /** a line for the human log: an attempt that threw, an action given up on */
  log?: (line: string) => void;
}

/** What the dispatcher keeps of a live action between attempts. */
export interface Waiting {
  messageId: MessageId;
  kind: ActionKind;
  attempts: number;
  /** when the next attempt is due, in milliseconds since the epoch; null while one is running */
  nextAt: number | null;
  /** what the last attempt was held up by */
  reason: string | null;
}

/** An outbound not yet submitted or terminated, with the live action waiting on it when this runtime holds one. */
export interface PendingOutbound {
  outbound: Outbound;
  waiting: Waiting | null;
}

interface Wait extends Waiting {
  action: LiveAction;
  timer: unknown;
}

export class Dispatcher {
  private readonly policy: RetryPolicy;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly waits = new Map<MessageId, Wait>();
  private closed = false;

  constructor(
    private readonly runtime: VaultRuntime,
    private readonly keys: Keys,
    private readonly options: DispatcherOptions
  ) {
    this.policy = { ...RETRY_POLICY, ...options.retry };
    this.timers = options.timers ?? GLOBAL_TIMERS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  /**
   * The message's call under `action`, now. Held up by a prerequisite,
   * the action is kept and tried again after a wait; a newer action for
   * the same message replaces one still waiting. The first attempt's
   * outcome is returned.
   */
  run(action: LiveAction): Promise<Dispatched> {
    const { messageId } = action;
    if (this.closed) return Promise.resolve({ outcome: "none", messageId, because: "the dispatcher is closed" });
    this.drop(messageId);
    const wait: Wait = { messageId, kind: action.kind, action, attempts: 0, nextAt: null, reason: null, timer: null };
    this.waits.set(messageId, wait);
    return this.attempt(wait);
  }

  /** A fresh manual action for a message already recorded: the user's retry of one that is prepared, or whose call was refused or lost. */
  retry(messageId: MessageId): Promise<Dispatched> {
    return this.run(new LiveAction(messageId, "manual"));
  }

  /** `cancel`, with the action waiting on the message, if any, dropped first. */
  cancel(messageId: MessageId): Promise<Cancelled> {
    this.drop(messageId);
    return cancel(this.runtime, this.keys, messageId, { trace: this.options.trace });
  }

  /** Every outbound the fold lists for manual action, in message order, with what this runtime is waiting on for it. */
  async pending(): Promise<PendingOutbound[]> {
    const fold = await scanVault(this.runtime.vault, this.keys, scanOptions(this.options));
    return unfinishedWork(fold).outbounds.map((outbound) => ({ outbound, waiting: this.waitingOn(outbound.messageId) }));
  }

  /** The actions kept between attempts, for display. */
  waiting(): Waiting[] {
    return [...this.waits.keys()].map((messageId) => this.waitingOn(messageId) as Waiting);
  }

  /** No attempt after the ones running, and no wait kept. */
  close(): void {
    this.closed = true;
    for (const wait of this.waits.values()) this.clear(wait);
    this.waits.clear();
  }

  private waitingOn(messageId: MessageId): Waiting | null {
    const wait = this.waits.get(messageId);
    return wait === undefined ? null : { messageId, kind: wait.kind, attempts: wait.attempts, nextAt: wait.nextAt, reason: wait.reason };
  }

  private async attempt(wait: Wait): Promise<Dispatched> {
    wait.attempts++;
    wait.nextAt = null;
    let result: Dispatched;
    try {
      result = await dispatch(this.runtime, this.keys, wait.action, this.options);
    } catch (err) {
      this.forget(wait);
      throw err;
    }
    if (result.outcome === "pending" && this.waits.get(wait.messageId) === wait && !this.closed) this.schedule(wait, result.because);
    else this.forget(wait);
    return result;
  }

  /** The next attempt after one held up: the wait doubles with each in a row, and the action is given up on once the attempts are spent. */
  private schedule(wait: Wait, reason: string): void {
    wait.reason = reason;
    if (wait.attempts >= this.policy.attempts) {
      this.log(`the outbound message ${wait.messageId} is given up on after ${wait.attempts} attempts: ${reason}`);
      this.forget(wait);
      return;
    }
    const delay = Math.min(this.policy.longestWaitMs, this.policy.firstWaitMs * 2 ** (wait.attempts - 1));
    wait.nextAt = this.now() + delay;
    wait.timer = this.timers.set(
      () => {
        wait.timer = null;
        this.attempt(wait).catch((err: unknown) => this.log(`the outbound message ${wait.messageId} could not be worked on: ${err instanceof Error ? err.message : String(err)}`));
      },
      Math.min(LONGEST_TIMER_MS, delay)
    );
  }

  private forget(wait: Wait): void {
    this.clear(wait);
    if (this.waits.get(wait.messageId) === wait) this.waits.delete(wait.messageId);
  }

  private drop(messageId: MessageId): void {
    const wait = this.waits.get(messageId);
    if (wait !== undefined) this.forget(wait);
  }

  private clear(wait: Wait): void {
    if (wait.timer === null) return;
    this.timers.clear(wait.timer);
    wait.timer = null;
  }
}
