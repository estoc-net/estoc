/**
 * The accounting of one delivery's sender resolution: how many calls
 * have been made without a definitive answer, how long the sequence has
 * been active, and when the next call is due. Only active time counts
 * toward the retention stop — the calls and the waits between them —
 * never time the delivery was held for something else, a vault not
 * ready or a recipient not yet usable. The stop is fixed at the first
 * call from what the mediator says it retains: the time left before a
 * known deadline still ahead, or an advertised duration, whichever is
 * shorter. A deadline already passed, or none known, sets no stop; the
 * call budget still ends the sequence.
 */

export interface ResolutionPolicy {
  /** the wait after the first unavailable answer; each further one doubles it */
  firstWaitMs: number;
  /** the longest wait */
  longestWaitMs: number;
  /** the most resolver calls one sequence makes */
  attempts: number;
}

export const RESOLUTION_POLICY: ResolutionPolicy = { firstWaitMs: 30_000, longestWaitMs: 21_600_000, attempts: 32 };

/** What the mediator says of how long it keeps a delivery; either may be unknown. */
export interface Retention {
  /** when it drops the delivery, in milliseconds since the epoch */
  deadline?: number | null;
  /** how long it keeps a delivery, in milliseconds */
  durationMs?: number | null;
}

export class ResolutionSequence {
  private calls = 0;
  private activeMs = 0;
  /** when the sequence last became active; null while suspended */
  private resumedAt: number | null;
  private readonly stopMs: number | null;
  /** when the next call is due; null until an answer came back unavailable */
  nextAt: number | null = null;

  /** A sequence starting with its first call, at `now`. */
  constructor(
    private readonly policy: ResolutionPolicy,
    now: number,
    retention: Retention
  ) {
    this.resumedAt = now;
    const stops: number[] = [];
    if (retention.deadline != null && retention.deadline > now) stops.push(retention.deadline - now);
    if (retention.durationMs != null) stops.push(retention.durationMs);
    this.stopMs = stops.length === 0 ? null : Math.min(...stops);
  }

  get attempts(): number {
    return this.calls;
  }

  elapsed(now: number): number {
    return this.activeMs + (this.resumedAt === null ? 0 : now - this.resumedAt);
  }

  suspend(now: number): void {
    if (this.resumedAt === null) return;
    this.activeMs += now - this.resumedAt;
    this.resumedAt = null;
  }

  resume(now: number): void {
    if (this.resumedAt === null) this.resumedAt = now;
  }

  /** Why no further call may be made, or null while one may. */
  stopped(now: number): string | null {
    if (this.calls >= this.policy.attempts) return `no definitive answer after ${this.calls} resolutions`;
    return this.pastStop(now);
  }

  /** Why the retention stop has come, or null while it has not. */
  pastStop(now: number): string | null {
    return this.stopMs !== null && this.elapsed(now) >= this.stopMs ? `no definitive answer within the ${this.stopMs} ms the mediator keeps the delivery` : null;
  }

  /** The active time left before the stop, which also bounds a call in progress; null when nothing stops the sequence. */
  remaining(now: number): number | null {
    return this.stopMs === null ? null : Math.max(0, this.stopMs - this.elapsed(now));
  }

  due(now: number): boolean {
    return this.nextAt === null || this.nextAt <= now;
  }

  /** A call about to be made: counted before it is. */
  count(): void {
    this.calls++;
  }

  /** An unavailable answer while a call is left: when to look again — the next call, or the stop when it comes first. */
  unavailable(now: number): number {
    const nextAt = now + Math.min(this.policy.longestWaitMs, this.policy.firstWaitMs * 2 ** (this.calls - 1));
    this.nextAt = nextAt;
    return this.until(nextAt, now);
  }

  /** When to look again while a call waits; null when none does. */
  wake(now: number): number | null {
    return this.nextAt === null ? null : this.until(this.nextAt, now);
  }

  private until(at: number, now: number): number {
    const left = this.remaining(now);
    return left === null ? at : Math.min(at, now + left);
  }
}
