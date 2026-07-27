import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { SecretStoreError, type SecretRef, type SecretStore } from "./store.js";

interface EncryptedEntry {
  /** Base64-encoded 12-byte IV, unique per write. */
  iv: string;
  /** Base64-encoded 16-byte GCM auth tag. */
  tag: string;
  /** Base64-encoded ciphertext. */
  data: string;
}

interface VaultFile {
  version: 1;
  /** Base64-encoded scrypt salt, generated once per vault. */
  salt: string;
  entries: Record<string, EncryptedEntry>;
}

const KEY_LEN = 32;
const IV_LEN = 12;

/**
 * Fallback store that keeps secrets in a single AES-256-GCM encrypted JSON
 * file. The key is derived with scrypt from machine-specific material
 * (hostname + username + dataDir) and a per-vault random salt, so the file is
 * useless when copied to another machine, user, or data directory. Every
 * entry has its own IV and GCM auth tag, so any tampering with the file
 * fails decryption loudly instead of returning garbage.
 */
export class EncryptedFileStore implements SecretStore {
  readonly filePath: string;
  private vault: VaultFile | null = null;
  private key: Buffer | null = null;

  constructor(
    readonly dataDir: string,
    fileName = "secrets.vault.json",
  ) {
    this.filePath = join(dataDir, fileName);
  }

  private async load(): Promise<VaultFile> {
    if (this.vault !== null) return this.vault;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.vault = { version: 1, salt: randomBytes(16).toString("base64"), entries: {} };
        return this.vault;
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SecretStoreError(`Secret vault at ${this.filePath} is not valid JSON`, {
        cause: err,
      });
    }
    const file = parsed as VaultFile;
    if (file.version !== 1 || typeof file.salt !== "string" || typeof file.entries !== "object") {
      throw new SecretStoreError(`Secret vault at ${this.filePath} has an unsupported format`);
    }
    this.vault = file;
    return file;
  }

  private deriveKey(vault: VaultFile): Buffer {
    if (this.key !== null) return this.key;
    const material = `${hostname()}${userInfo().username}${this.dataDir}`;
    this.key = scryptSync(material, Buffer.from(vault.salt, "base64"), KEY_LEN);
    return this.key;
  }

  private async save(vault: VaultFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, JSON.stringify(vault, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, this.filePath);
  }

  async get(ref: SecretRef): Promise<string | null> {
    const vault = await this.load();
    const entry = vault.entries[ref];
    if (entry === undefined) return null;
    const key = this.deriveKey(vault);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
      decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(entry.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch (err) {
      throw new SecretStoreError(
        `Failed to decrypt secret "${ref}" — the vault was tampered with or belongs to a different machine/user`,
        { ref, cause: err },
      );
    }
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    const vault = await this.load();
    const key = this.deriveKey(vault);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    vault.entries[ref] = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    await this.save(vault);
  }

  async delete(ref: SecretRef): Promise<void> {
    const vault = await this.load();
    if (vault.entries[ref] === undefined) return;
    delete vault.entries[ref];
    await this.save(vault);
  }

  async list(): Promise<SecretRef[]> {
    const vault = await this.load();
    return Object.keys(vault.entries).sort();
  }
}
