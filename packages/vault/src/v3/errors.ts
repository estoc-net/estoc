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
