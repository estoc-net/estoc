import type { ProtocolHandler } from "./handler.js";

/**
 * basicmessage/2.0 (didcomm.org): a line of chat. Nothing to do on
 * arrival — the agent has logged it and the application shows it — but
 * the type is registered so it is known mail, not an unknown protocol.
 */
export const BASIC_MESSAGE = "https://didcomm.org/basicmessage/2.0/message";

export const basicmessageHandler: ProtocolHandler = {
  types: [BASIC_MESSAGE],
};
