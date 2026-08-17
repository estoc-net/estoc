export type { Signer, DidKeySigner, DerivedKeyEntry, SeedKeystoreDocument } from "./types.js";
export { didKeyFromPublicKey, publicKeyFromDidKey } from "./did-key.js";
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
  listKeys,
  serializeKeystore,
  parseSeedKeystore,
  type CreateSeedKeystoreOptions,
  type AddDerivedKeyOptions,
} from "./seed-keystore.js";
