import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentId,
  AgentRunId,
  ApprovalId,
  AutomationId,
  AutomationRunId,
  CheckpointId,
  MemoryId,
  MessageId,
  ModelId,
  PluginId,
  ProviderId,
  SessionId,
  SkillId,
  TaskId,
  ToolCallId,
  WorktreeId,
} from "@omniharness/shared-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OmniDatabase } from "../src/index.js";
import { CAPS, ZERO_USAGE, seedBase, tick } from "./testkit.js";

let db: OmniDatabase;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "omni-crud-"));
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("workspace domain CRUD", () => {
  it("round-trips profile, project, workspace, worktree", () => {
    const { profileId, projectId, workspaceId } = seedBase(db);

    expect(db.profiles.get(profileId)?.name).toBe("Default");
    expect(db.profiles.getDefault()?.id).toBe(profileId);
    expect(db.projects.get(projectId)?.name).toBe("Demo");

    const ws = db.workspaces.get(workspaceId);
    expect(ws?.roots).toEqual(["/repo"]);
    expect(ws?.protectedPaths).toEqual([".env"]);
    expect(db.workspaces.listByProject(projectId)).toHaveLength(1);

    const worktreeId = "wt_1" as WorktreeId;
    db.worktrees.put({
      id: worktreeId,
      workspaceId,
      path: "/repo/.wt/1",
      branch: "agent/task-1",
      ownerAgentId: null,
      createdAt: tick(),
    });
    expect(db.worktrees.get(worktreeId)?.branch).toBe("agent/task-1");
    db.worktrees.setOwner(worktreeId, "agent_1");
    expect(db.worktrees.get(worktreeId)?.ownerAgentId).toBe("agent_1");
    expect(db.worktrees.listByWorkspace(workspaceId)).toHaveLength(1);
    expect(db.worktrees.delete(worktreeId)).toBe(true);
    expect(db.worktrees.get(worktreeId)).toBeUndefined();
  });

  it("enforces foreign keys", () => {
    expect(() =>
      db.workspaces.put({
        id: "ws_bad" as never,
        projectId: "proj_missing" as never,
        name: "bad",
        kind: "folder",
        roots: [],
        protectedPaths: [],
        readOnlyPaths: [],
        createdAt: tick(),
      }),
    ).toThrow();

    const { sessionId } = seedBase(db);
    expect(() =>
      db.messages.add({
        id: "msg_bad" as MessageId,
        sessionId: "sess_missing" as SessionId,
        parentId: null,
        role: "user",
        parts: [],
        createdAt: tick(),
      }),
    ).toThrow();

    // sanity: valid insert still works
    db.messages.add({
      id: "msg_ok" as MessageId,
      sessionId,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
      createdAt: tick(),
    });
    expect(db.messages.get("msg_ok" as MessageId)?.role).toBe("user");
  });
});

describe("sessions", () => {
  it("supports rename, tags, archive and filtered pagination", () => {
    const base = seedBase(db);
    for (let i = 2; i <= 25; i++) {
      db.sessions.create({
        id: `sess_${i}` as SessionId,
        profileId: base.profileId,
        projectId: base.projectId,
        workspaceId: base.workspaceId,
        title: i % 2 === 0 ? `Refactor parser ${i}` : `Fix bug ${i}`,
        tags: i % 3 === 0 ? ["demo", "backend"] : ["demo"],
        status: "active",
        headMessageId: null,
        createdAt: tick(),
        updatedAt: tick(),
        totalUsage: { ...ZERO_USAGE },
      });
    }

    const page1 = db.sessions.list({ limit: 10 });
    expect(page1.items).toHaveLength(10);
    expect(page1.total).toBe(25);
    const page3 = db.sessions.list({ limit: 10, offset: 20 });
    expect(page3.items).toHaveLength(5);
    // no overlap between pages
    const ids = new Set([...page1.items, ...page3.items].map((s) => s.id));
    expect(ids.size).toBe(15);

    expect(db.sessions.list({ search: "refactor" }).total).toBe(12);
    expect(db.sessions.list({ tag: "backend" }).total).toBe(8);

    expect(db.sessions.rename(base.sessionId, "Renamed")).toBe(true);
    expect(db.sessions.get(base.sessionId)?.title).toBe("Renamed");

    expect(db.sessions.setTags(base.sessionId, ["pinned"])).toBe(true);
    expect(db.sessions.list({ tag: "pinned" }).total).toBe(1);

    expect(db.sessions.archive(base.sessionId)).toBe(true);
    expect(db.sessions.get(base.sessionId)?.status).toBe("archived");
    expect(db.sessions.list({ status: "archived" }).total).toBe(1);
    expect(db.sessions.list({ status: "active" }).total).toBe(24);
  });
});

