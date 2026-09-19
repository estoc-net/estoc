/** A procedure names an entity — a mediation, a route, a DID — the fold does not have. */
export class UnknownEntity extends Error {
  constructor(what: string, id: string) {
    super(`no ${what} ${id}`);
    this.name = "UnknownEntity";
  }
}

/** The entity is there but cannot be used as asked: a conflict, a retirement, a missing prerequisite. The fold's faults say which. */
export class Unusable extends Error {
  constructor(
    what: string,
    id: string,
    readonly faults: readonly string[]
  ) {
    super(`${what} ${id} is not usable: ${faults.join("; ") || "unknown"}`);
    this.name = "Unusable";
  }
}

/** A recorded entity under the requested ID whose identity fields disagree with what would be created now. */
export class EntityConflict extends Error {
  constructor(what: string, id: string, detail: string) {
    super(`${what} ${id} is already recorded as something else: ${detail}`);
    this.name = "EntityConflict";
  }
}

/** The link is to another mediator than the arrangement's: a ritual run over it would record a lie. */
export class WrongMediator extends Error {
  constructor(expected: string, actual: string) {
    super(`the link is to ${actual}, not the arrangement's mediator ${expected}`);
    this.name = "WrongMediator";
  }
}

/** The mediator answered something else than the ritual asks for, or refused what was asked. */
export class MediatorRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediatorRefused";
  }
}

/** A mediated address whose registration the mediator does not confirm: not disclosed. */
export class Unregistered extends Error {
  constructor(did: string) {
    super(`${did} is not registered with its mediator`);
    this.name = "Unregistered";
  }
}

/** The link speaks for another arrangement's identity than the one named: a ritual run over it would be recorded against the wrong account. */
export class WrongAccount extends Error {
  constructor(expected: string, actual: string) {
    super(`the link speaks as ${actual}, not the arrangement's identity ${expected}`);
    this.name = "WrongAccount";
  }
}

/** What came back over the line to the mediator was not sealed by the mediator to this account: whatever it says, it is not the mediator's answer. */
export class UnverifiedReply extends Error {
  constructor(reason: string) {
    super(`the reply was not sealed by the mediator to this account: ${reason}`);
    this.name = "UnverifiedReply";
  }
}

/** The key an observation or a selection names is not one the resolved document authorizes for any use. */
export class UnauthorizedKey extends Error {
  constructor(did: string, publicKey: string) {
    super(`${did}'s document authorizes no method carrying ${publicKey}`);
    this.name = "UnauthorizedKey";
  }
}

/** A contact's selected channels lead to more than one head a send may go to, or its preference matches none of them: which one is the caller's to say, as a channel. */
export class AmbiguousTarget extends Error {
  constructor(
    contactId: string,
    readonly channels: readonly { localDid: string; peerDid: string }[],
    readonly preferenceMatchesNone: boolean
  ) {
    super(`contact ${contactId} may be written to at ${channels.length} channels${preferenceMatchesNone ? ", none of them under its preferred DID" : ""}: ${channels.map((channel) => `${channel.localDid} / ${channel.peerDid}`).join(", ")}`);
    this.name = "AmbiguousTarget";
  }
}

/** A contact's selected channels lead to no head a send may go to now. */
export class NoTarget extends Error {
  constructor(contactId: string, because: string) {
    super(`contact ${contactId} cannot be written to: ${because}`);
    this.name = "NoTarget";
  }
}

/** The runtime already receives through another receiver: two would each keep their own account of what waits and what ended. */
export class ReceiverInUse extends Error {
  constructor() {
    super("the runtime already has a receiver open");
    this.name = "ReceiverInUse";
  }
}

/** The receiver was closed before this delivery reached the receipt: it stays wherever it came from. */
export class ReceiverClosed extends Error {
  constructor() {
    super("the receiver is closed");
    this.name = "ReceiverClosed";
  }
}
