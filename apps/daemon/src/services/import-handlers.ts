import type { DaemonContext } from "../context.js";
import { importPiSession, importHermesSessions } from "@omniharness/hermes-importer";
import type { SessionId } from "@omniharness/shared-types";
import { RpcError } from "../rpc-server.js";
import { ErrorCodes } from "@omniharness/agent-protocol";

type Register = (name: string, handler: (params: never) => unknown) => void;

/** Session import from Pi / Hermes formats. */
export function registerImportHandlers(register: Register, ctx: DaemonContext): void {
  register("session.import", async (params: {
    source: "pi" | "hermes" | "omniharness";
    path: string;
    workspaceId: string;
  }) => {
    if (params.source === "pi") {
      const report = await importPiSession(params.path, ctx.db, {
        workspaceId: params.workspaceId as never,
      });
      if (report.errors.length > 0 && report.imported === 0) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, `import failed: ${report.errors[0]?.message}`);
      }
      const sessions = ctx.db.sessions.list({ limit: 1000 }).items;
      const session = sessions[sessions.length - 1];
      if (!session) throw new RpcError(ErrorCodes.INTERNAL, "import produced no session");
      return { session };
    }
    if (params.source === "hermes") {
      await importHermesSessions({
        stateDbPath: params.path,
        db: ctx.db,
        workspaceId: params.workspaceId as never,
      });
      const sessions = ctx.db.sessions.list({ limit: 1000 }).items;
      const session = sessions[sessions.length - 1];
      if (!session) throw new RpcError(ErrorCodes.INTERNAL, "import produced no session");
      return { session };
    }
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `unsupported import source: ${params.source}`);
  });

  register("session.export", async (params: { sessionId: SessionId; format: "json" | "markdown" }) => {
    const session = ctx.db.sessions.get(params.sessionId);
    if (!session) throw new RpcError(ErrorCodes.NOT_FOUND, "session not found");
    const messages = ctx.db.messages.listBySession(params.sessionId, { limit: 10000 }).items;
    let content: string;
    let ext: string;
    if (params.format === "markdown") {
      ext = "md";
      content = [
        `# ${session.title}`,
        "",
        ...messages.map((m) => {
          const text = m.parts.map((p) => p.text ?? "").join("");
          return `## ${m.role} (${m.createdAt})\n\n${text}`;
        }),
      ].join("\n\n");
    } else {
      ext = "json";
      content = JSON.stringify({ version: 1, session, messages }, null, 2);
    }
    const stored = ctx.artifacts.put(content, ext);
    return {
      artifact: {
        id: stored.sha256.slice(0, 16),
        kind: "export" as const,
        name: `session-${params.sessionId}.${ext}`,
        mimeType: params.format === "markdown" ? "text/markdown" : "application/json",
        sizeBytes: stored.sizeBytes,
        uri: stored.uri,
        createdAt: new Date().toISOString(),
      },
    };
  });
}