describe("messages tree", () => {
  it("tracks branches and paths to root", () => {
    const { sessionId } = seedBase(db);
    const root = "m_root" as MessageId;
    const a1 = "m_a1" as MessageId;
    const a2 = "m_a2" as MessageId;
    const b1 = "m_b1" as MessageId;

    const mk = (id: MessageId, parentId: MessageId | null, text: string) =>
      db.messages.add({
        id,
        sessionId,
        parentId,
        role: parentId === null ? "user" : "assistant",
        parts: [{ type: "text", text }],
        createdAt: tick(),
      });

    mk(root, null, "root");
    mk(a1, root, "branch A turn 1");
    mk(a2, a1, "branch A turn 2");
    mk(b1, root, "branch B turn 1");

    const branches = db.messages.branches(root);
    expect(branches.map((m) => m.id)).toEqual([a1, b1]);

    const path = db.messages.pathToRoot(a2);
    expect(path.map((m) => m.id)).toEqual([root, a1, a2]);

    expect(db.messages.listBySession(sessionId).total).toBe(4);

    db.sessions.setHead(sessionId, a2);
    expect(db.sessions.get(sessionId)?.headMessageId).toBe(a2);
  });
});

describe("agents, runs, tasks, tool calls, approvals", () => {
  it("round-trips the execution graph", () => {
    const { sessionId, workspaceId } = seedBase(db);
    const agentId = "agent_1" as AgentId;
    db.agents.put({
      id: agentId,
      sessionId,
      kind: "primary",
      parentAgentId: null,
      displayName: "Main",
      status: "running",
      allowedTools: null,
      createdAt: tick(),
    });
    expect(db.agents.get(agentId)?.kind).toBe("primary");
    expect(db.agents.listBySession(sessionId)).toHaveLength(1);

    const runId = "run_1" as AgentRunId;
    db.agentRuns.put({
      id: runId,
      agentId,
      sessionId,
      status: "running",
      startedAt: tick(),
      endedAt: null,
      usage: { ...ZERO_USAGE, inputTokens: 10 },
      lastEventSeq: 0,
    });
    db.agentRuns.finish(runId, "completed", tick());
    const run = db.agentRuns.get(runId);
    expect(run?.status).toBe("completed");
    expect(run?.usage.inputTokens).toBe(10);
    expect(db.agentRuns.listByAgent(agentId)).toHaveLength(1);

    const taskA = "task_a" as TaskId;
    const taskB = "task_b" as TaskId;
    const mkTask = (id: TaskId, deps: TaskId[]) => ({
      id,
      parentTaskId: null,
      objective: `do ${id}`,
      status: "pending" as const,
      dependencies: deps,
      assignedAgentId: null,
      workspaceId,
      worktreeId: null,
      allowedTools: null,
      budget: {},
      checkpoints: [],
      artifacts: [],
      createdAt: tick(),
      updatedAt: tick(),
      consumed: { tokens: 0, costUsd: 0, toolCalls: 0, durationMs: 0 },
    });
    db.tasks.put(mkTask(taskA, []));
    db.tasks.put(mkTask(taskB, [taskA]));
    expect(db.tasks.get(taskB)?.dependencies).toEqual([taskA]);
    expect(db.tasks.listDependents(taskA).map((t) => t.id)).toEqual([taskB]);
    db.tasks.complete(taskA, "done");
    expect(db.tasks.get(taskA)?.result).toBe("done");
    expect(db.tasks.listByWorkspace(workspaceId, "pending").map((t) => t.id)).toEqual([taskB]);

    const toolCallId = "tc_1" as ToolCallId;
    db.toolCalls.put({
      id: toolCallId,
      sessionId,
      agentRunId: runId,
      messageId: null,
      name: "fs.write",
      argumentsJson: '{"path":"/tmp/x"}',
      status: "pending",
      resultJson: null,
      error: null,
      capability: "fs.write",
      startedAt: tick(),
      endedAt: null,
    });
    db.toolCalls.finish(toolCallId, "completed", tick(), '{"ok":true}');
    expect(db.toolCalls.get(toolCallId)?.resultJson).toBe('{"ok":true}');

    const approvalId = "appr_1" as ApprovalId;
    db.approvals.put({
      id: approvalId,
      toolCallId,
      capability: "fs.write",
      risk: "medium",
      summary: "Write /tmp/x",
      detail: { path: "/tmp/x" },
      status: "pending",
      createdAt: tick(),
      resolvedAt: null,
      resolvedBy: null,
      expiresAt: tick(),
    });
    expect(db.approvals.listByStatus("pending")).toHaveLength(1);
    db.approvals.resolve(approvalId, "approved", "user", tick(), "ask_once_per_session");
    const approval = db.approvals.get(approvalId);
    expect(approval?.status).toBe("approved");
    expect(approval?.grantedScope).toBe("ask_once_per_session");
    expect(db.approvals.listByToolCall(toolCallId)).toHaveLength(1);

    db.checkpoints.put({
      id: "ckpt_1" as CheckpointId,
      sessionId,
      kind: "git_commit",
      ref: "abc123",
      label: "before refactor",
      createdAt: tick(),
    });
    expect(db.checkpoints.listBySession(sessionId)).toHaveLength(1);

    db.artifacts.put({
      id: "art_1",
      kind: "diff",
      name: "change.diff",
      mimeType: "text/plain",
      sizeBytes: 42,
      uri: "artifact://art_1",
      createdAt: tick(),
    });
    expect(db.artifacts.listByKind("diff")).toHaveLength(1);
    expect(db.artifacts.get("art_1" as never)?.sizeBytes).toBe(42);
  });
});

