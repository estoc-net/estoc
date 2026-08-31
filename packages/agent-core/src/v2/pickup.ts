/**
 * Pickup (messagepickup 3.0): the mail the mediator holds for this
 * device, fetched and acknowledged over the link. A drain asks what is
 * queued, fetches it, opens every attachment and hands each one over;
 * the ones taken are acknowledged and the mediator drops them. The
 * socket's frames come here too: the status that says live delivery is
 * on is told to the caller, a delivery pushed down is taken like one
 * fetched. What an opened message means is the handle's, and so is its
 * fate: `acked`, the mediator may drop it; `skip`, it stays queued for a
 * later pickup — as does one that would not open, or that the handle
 * threw on. The mediator's copy is the only copy, so nothing here drops
 * mail it could not hand over.
 *
 * Every inbound step runs after the one before it — a delivery down the
 * socket, a delivery fetched — so what the handle records is in the
 * order the mail came, whichever way it came.
 *
 * Moved from the v1 agent (drainQueue, processDelivery, enqueueInbound,
 * the socket's frame dispatch), the decisions left to the handle.
 */

import { base64urlToUtf8 } from "@estoc/did-peer";

import type { IMessage } from "../protocol/didcomm.js";
import { DELIVERY, DELIVERY_REQUEST, MESSAGES_RECEIVED, STATUS, STATUS_REQUEST } from "../protocol/mediation.js";
import type { MediatorLink, Opened } from "./link.js";

/** What became of an opened message: taken (acknowledged, the mediator drops it) or left queued for a later pickup. */
export type Fate = "acked" | "skip";

/**
 * What to do with an opened message. It is the handle's to note the
 * open (`link.noteOpen`) once it knows the record the message ended in;
 * one it did not note is noted here, naming no record.
 */
export type Handle = (opened: Opened) => Promise<Fate> | Fate;

export interface PickupOptions {
  /** live delivery came on: the mediator's answer to the socket's first frame */
  onLive?: () => void;
  log?: (line: string) => void;
}

/** How a drain went: what it acknowledged, and why it stopped. */
export interface Drained {
  /** attachments acknowledged, over every round */
  acked: number;
  /** `empty`: the queue is; `left`: a round took nothing, so what is queued waits for a later pickup; `rounds`: ten rounds and mail still queued */
  ended: "empty" | "left" | "rounds";
}

/** The rounds one drain runs at most: mail can keep coming while it runs. */
const ROUNDS = 10;

interface DeliveryAttachment {
  id?: string;
  data?: { base64?: string; json?: unknown };
}

/** The packed envelope an attachment carries, or null when it carries nothing to open. */
function insideOf(attachment: DeliveryAttachment): string | null {
  if (typeof attachment.data?.base64 === "string") {
    return base64urlToUtf8(attachment.data.base64);
  }
  if (attachment.data?.json !== undefined) {
    return JSON.stringify(attachment.data.json);
  }
  return null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Pickup {
  private readonly onLive: () => void;
  private readonly log: (line: string) => void;
  private inbound: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly link: MediatorLink,
    private readonly handle: Handle,
    options: PickupOptions = {}
  ) {
    this.onLive = options.onLive ?? (() => undefined);
    this.log = options.log ?? (() => undefined);
  }

  /**
   * The pickup loop: status → delivery-request → take → ack, until the
   * queue is empty, a round takes nothing — mail left queued would only
   * be fetched again in the same breath — or ten rounds have run.
   */
  async drain(): Promise<Drained> {
    let acked = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const status = await this.link.roundTrip(STATUS_REQUEST, {});
      const count = status.type === STATUS && typeof status.body["message_count"] === "number" ? status.body["message_count"] : 0;
      if (count === 0) {
        return { acked, ended: "empty" };
      }
      this.log(`${count} message(s) queued at the mediator`);
      const delivery = await this.link.exchange(DELIVERY_REQUEST, { limit: count });
      if (delivery.msg.type !== DELIVERY) {
        // a status instead: the queue emptied between the two questions
        return { acked, ended: "empty" };
      }
      const taken = await this.enqueue(() => this.take(delivery.msg, delivery.eid));
      acked += taken;
      if (taken === 0) {
        this.log("nothing in the queue could be taken now; leaving it for a later pickup");
        return { acked, ended: "left" };
      }
    }
    this.log("pickup stopped after ten rounds with mail still queued");
    return { acked, ended: "rounds" };
  }

  /**
   * A frame down the socket (`link.openSocket`): a status saying live
   * delivery is on is told to `onLive`; a delivery is taken, in turn
   * with every other inbound step; anything else is logged.
   */
  async onFrame(opened: Opened): Promise<void> {
    const { msg } = opened;
    if (msg.type === STATUS) {
      if (msg.body["live_delivery"] === true) {
        this.onLive();
      }
      return;
    }
    if (msg.type === DELIVERY) {
      await this.enqueue(() => this.take(msg, opened.eid));
      return;
    }
    this.log(`unexpected frame type ${msg.type ?? "unknown"}`);
  }

  /** Run one inbound step after every earlier one has finished; a step that failed does not stop the ones after it. */
  enqueue<T>(step: () => Promise<T>): Promise<T> {
    const run = this.inbound.then(step);
    this.inbound = run.catch(() => undefined);
    return run;
  }

  /**
   * One delivery: every attachment opened and handed over, the taken
   * ones acknowledged. One that will not open — sealed to a key this
   * device no longer holds, or a resolver hiccup — is logged and left
   * queued (`envelope.error` written by the link); so is one the handle
   * threw on. One with nothing inside is taken without opening: there
   * is nothing to come back for. Returns how many were acknowledged.
   */
  private async take(delivery: IMessage, parent?: string): Promise<number> {
    const attachments = (delivery.attachments ?? []) as DeliveryAttachment[];
    const taken: string[] = [];
    const take = (attachment: DeliveryAttachment) => {
      if (attachment.id !== undefined) {
        taken.push(attachment.id);
      }
    };
    for (const attachment of attachments) {
      const packed = insideOf(attachment);
      if (packed === null) {
        take(attachment);
        continue;
      }
      let opened: Opened;
      try {
        opened = await this.link.unpack(packed, parent);
      } catch (err) {
        this.log(`could not open a delivered envelope; leaving it queued: ${messageOf(err)}`);
        continue;
      }
      let fate: Fate;
      try {
        fate = await this.handle(opened);
      } catch (err) {
        this.log(`a delivered ${opened.msg.type} was not handled; leaving it queued: ${messageOf(err)}`);
        fate = "skip";
      }
      if (opened.eid === undefined) {
        await this.link.noteOpen(opened);
      }
      if (fate === "acked") {
        take(attachment);
      }
    }
    if (taken.length > 0) {
      try {
        await this.link.roundTrip(MESSAGES_RECEIVED, { message_id_list: taken });
      } catch (err) {
        this.log(`ack failed (${messageOf(err)}); messages stay queued and will be deduplicated on the next pickup`);
      }
    }
    return taken.length;
  }
}
