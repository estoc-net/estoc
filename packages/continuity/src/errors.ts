/** A fact that does not satisfy the profile's schema: wrong shape, a self-pair, a successor equal to an endpoint. */
export class InvalidFact extends Error {
  override readonly name = "InvalidFact";
}

/** Two snapshots that the merge contract refuses to combine: different namespaces, or a profile this package does not implement. */
export class IncompatibleSnapshot extends Error {
  override readonly name = "IncompatibleSnapshot";
}