describe("providers, models, usage aggregation", () => {
  it("aggregates usage by model, project, agent, automation", () => {
    const providerId = "prov_1" as ProviderId;
    db.providers.put({
      id: providerId,
      kind: "anthropic",
      displayName: "Anthropic",
      enabled: true,
      rateLimitRpm: 60,
      timeoutMs: 30_000,
      maxRetries: 2,
    });
    const modelA = "model_a" as ModelId;
    const modelB = "model_b" as ModelId;
    for (const [id, name] of [
      [modelA, "claude-a"],
      [modelB, "claude-b"],
    ] as const) {
      db.models.put({
        id,
        providerId,
        remoteName: name,
        displayName: name,
        capabilities: CAPS,
        costPerMInputTokens: 3,
        costPerMOutputTokens: 15,
        enabled: true,
      });
    }
    expect(db.providers.list()).toHaveLength(1);
    expect(db.models.listByProvider(providerId, true)).toHaveLength(2);
    expect(db.models.get(modelA)?.capabilities.contextWindow).toBe(CAPS.contextWindow);

    const t0 = tick();
    db.modelUsage.record({
      at: t0,
      modelId: modelA,
      profileId: null,
      projectId: "proj_x" as never,
      sessionId: null,
      agentId: "agent_1" as AgentId,
      automationId: null,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 },
    });
    db.modelUsage.record({
      at: tick(),
      modelId: modelA,
      profileId: null,
      projectId: "proj_x" as never,
      sessionId: null,
      agentId: "agent_2" as AgentId,
      automationId: null,
      usage: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 0, costUsd: 0.002 },
    });
    db.modelUsage.record({
      at: tick(),
      modelId: modelB,
      profileId: null,
      projectId: "proj_y" as never,
      sessionId: null,
      agentId: null,
      automationId: "auto_1" as AutomationId,
      usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });

    const byModel = db.modelUsage.aggregateByModel();
    expect(byModel.find((r) => r.key === modelA)?.usage.inputTokens).toBe(300);
    expect(byModel.find((r) => r.key === modelA)?.samples).toBe(2);
    expect(byModel.find((r) => r.key === modelA)?.usage.costUsd).toBeCloseTo(0.003);

    const byProject = db.modelUsage.aggregateByProject();
    expect(byProject.find((r) => r.key === "proj_x")?.usage.outputTokens).toBe(150);
    expect(byProject.find((r) => r.key === "proj_y")?.usage.inputTokens).toBe(5);

    const byAgent = db.modelUsage.aggregateByAgent();
    expect(byAgent.find((r) => r.key === "agent_1")?.usage.inputTokens).toBe(100);
    expect(byAgent.find((r) => r.key === null)?.usage.inputTokens).toBe(5);

    const byAutomation = db.modelUsage.aggregateByAutomation();
    expect(byAutomation.find((r) => r.key === "auto_1")?.samples).toBe(1);

    // since-filter excludes the earliest sample (recorded at t0)
    const filtered = db.modelUsage.aggregateByProject(
      new Date(Date.parse(t0) + 1000).toISOString(),
    );
    expect(filtered.find((r) => r.key === "proj_x")?.samples).toBe(1);

    const total = db.modelUsage.total();
    expect(total.inputTokens).toBe(305);
  });
});

