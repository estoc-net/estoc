export type {
  Signer,
  DidKeySigner,
  KeyEntry,
  KeystoreDocument,
  KeyInfo,
  DerivedKeyEntry,
  SeedKeystoreDocument,
} from "./types.js";
export { didKeyFromPublicKey, publicKeyFromDidKey } from "./did-key.js";
export { didKeySignerFromPrivateKey, generatePrivateKey } from "./signer.js";
export {
  emptyKeystore,
  listKeys,
  createKey,
  openKey,
  removeKey,
  serializeKeystore,
  parseKeystore,
  type CreateKeyOptions,
} from "./keystore.js";
export {
  generateSeed,
  importSeed,
  deriveIdentity,
  isValidKeyName,
  KEY_NAME_PATTERN,
  SEED_LENGTH,
  type SeedKey,
  type DerivedIdentity,
} from "./seed.js";
export {
  createSeedKeystore,
  unlockSeedKeystore,
  changeSeedPassphrase,
  addDerivedKey,
  openDerivedKey,
  removeDerivedKey,
  parseSeedKeystore,
  type CreateSeedKeystoreOptions,
  type AddDerivedKeyOptions,
} from "./seed-keystore.js";
