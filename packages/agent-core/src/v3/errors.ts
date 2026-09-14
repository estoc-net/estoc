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
