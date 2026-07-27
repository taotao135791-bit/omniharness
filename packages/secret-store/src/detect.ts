import {
  LinuxSecretToolStore,
  MacosKeychainStore,
  runCommand,
  WindowsCredentialStore,
} from "./cli-stores.js";
import { EncryptedFileStore } from "./encrypted-file-store.js";
import type { SecretStore, SecretStoreBackendKind } from "./store.js";

export interface DetectedSecretStore {
  store: SecretStore;
  backend: SecretStoreBackendKind;
}

export interface CreateSecretStoreOptions {
  /** Override platform detection (mainly for tests). */
  platform?: NodeJS.Platform;
  /** Override binary probing (mainly for tests); return true when the binary exists. */
  probe?: (binary: string) => Promise<boolean>;
}

async function defaultProbe(binary: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const res = await runCommand(platform === "win32" ? "where" : "which", [binary]);
    return res.code === 0;
  } catch {
    return false;
  }
}

/**
 * Picks the best available OS-native secret backend and falls back to the
 * encrypted file store when no native backend is present. The active backend
 * is reported so callers can surface it in diagnostics.
 */
export async function createSecretStore(
  dataDir: string,
  options?: CreateSecretStoreOptions,
): Promise<DetectedSecretStore> {
  const platform = options?.platform ?? process.platform;
  const probe = options?.probe ?? ((binary: string) => defaultProbe(binary, platform));

  if (platform === "darwin" && (await probe("security"))) {
    return { store: new MacosKeychainStore(), backend: "macos-keychain" };
  }
  if (platform === "win32" && (await probe("cmdkey"))) {
    return { store: new WindowsCredentialStore(), backend: "windows-credential" };
  }
  if ((platform === "linux" || platform === "freebsd") && (await probe("secret-tool"))) {
    return { store: new LinuxSecretToolStore(), backend: "linux-secret-tool" };
  }
  return { store: new EncryptedFileStore(dataDir), backend: "encrypted-file" };
}
