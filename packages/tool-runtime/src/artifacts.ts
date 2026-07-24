import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact } from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";

export interface ArtifactInput {
  name: string;
  content: string;
  mimeType: string;
}

/** Stores spilled tool output and returns a shared-types Artifact ref. */
export interface ArtifactStore {
  put(input: ArtifactInput): Promise<Artifact>;
}

/** Default store: writes artifacts as files under a local directory. */
export class LocalArtifactStore implements ArtifactStore {
  readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(tmpdir(), "omniharness-artifacts");
  }

  async put(input: ArtifactInput): Promise<Artifact> {
    await mkdir(this.dir, { recursive: true });
    const id = `art_${randomUUID()}`;
    const safeName = input.name.replace(/[^\w.-]+/g, "_");
    const filePath = join(this.dir, `${id}-${safeName}`);
    await writeFile(filePath, input.content, "utf8");
    return {
      id,
      kind: "log",
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: Buffer.byteLength(input.content, "utf8"),
      uri: `file://${filePath}`,
      createdAt: nowIso(),
    };
  }
}