describe("skills, automations, plugins, governance", () => {
  it("skills with versions and proposals", () => {
    const skillId = "skill_1" as SkillId;
    const base = {
      id: skillId,
      name: "commit",
      description: "write commits",
      body: "v1 body",
      resources: ["templates/msg.md"],
      requiredCapabilities: [],
      scope: "global" as const,
      enabled: true,
      dependencies: [],
      source: "bundled" as const,
      createdAt: tick(),
    };
    db.skills.put({ ...base, version: "1.0.0" });
    db.skills.put({ ...base, version: "1.1.0", body: "v2 body" });

    expect(db.skills.get(skillId)?.version).toBe("1.1.0");
    const versions = db.skills.listVersions(skillId);
    expect(versions).toHaveLength(1); // previous version archived on upgrade
    expect(versions[0]?.version).toBe("1.0.0");
    expect(versions[0]?.body).toBe("v1 body");

    db.skills.putProposal({
      id: "prop_1",
      skill: { ...base, version: "1.2.0", source: "learned" },
      diff: "- v2 body\n+ v3 body",
      basedOnSessionId: "sess_x",
      status: "pending",
      createdAt: tick(),
    });
    expect(db.skills.listProposals("pending")).toHaveLength(1);
    expect(db.skills.getProposal("prop_1")?.diff).toContain("v3 body");
  });

  it("automations with runs", () => {
    const { profileId, workspaceId, sessionId } = seedBase(db);
    const automationId = "auto_1" as AutomationId;
    db.automations.put({
      id: automationId,
      name: "nightly",
      description: "nightly cleanup",
      enabled: true,
      trigger: { kind: "cron", expression: "0 3 * * *" },
      profileId,
      workspaceId,
      prompt: "clean up",
      skills: [],
      allowedTools: ["fs.read"],
      networkAllowed: false,
      budget: {},
      timeoutMs: 60_000,
      output: { kind: "notification" },
      onFailure: "notify",
      maxRetries: 1,
      createdAt: tick(),
      updatedAt: tick(),
      lastRunAt: null,
      nextRunAt: "2000-01-01T00:00:00.000Z",
    });
    expect(db.automations.listDue(tick()).map((a) => a.id)).toEqual([automationId]);

    const runId = "arun_1" as AutomationRunId;
    db.automations.putRun({
      id: runId,
      automationId,
      status: "completed",
      sessionId,
      startedAt: tick(),
      endedAt: tick(),
      resultSummary: "ok",
      attempt: 1,
    });
    db.automations.markRun(automationId, tick(), null);
    const automation = db.automations.get(automationId);
    expect(automation?.lastRunAt).not.toBeNull();
    expect(automation?.nextRunAt).toBeNull();
    expect(db.automations.listRuns(automationId, "completed")).toHaveLength(1);
    expect(db.automations.getRun(runId)?.resultSummary).toBe("ok");
  });

  it("plugins, permission rules, audit events, channels, nodes", () => {
    const pluginId = "plugin_1" as PluginId;
    const permissions = {
      capabilities: ["fs.read" as const],
      tools: ["my_tool"],
      uiExtensions: [],
      registersProviders: false,
      secrets: [],
      networkDomains: [],
    };
    db.plugins.put({
      manifest: {
        id: pluginId,
        name: "my-plugin",
        version: "0.1.0",
        description: "demo",
        author: "acme",
        license: "MIT",
        entry: "index.js",
        permissions,
        platforms: ["macos"],
      },
      trust: "unsigned",
      enabled: true,
      installedAt: tick(),
      grantedPermissions: permissions,
    });
    expect(db.plugins.get(pluginId)?.trust).toBe("unsigned");
    expect(db.plugins.list(true)).toHaveLength(1);
    db.plugins.setEnabled(pluginId, false);
    expect(db.plugins.list(true)).toHaveLength(0);

    const ruleId = db.permissionRules.add(
      { kind: "profile", profileId: "prof_1" },
      { capability: "network", decision: "deny" },
    );
    const rule = db.permissionRules.get(ruleId);
    expect(rule?.scope).toEqual({ kind: "profile", profileId: "prof_1" });
    expect(rule?.rule.decision).toBe("deny");
    expect(db.permissionRules.list("network")).toHaveLength(1);
    expect(db.permissionRules.delete(ruleId)).toBe(true);

    const auditId = db.auditEvents.record("user", "approval.granted", { tool: "fs.write" });
    expect(db.auditEvents.get(auditId)?.actor).toBe("user");
    expect(db.auditEvents.list({ action: "approval.granted" })).toHaveLength(1);

    db.channels.put({
      id: "chan_1" as never,
      kind: "slack",
      displayName: "Slack #agents",
      config: { webhook: "https://example.invalid" },
      enabled: true,
      createdAt: tick(),
    });
    expect(db.channels.list()).toHaveLength(1);

    db.nodes.put({
      id: "node_1" as never,
      name: "macbook",
      address: "192.168.1.10:7777",
      status: "offline",
      capabilities: ["shell.exec"],
      lastSeenAt: null,
      createdAt: tick(),
    });
    db.nodes.heartbeat("node_1" as never);
    expect(db.nodes.get("node_1" as never)?.status).toBe("online");
  });
});
