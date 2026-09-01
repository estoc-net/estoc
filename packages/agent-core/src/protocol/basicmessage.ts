/**
 * basicmessage/2.0 (didcomm.org): a line of chat. Nothing to do on
 * arrival — the agent has recorded it and the application shows it — but
 * the type is registered (`handlers/basicmessage.ts`) so it is known mail,
 * not an unknown protocol.
 */
export const BASIC_MESSAGE = "https://didcomm.org/basicmessage/2.0/message";
