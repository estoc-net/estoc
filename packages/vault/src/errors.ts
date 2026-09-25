/** An input to a deterministic derivation that the derivation does not accept. */
export class InvalidIdentifier extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIdentifier";
  }
}

/** A value that is not a public key in a supported representation. */
export class InvalidPublicKey extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPublicKey";
  }
}

/** A DIDComm plaintext, or one of its attachments, that the stored representation refuses. */
export class InvalidPlaintext extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPlaintext";
  }
}

/** An event of a known type whose payload or roots break that type's schema. */
export class InvalidPayload extends Error {
  constructor(
    readonly type: string,
    message: string
  ) {
    super(`${type}: ${message}`);
    this.name = "InvalidPayload";
  }
}

/** A DID document, or a numalgo-4 long form, that the resolution rules refuse. */
export class InvalidDidDocument extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDidDocument";
  }
}

/** The seed in hand does not derive what the vault records: its anchor, or a DID entity's spelling. */
export class IdentityMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityMismatch";
  }
}

/** A `Keys` whose seed has been dropped; nothing derives any more. */
export class Locked extends Error {
  constructor() {
    super("the keys are locked");
    this.name = "Locked";
  }
}
