import { openDatabase, type OmniDatabase } from "@omniharness/session-store";
import { createSecretStore, type SecretStore } from "@omniharness/secret-store";
import { MemoryEngine } from "@omniharness/memory-engine";
import { SkillEngine } from "@omniharness/skill-engine";
import { AutomationEngine, Scheduler } from "@omniharness/automation-engine";
import { PolicyEngine } from "@omniharness/policy-engine";
import { ApprovalEngine, InMemoryApprovalStore } from "@omniharness/approval-engine";
import { ArtifactStore } from "@omniharness/artifact-store";
import { Logger, Tracer, createNdjsonSink, createStderrSink } from "@omniharness/observability";
import { EventBus } from "./event-bus.js";
import { RpcServer } from "./rpc-server.js";
import type { DaemonPaths } from "./paths.js";

/** Everything a daemon instance owns. */
export interface DaemonContext {
  paths: DaemonPaths;
  db: OmniDatabase;
  bus: EventBus;
  rpc: RpcServer;
  log: Logger;
  tracer: Tracer;
  secrets: SecretStore;
  policy: PolicyEngine;
  approvals: ApprovalEngine;
  memory: MemoryEngine;
  skills: SkillEngine;
  automations: {
    engine: AutomationEngine;
    scheduler: Scheduler | null;
    setScheduler: (s: Scheduler) => void;
  };
  artifacts: ArtifactStore;
  version: string;
  startedAt: number;
}

export async function createDaemonContext(opts: {
  paths: DaemonPaths;
  authToken: string;
  host: string;
  port: number;
  version: string;
}): Promise<DaemonContext> {
  const log = new Logger("daemon", "info", (record) => {
    createNdjsonSink(opts.paths.logFile)(record);
    if (process.env.OMNIHARNESS_LOG_STDERR === "1") createStderrSink()(record);
  });
  const db = openDatabase(opts.paths.dbFile);
  const bus = new EventBus(db);
  const detectedSecrets = await createSecretStore(opts.paths.dataDir);
  const secrets = detectedSecrets.store;
  const tracer = new Tracer();
  const policy = new PolicyEngine();
  const approvals = new ApprovalEngine({ store: new InMemoryApprovalStore() });
  const memory = new MemoryEngine(db);
  const artifacts = new ArtifactStore(opts.paths.artifactsDir);
  const { SqliteSkillStore } = await import("./services/skill-store-adapter.js");
  const skills = new SkillEngine(new SqliteSkillStore(db));
  const automationEngine = new AutomationEngine({ repo: db.automations });
  const automationsHolder: { scheduler: Scheduler | null } = { scheduler: null };

  const rpc = new RpcServer({
    host: opts.host,
    port: opts.port,
    authToken: opts.authToken,
    daemonVersion: opts.version,
    bus,
    log,
  });

  return {
    paths: opts.paths,
    db,
    bus,
    rpc,
    log,
    tracer,
    secrets,
    policy,
    approvals,
    memory,
    skills,
    automations: {
      engine: automationEngine,
      get scheduler() {
        return automationsHolder.scheduler;
      },
      setScheduler: (s: Scheduler) => {
        automationsHolder.scheduler = s;
      },
    },
    artifacts,
    version: opts.version,
    startedAt: Date.now(),
  };
}
