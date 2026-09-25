/**
 * Pickup (messagepickup 3.0): the mail the mediator holds for this
 * device, fetched and acknowledged over the link. A drain asks what is
 * queued, fetches it and hands every attachment over as it came: the
 * envelope it carries, unopened, or why it does not read. Whether an
 * envelope may be opened, and with which key, is the handle's to decide
 * before anything is decrypted. The socket's frames come here too: the
 * status that says live delivery is on is told to the caller, a delivery
 * pushed down is taken like one fetched. The handle decides each
 * attachment's fate: `acked`, the mediator may drop it; `skip`, it stays
 * queued for a later pickup — as does one the handle threw on, or one
 * with no ID to acknowledge it by. A handle that asks is told which
 * attachments the mediator was told of. The mediator's copy is the only copy,
 * so nothing here drops mail it could not hand over, and nothing is
 * counted acknowledged that the mediator was not told of.
 *
 * Every inbound step runs after the one before it — a delivery down the
 * socket, a delivery fetched — so what the handle records is in the
 * order the mail came, whichever way it came. Telling the mediator what
 * was taken is no such step: it goes out once a delivery's attachments
 * are handled, and a delivery behind it is handled while the mediator
 * answers.
 */

import { base64urlToUtf8 } from "@estoc/did-peer";

import type { IMessage } from "./protocol/didcomm.js";
import { DELIVERY, DELIVERY_REQUEST, MESSAGES_RECEIVED, STATUS, STATUS_REQUEST } from "./protocol/mediation.js";
import type { MediatorLink, Opened } from "./link.js";

/** What became of a delivered attachment: taken (acknowledged, the mediator drops it) or left queued for a later pickup. */
export type Fate = "acked" | "skip";

/** One attachment of a delivery: the envelope it carries, or why it does not read; `parent` is the trace entry of the delivery it came in. */
export type Delivered = { attachmentId: string; parent?: number } & ({ packed: string } | { unreadable: string });

export type Handle = ((delivered: Delivered) => Promise<Fate> | Fate) & { acknowledged?: (attachmentIds: readonly string[]) => void };

export interface PickupOptions {
  /** live delivery came on: the mediator's answer to the socket's first frame */
  onLive?: () => void;
  log?: (line: string) => void;
}

/** How a drain went: what it acknowledged, and why it stopped. */
export interface Drained {
  /** attachments acknowledged, over every round */
  acked: number;
  /** `empty`: the queue is; `left`: a round acknowledged nothing, so what is queued waits for a later pickup; `rounds`: ten rounds ran, and what is queued now was not asked */
  ended: "empty" | "left" | "rounds";
}

/** The rounds one drain runs at most: mail can keep coming while it runs. */
const ROUNDS = 10;

interface DeliveryAttachment {
  id?: string;
  data?: { base64?: string; json?: unknown; links?: unknown };
}

/**
 * The packed envelope an attachment carries. Throws for one that carries
 * it by link — the content is elsewhere, and fetching it is not done
 * here — for one with nothing inside, and for bytes that will not decode.
 */
