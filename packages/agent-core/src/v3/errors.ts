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

/** A contact has more than one relationship a message may be sent in and no preference among them: which one is the caller's to say. */
export class AmbiguousTarget extends Error {
  constructor(
    contactId: string,
    readonly relationshipIds: readonly string[]
  ) {
    super(`contact ${contactId} may be written in ${relationshipIds.length} relationships: ${relationshipIds.join(", ")}`);
    this.name = "AmbiguousTarget";
  }
}

/** A runtime receives through one receiver at a time: every way a delivery arrives shares one accounting of it and one wait. */
export class ReceiverInUse extends Error {
  constructor() {
    super("the runtime already has an open receiver");
    this.name = "ReceiverInUse";
  }
}

/** The receiver is closed: the delivery was neither opened nor found terminal, and stays wherever it came from. */
export class ReceiverClosed extends Error {
  constructor() {
    super("the receiver is closed");
    this.name = "ReceiverClosed";
  }
}
