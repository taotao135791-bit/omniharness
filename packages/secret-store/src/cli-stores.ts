import { execFile } from "node:child_process";
import { SecretStoreError, type SecretRef, type SecretStore } from "./store.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a CLI without a shell; resolves even on non-zero exit, rejects only when the binary cannot be spawned. */
export function runCommand(cmd: string, args: string[], input?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
    child.on("error", reject);
    if (input !== undefined && child.stdin !== null) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

const KEYCHAIN_SERVICE = "omniharness";
/** macOS `security` exit status for "item not found" (errSecItemNotFound). */
const MACOS_NOT_FOUND = 44;

export class MacosKeychainStore implements SecretStore {
  async get(ref: SecretRef): Promise<string | null> {
    const res = await runCommand("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", ref, "-w"]);
    if (res.code === MACOS_NOT_FOUND) return null;
    if (res.code !== 0) {
      throw new SecretStoreError(`security find-generic-password failed: ${res.stderr.trim()}`, { ref });
    }
    // `security -w` appends a trailing newline to the printed password.
    return res.stdout.replace(/\r?\n$/, "");
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    // -U updates in place when the item already exists.
    const res = await runCommand("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", ref, "-w", value]);
    if (res.code !== 0) {
      throw new SecretStoreError(`security add-generic-password failed: ${res.stderr.trim()}`, { ref });
    }
  }

  async delete(ref: SecretRef): Promise<void> {
    const res = await runCommand("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", ref]);
    if (res.code !== 0 && res.code !== MACOS_NOT_FOUND) {
      throw new SecretStoreError(`security delete-generic-password failed: ${res.stderr.trim()}`, { ref });
    }
  }

  async list(): Promise<SecretRef[]> {
    const res = await runCommand("security", ["dump-keychain"]);
    if (res.code !== 0) {
      throw new SecretStoreError(`security dump-keychain failed: ${res.stderr.trim()}`);
    }
    const refs = new Set<string>();
    // Each keychain entry block starts with a `keychain: ...` line; an
    // omniharness item has `"svce"<blob>="omniharness"` and its ref in
    // `"acct"<blob>="..."`.
    for (const block of res.stdout.split(/\n(?=keychain: )/)) {
      if (!block.includes(`"svce"<blob>="${KEYCHAIN_SERVICE}"`)) continue;
      const match = /"acct"<blob>="([^"]*)"/.exec(block);
      if (match?.[1] !== undefined) refs.add(match[1]);
    }
    return [...refs].sort();
  }
}

const WINDOWS_TARGET_PREFIX = "omniharness:";
const WINDOWS_USER = "omniharness";

/**
 * Windows Credential Manager backend. Writes/lists/deletes go through
 * `cmdkey`; since cmdkey cannot read a secret back, reads use the built-in
 * PasswordVault WinRT API via PowerShell.
 */
export class WindowsCredentialStore implements SecretStore {
  private target(ref: SecretRef): string {
    return `${WINDOWS_TARGET_PREFIX}${ref}`;
  }

  async get(ref: SecretRef): Promise<string | null> {
    const target = this.target(ref).replace(/'/g, "''");
    const script =
      "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];" +
      "$vault = New-Object Windows.Security.Credentials.PasswordVault;" +
      `try { ($vault.Retrieve('${target}','${WINDOWS_USER}')).Password } catch { exit 44 }`;
    const res = await runCommand("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (res.code === 44) return null;
    if (res.code !== 0) {
      throw new SecretStoreError(`PasswordVault retrieve failed: ${res.stderr.trim()}`, { ref });
    }
    return res.stdout.replace(/\r?\n$/, "");
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    const res = await runCommand("cmdkey", [`/add:${this.target(ref)}`, `/user:${WINDOWS_USER}`, `/pass:${value}`]);
    if (res.code !== 0) {
      throw new SecretStoreError(`cmdkey /add failed: ${res.stderr.trim() || res.stdout.trim()}`, { ref });
    }
  }

  async delete(ref: SecretRef): Promise<void> {
    const res = await runCommand("cmdkey", [`/delete:${this.target(ref)}`]);
    if (res.code !== 0 && !res.stdout.includes("not found") && !res.stderr.includes("not found")) {
      throw new SecretStoreError(`cmdkey /delete failed: ${res.stderr.trim() || res.stdout.trim()}`, { ref });
    }
  }

  async list(): Promise<SecretRef[]> {
    const res = await runCommand("cmdkey", ["/list"]);
    if (res.code !== 0) {
      throw new SecretStoreError(`cmdkey /list failed: ${res.stderr.trim()}`);
    }
    const refs = new Set<string>();
    for (const line of res.stdout.split(/\r?\n/)) {
      const match = /Target:\s*(?:LegacyGeneric:target=)?(.+)$/i.exec(line.trim());
      const target = match?.[1]?.trim();
      if (target !== undefined && target.startsWith(WINDOWS_TARGET_PREFIX)) {
        refs.add(target.slice(WINDOWS_TARGET_PREFIX.length));
      }
    }
    return [...refs].sort();
  }
}

const SECRET_TOOL_SERVICE = "omniharness";

export class LinuxSecretToolStore implements SecretStore {
  async get(ref: SecretRef): Promise<string | null> {
    const res = await runCommand("secret-tool", ["lookup", "service", SECRET_TOOL_SERVICE, "ref", ref]);
    if (res.code !== 0) return null; // not found or collection locked
    return res.stdout.replace(/\r?\n$/, "");
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    const res = await runCommand(
      "secret-tool",
      ["store", `--label=omniharness ${ref}`, "service", SECRET_TOOL_SERVICE, "ref", ref],
      value,
    );
    if (res.code !== 0) {
      throw new SecretStoreError(`secret-tool store failed: ${res.stderr.trim()}`, { ref });
    }
  }

  async delete(ref: SecretRef): Promise<void> {
    const res = await runCommand("secret-tool", ["clear", "service", SECRET_TOOL_SERVICE, "ref", ref]);
    if (res.code !== 0) {
      throw new SecretStoreError(`secret-tool clear failed: ${res.stderr.trim()}`, { ref });
    }
  }

  async list(): Promise<SecretRef[]> {
    const res = await runCommand("secret-tool", ["search", "--all", "service", SECRET_TOOL_SERVICE]);
    if (res.code !== 0) return []; // no matches or collection locked
    const refs = new Set<string>();
    for (const line of res.stdout.split(/\r?\n/)) {
      const match = /^attribute\.ref = (.+)$/.exec(line.trim());
      if (match?.[1] !== undefined) refs.add(match[1]);
    }
    return [...refs].sort();
  }
}
