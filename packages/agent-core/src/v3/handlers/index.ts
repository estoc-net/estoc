import { basicMessage } from "./basicmessage.js";
import { empty } from "./empty.js";
import type { Handler } from "./handler.js";
import { reportProblem } from "./report-problem.js";
import { trustPing } from "./trust-ping.js";
import { userProfile } from "./user-profile.js";

export { effectTypesOf, handlerFor, type Handler, type Input, type Response } from "./handler.js";
export { trustPing } from "./trust-ping.js";
export { basicMessage } from "./basicmessage.js";
export { empty } from "./empty.js";
export { reportProblem } from "./report-problem.js";
export { claimedName, userProfile } from "./user-profile.js";

export const BUILT_IN_HANDLERS: readonly Handler[] = [trustPing, basicMessage, empty, reportProblem, userProfile];

/** The handlers a runtime answers with: those registered first, so that one covers a type before a built-in does. */
export function handlersOf(registered: readonly Handler[] = []): Handler[] {
  return [...registered, ...BUILT_IN_HANDLERS];
}
