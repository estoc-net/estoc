/**
 * empty/1.0 (didcomm.org): a message that carries only headers. It is
 * how a peer acknowledges, and how it announces a rotation; either
 * says what it says by arriving, and no protocol answer is owed. What
 * such a message may still earn is the receipt it asks for, which the
 * vault gives under its own policy and never to a pure acknowledgement.
 */

import { EMPTY_MESSAGE_TYPE } from "@estoc/vault";

import type { Handler } from "./handler.js";

export const empty: Handler = {
  types: [EMPTY_MESSAGE_TYPE],
  effectTypes: [],
  respond: async () => [],
};
