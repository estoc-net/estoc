/**
 * The two things a host does with a running vault besides sending and
 * receiving: read its records, and take the manual steps they name.
 * A read scans outside the writer lock, so it shows the vault as of
 * some commit and holds up none. The manual steps are the procedures
 * of the vault and of this package, every transport call of theirs
 * through one dispatcher; each still decides under the lock over the
 * fold it reads there, whatever record prompted it. The handlers given
 * here reach the read, the vault's own procedures and the completion
 * of a response. The dispatcher scans for itself, as it was built: its
 * caller gives it the same handlers' effect types.
 */

import type { Event, VaultRuntime } from "@estoc/event-store/v3";
import {
  blockChannels,
  deleteContact,
  eraseMessage,
  objectReader,
  scanVault,
  type Channel,
  type Committed,
  type ContactId,
  type DeleteContactOptions,
  type EventReference,
  type ExecutionId,
  type Keys,
  type MessageId,
  type ScanOptions,
} from "@estoc/vault/v3";

import type { LiveAction } from "./action.js";
import type { Cancelled, Dispatched } from "./dispatch.js";
import type { Dispatcher } from "./dispatcher.js";
import { completeResponse, type EffectOptions, type EffectOutcome } from "./effects.js";
import { effectTypesOf, handlersOf } from "./handlers/index.js";
import { MAX_CONTENT_BYTES } from "./prepare.js";
import { recorder, type ManualEntry, type Recorder, type ViewOptions } from "./records.js";
import { completeNotification, rotate, type RotateOptions, type Rotated, type RotationTarget } from "./rotate.js";

const scanOptionsOf = (options: ViewOptions): ScanOptions => ({ effectTypes: effectTypesOf(handlersOf(options.handlers)) });

/** The records of the vault as it is now. A body larger than a message may be is shown as missing. */
export async function readRecords(runtime: VaultRuntime, keys: Keys, options: ViewOptions = {}): Promise<Recorder> {
  const fold = await scanVault(runtime.vault, keys, scanOptionsOf(options));
  return recorder(fold, objectReader(runtime.vault.objects, MAX_CONTENT_BYTES), options);
}

export type ManualOptions = Pick<EffectOptions, "handlers" | "acknowledge" | "now" | "trace">;

/** Each manual procedure under the name a record gives it. `rotate` here is the user's own: it names no source. */
export interface Manual extends Record<ManualEntry, unknown> {
  eraseMessage(messageId: MessageId, because?: string): Promise<Committed>;
  deleteContact(contactId: ContactId, options?: DeleteContactOptions): Promise<Committed>;
  blockChannels(channels: readonly Channel[], includeSuccessors: boolean): Promise<Event[]>;
  cancel(messageId: MessageId): Promise<Cancelled>;
  retry(messageId: MessageId): Promise<Dispatched>;
  completeResponse(executionId: ExecutionId, effectType: string): Promise<EffectOutcome>;
  completeNotification(rotationEventId: EventReference<"did.rotationSelected">): Promise<EffectOutcome>;
  rotate(target: Omit<RotationTarget, "sourceEventId">, successor?: Pick<RotateOptions, "routeId" | "didId">): Promise<Rotated>;
}

export function manualProcedures(runtime: VaultRuntime, keys: Keys, dispatcher: Dispatcher, options: ManualOptions = {}): Manual {
  const scan = scanOptionsOf(options);
  const dispatch = (action: LiveAction): Promise<Dispatched> => dispatcher.run(action);
  const { now, trace } = options;
  return {
    eraseMessage: (messageId, because) => eraseMessage(runtime, keys, messageId, because, scan),
    deleteContact: (contactId, deletion) => deleteContact(runtime, keys, contactId, deletion, scan),
    blockChannels: (channels, includeSuccessors) => blockChannels(runtime, keys, channels, includeSuccessors, scan),
    cancel: (messageId) => dispatcher.cancel(messageId),
    retry: (messageId) => dispatcher.retry(messageId),
    completeResponse: (executionId, effectType) => completeResponse(runtime, keys, executionId, effectType, { ...options, dispatch }),
    completeNotification: (rotationEventId) => completeNotification(runtime, keys, rotationEventId, { now, trace, dispatch }),
    rotate: ({ localDidId, peerDid }, successor = {}) => rotate(runtime, keys, { localDidId, peerDid, sourceEventId: null }, { ...successor, now, trace, dispatch }),
  };
}
