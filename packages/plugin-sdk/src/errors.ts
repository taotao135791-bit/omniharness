import type { SchemaIssue } from "@omniharness/config-schema";

/** Thrown when a plugin attempts something its manifest does not permit. */
export class PermissionDeniedError extends Error {
  readonly pluginId: string;
  /** What was denied, e.g. `capability:shell.exec`, `tool:foo.bar`, `provider`, `ui:panel`. */
  readonly permission: string;

  constructor(pluginId: string, permission: string) {
    super(`Plugin "${pluginId}" was denied permission: ${permission}`);
    this.name = "PermissionDeniedError";
    this.pluginId = pluginId;
    this.permission = permission;
  }
}

/** manifest.json is missing, unreadable, or not valid JSON. */
export class ManifestLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestLoadError";
  }
}

/** manifest.json parsed but failed schema validation. */
export class ManifestValidationError extends Error {
  readonly issues: SchemaIssue[];

  constructor(dir: string, issues: SchemaIssue[]) {
    const detail = issues.map((i) => `  ${i.path || "(root)"}: ${i.message}`).join("\n");
    super(`Invalid plugin manifest in "${dir}":\n${detail}`);
    this.name = "ManifestValidationError";
    this.issues = issues;
  }
}

/** The entry file's computed hash does not match the declared integrityHash. */
export class IntegrityMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(pluginId: string, expected: string, actual: string) {
    super(
      `Integrity check failed for plugin "${pluginId}": declared ${expected}, computed ${actual}`,
    );
    this.name = "IntegrityMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}
