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
