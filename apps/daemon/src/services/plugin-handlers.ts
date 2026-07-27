import type { DaemonContext } from "../context.js";

type Register = (name: string, handler: (params: never) => unknown) => void;

/** Plugin lifecycle commands backed by the extension-host PluginRegistry. */
export function registerPluginHandlers(register: Register, ctx: DaemonContext): void {
  const { plugins } = ctx;

  register("plugin.list", async () => ({ plugins: await plugins.registry.list() }));

  register("plugin.install", async (params: { path: string }) => {
    const plugin = await plugins.registry.install(params.path);
    return { plugin };
  });

  register("plugin.setEnabled", async (params: { pluginId: string; enabled: boolean }) => {
    if (params.enabled) await plugins.registry.enable(params.pluginId as never);
    else await plugins.registry.disable(params.pluginId as never);
    return { ok: true as const };
  });

  register("plugin.uninstall", async (params: { pluginId: string }) => {
    await plugins.registry.uninstall(params.pluginId as never);
    return { ok: true as const };
  });
}