function insideOf(attachment: DeliveryAttachment): string {
  const data = attachment.data;
  if (typeof data?.base64 === "string") {
    return base64urlToUtf8(data.base64);
  }
  if (data?.json !== undefined) {
    return JSON.stringify(data.json);
  }
  if (data?.links !== undefined) {
    throw new Error("the attachment is by link, which is not fetched here");
  }
  throw new Error("the attachment has nothing inside");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The count a status carries. The specification makes `message_count`
 * required; a status without one, or with something that is no count,
 * is the mediator's error, not an empty queue.
 */
function countOf(status: IMessage): number {
  const count = status.body["message_count"];
  if (count === undefined) {
    throw new Error("mediator's status has no message count");
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new Error(`mediator's status is not a count: ${JSON.stringify(count)}`);
  }
  return count;
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
   * queue is empty, a round acknowledges nothing — mail left queued
   * would only be fetched again in the same breath — or ten rounds have
   * run. Throws when the line is cut, or when the mediator answers
   * something else than the ritual says — a problem report, a status
   * with no count or one that counts mail it does not deliver: none of
   * that is an empty queue.
   */
  async drain(): Promise<Drained> {
    let acked = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const status = await this.link.roundTrip(STATUS_REQUEST, {});
      if (status.type !== STATUS) {
        throw new Error(`mediator answered ${status.type} to status-request`);
      }
      const count = countOf(status);
      if (count === 0) {
        return { acked, ended: "empty" };
      }
      this.log(`${count} message(s) queued at the mediator`);
      const delivery = await this.link.exchange(DELIVERY_REQUEST, { limit: count });
      if (delivery.msg.type === STATUS) {
        // a status instead of a delivery says the queue emptied between the two questions; one that counts mail and hands none over is no answer
        const now = countOf(delivery.msg);
        if (now !== 0) {
          throw new Error(`mediator answered delivery-request with a status of ${now} queued and no delivery`);
        }
        return { acked, ended: "empty" };
      }
      if (delivery.msg.type !== DELIVERY) {
        throw new Error(`mediator answered ${delivery.msg.type} to delivery-request`);
      }
      const taken = await this.acknowledgeTaken(await this.enqueue(() => this.take(delivery.msg, delivery.seq)));
      acked += taken;
      if (taken === 0) {
        this.log("nothing acknowledged this round; leaving the queue for a later pickup");
        return { acked, ended: "left" };
      }
    }
    this.log("pickup stopped after ten rounds");
    return { acked, ended: "rounds" };
  }

  /**
   * A frame down the socket (`link.openSocket`): a status saying live
   * delivery is on is told to `onLive`; a delivery is taken, in turn
   * with every other inbound step, and what was taken acknowledged off
   * that turn; anything else is logged.
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
      await this.acknowledgeTaken(await this.enqueue(() => this.take(msg, opened.seq)));
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

  /** Tell the mediator these attachments are taken; throws when it was not told. */
  async acknowledge(attachmentIds: readonly string[]): Promise<void> {
    const answer = await this.link.roundTrip(MESSAGES_RECEIVED, { message_id_list: [...attachmentIds] });
    if (answer.type !== STATUS) {
      throw new Error(`mediator answered ${answer.type} to messages-received`);
    }
    this.handle.acknowledged?.(attachmentIds);
  }

  /**
   * One delivery: every attachment handed over, in turn. One bad
   * attachment stops nothing: the rest are handed over. Returns the
   * attachments the handle took, for the mediator to be told of.
   */
  private async take(delivery: IMessage, parent?: number): Promise<string[]> {
    const attachments = (delivery.attachments ?? []) as DeliveryAttachment[];
    const taken: string[] = [];
    for (const attachment of attachments) {
      const attachmentId = attachment.id;
      if (attachmentId === undefined) {
        this.log("a delivered attachment has no id to acknowledge it by; leaving it queued");
        continue;
      }
      let delivered: Delivered;
      try {
        delivered = { attachmentId, parent, packed: insideOf(attachment) };
      } catch (err) {
        delivered = { attachmentId, parent, unreadable: messageOf(err) };
      }
      let fate: Fate;
      try {
        fate = await this.handle(delivered);
      } catch (err) {
        this.log(`a delivered attachment was not handled; leaving it queued: ${messageOf(err)}`);
        fate = "skip";
      }
      if (fate === "acked") {
        taken.push(attachmentId);
      }
    }
    return taken;
  }

  /** The taken attachments acknowledged. Returns how many the mediator was told of — none when the acknowledgement itself failed, as they are all still queued. */
  private async acknowledgeTaken(taken: readonly string[]): Promise<number> {
    if (taken.length === 0) {
      return 0;
    }
    try {
      await this.acknowledge(taken);
    } catch (err) {
      this.log(`ack failed (${messageOf(err)}); messages stay queued and will be deduplicated on the next pickup`);
      return 0;
    }
    return taken.length;
  }
}
