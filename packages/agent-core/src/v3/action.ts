/**
 * A live action is the authority to call transport once for one
 * message: the fold says what a message still needs and never whether
 * to make the call. An action is minted by the live event that decided
 * the message — the user's send, the input a live receipt answered —
 * or by an explicit manual step: a retry, a completion. Opening a
 * vault, importing, restoring or rebuilding views mints none; a message
 * such a runtime finds waiting is shown for manual action. An action
 * carries exactly one invocation, consumed under the lock right before
 * the call, so that a crash before or after the call, or a call whose
 * outcome is unknown, leaves the message where a fresh manual action is
 * needed and nothing repeats the call on its own.
 */

import type { MessageId } from "@estoc/vault/v3";

/** `initial`: minted with the intent by the live event that decided it. `manual`: minted by an explicit later step for a message already recorded. */
export type ActionKind = "initial" | "manual";

export class LiveAction {
  #spent = false;

  constructor(
    readonly messageId: MessageId,
    readonly kind: ActionKind
  ) {}

  /** The one invocation is used up: no transport call is made under this action again. */
  get spent(): boolean {
    return this.#spent;
  }

  /** Use up the one invocation; false when it was used already. */
  consume(): boolean {
    if (this.#spent) return false;
    this.#spent = true;
    return true;
  }
}
