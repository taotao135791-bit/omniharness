import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Content-addressed artifact store. Large tool outputs, diffs, screenshots and
 * exports are stored here; contexts and messages hold only the reference.
 */
export interface StoredArtifact {
  /** artifact:// URI. */
  uri: string;
  sha256: string;
  sizeBytes: number;
  path: string;
}

export class ArtifactStore {
  constructor(private readonly rootDir: string) {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  /** Store a string payload; returns its content-addressed reference. */
  put(content: string | Buffer, extension = "txt"): StoredArtifact {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const sub = path.join(this.rootDir, sha256.slice(0, 2));
    fs.mkdirSync(sub, { recursive: true });
    const filePath = path.join(sub, `${sha256}.${extension}`);
    if (!fs.existsSync(filePath)) {
      const tmp = `${filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, filePath);
    }
    return { uri: `artifact://${sha256}`, sha256, sizeBytes: buf.length, path: filePath };
  }

  /** Resolve an artifact:// URI back to its content, or null if missing. */
  get(uri: string): Buffer | null {
    const sha = uri.replace(/^artifact:\/\//, "").replace(/\..*$/, "");
    if (!/^[a-f0-9]{64}$/.test(sha)) return null;
    const sub = path.join(this.rootDir, sha.slice(0, 2));
    if (!fs.existsSync(sub)) return null;
    const match = fs.readdirSync(sub).find((f) => f.startsWith(sha));
    if (!match) return null;
    return fs.readFileSync(path.join(sub, match));
  }

  /** Truncate text for in-context use; overflow goes to the store. */
  truncateWithArtifact(
    text: string,
    maxChars: number,
  ): { text: string; truncated: boolean; artifact?: StoredArtifact } {
    if (text.length <= maxChars) return { text, truncated: false };
    const artifact = this.put(text, "log");
    const head = text.slice(0, maxChars);
    return {
      text: `${head}\n… [truncated ${text.length - maxChars} chars → ${artifact.uri}]`,
      truncated: true,
      artifact,
    };
  }

  totalSizeBytes(): number {
    let total = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else total += fs.statSync(p).size;
      }
    };
    if (fs.existsSync(this.rootDir)) walk(this.rootDir);
    return total;
  }
}
