/**
 * Electron `safeStorage` (OS keychain) backed `SecretCrypto` for the desktop app.
 * This preserves the exact at-rest format the desktop used before secrets crypto
 * was made injectable, so existing vaults keep decrypting unchanged.
 */

import { safeStorage } from "electron";
import type { SecretCrypto } from "./secrets";

export const electronSecretCrypto: SecretCrypto = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (data) => safeStorage.decryptString(data),
};
