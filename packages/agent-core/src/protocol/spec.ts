/**
 * Protocols the DIDComm v2 specification itself defines. These are the
 * agent's own business — routing, liveness, invitations, and (via
 * `from_prior`) DID rotation — and are wired straight into `Agent`, not
 * offered through the handler seam: an application cannot unregister
 * how an envelope is forwarded or how a rotation is verified.
 *
 * Everything else the agent speaks is a community protocol from the
 * didcomm.org registry — see `mediation.ts` for the ones it uses as
 * transport and `handler.ts` for the ones it treats as application mail.
 */

export const FORWARD = "https://didcomm.org/routing/2.0/forward";
export const TRUST_PING = "https://didcomm.org/trust-ping/2.0/ping";
export const TRUST_PING_RESPONSE = "https://didcomm.org/trust-ping/2.0/ping-response";
export const OOB_INVITATION = "https://didcomm.org/out-of-band/2.0/invitation";
/** Not in `isSpecType`: a problem-report is read in its thread by whoever asked, not routed as mail of its own. */
export const PROBLEM_REPORT = "https://didcomm.org/report-problem/2.0/problem-report";

/** Whether a message type is one the specification defines — handled by the agent itself. */
export function isSpecType(type: string): boolean {
  return type === FORWARD || type === TRUST_PING || type === TRUST_PING_RESPONSE || type === OOB_INVITATION;
}
