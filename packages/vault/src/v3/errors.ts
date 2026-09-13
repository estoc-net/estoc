/** What the version-3 vault model throws. Each names the rule it stands for. */

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
