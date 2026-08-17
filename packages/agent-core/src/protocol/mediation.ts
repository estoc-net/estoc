/**
 * The community protocols the agent uses as its transport: mediation and
 * pickup with its mediator (didcomm.org registry, not the specification).
 * Traffic in these protocols runs between the agent and its mediator, not
 * between the user and a contact, and a delivery is only an envelope
 * around the real mail — so none of it enters the message log.
 */

export const MEDIATE_REQUEST =
  "https://didcomm.org/coordinate-mediation/3.0/mediate-request";
export const MEDIATE_GRANT =
  "https://didcomm.org/coordinate-mediation/3.0/mediate-grant";
export const RECIPIENT_UPDATE =
  "https://didcomm.org/coordinate-mediation/3.0/recipient-update";
export const RECIPIENT_UPDATE_RESPONSE =
  "https://didcomm.org/coordinate-mediation/3.0/recipient-update-response";
export const STATUS_REQUEST = "https://didcomm.org/messagepickup/3.0/status-request";
export const STATUS = "https://didcomm.org/messagepickup/3.0/status";
export const DELIVERY_REQUEST =
  "https://didcomm.org/messagepickup/3.0/delivery-request";
export const DELIVERY = "https://didcomm.org/messagepickup/3.0/delivery";
export const MESSAGES_RECEIVED =
  "https://didcomm.org/messagepickup/3.0/messages-received";
export const LIVE_DELIVERY_CHANGE =
  "https://didcomm.org/messagepickup/3.0/live-delivery-change";
