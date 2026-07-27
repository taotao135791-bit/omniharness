import type {
  CommandMap,
  CommandName,
  CommandParams,
  CommandResult,
} from "@omniharness/agent-protocol";
import type { DomainEvent } from "@omniharness/agent-protocol";

/**
 * The preload bridge exposed on window.omni, typed against the agent-protocol
 * CommandMap. Tests substitute a fake implementation.
 */
export interface OmniBridge {
  call<N extends CommandName>(name: N, params: CommandParams<N>): Promise<CommandResult<N>>;
  onEvent(handler: (event: DomainEvent) => void): () => void;
  onState(handler: (state: string) => void): () => void;
}

export type DaemonState = "starting" | "connected" | "disconnected" | "reconnecting";

export function normalizeDaemonState(raw: string): DaemonState {
  if (raw === "connected") return "connected";
  if (raw === "reconnecting") return "reconnecting";
  if (raw === "starting") return "starting";
  return "disconnected";
}

/** Create the real bridge from the preload-injected window.omni global. */
export function createBridge(): OmniBridge {
  const omni = window.omni;
  return {
    call: <N extends CommandName>(name: N, params: CommandParams<N>) =>
      omni.call(name, params) as Promise<CommandResult<N>>,
    onEvent: (handler) => omni.onEvent((e) => handler(e as DomainEvent)),
    onState: (handler) => omni.onState(handler),
  };
}

export type { CommandMap, CommandName, CommandParams, CommandResult, DomainEvent };
