/**
 * out-of-band/2.0 invitations over the v2 fold: the message an issued
 * invitation stands for. Reading one back (`parseInvitation`) and
 * carrying it in a URL (`invitationUrl`) are the same as before; only
 * the record they start from changed.
 */

import { PLAIN_TYP } from "./protocol/didcomm.js";
import { GOAL_CONNECT, type Invitation } from "./protocol/oob.js";
import { OOB_INVITATION } from "./protocol/spec.js";
import type { InvitationRecord } from "./records.js";

export { GOAL_CONNECT, invitationUrl, parseInvitation, type Invitation } from "./protocol/oob.js";

/**
 * The invitation message an issued invitation record stands for: its
 * out-of-band id, its DID, its goal when it has one. Throws for a record
 * whose DID this vault does not hold — a `did.published` seen ahead of
 * its `did.minted`, another device's until a merge brings the rest.
 */
export function invitationMessage(record: InvitationRecord): Invitation {
  if (record.did === null) {
    throw new Error(`the invitation ${record.id} names a DID this vault does not hold yet`);
  }
  return {
    type: OOB_INVITATION,
    id: record.id,
    typ: PLAIN_TYP,
    from: record.did,
    body: {
      goal_code: GOAL_CONNECT,
      ...(record.goal === null ? {} : { goal: record.goal }),
      accept: ["didcomm/v2"],
    },
  };
}
