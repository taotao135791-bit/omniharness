#!/usr/bin/env node
import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { OmniClient } from "@omniharness/client-sdk";
import { loadBrand } from "@omniharness/config-schema";
import { AppController } from "./core/app-controller.js";
import { daemonUrl, readDaemonInfo } from "./daemon-discovery.js";
import { AppShell } from "./shell/app-shell.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const brand = loadBrand();
  const displayName = brand.product.displayName;

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error(
      `${displayName} TUI requires an interactive terminal (stdout/stdin must be a TTY).`,
    );
    process.exit(1);
  }

  const info = readDaemonInfo();
  if (!info) {
    console.error(
      [
        `No ${displayName} daemon is running (no runtime file found).`,
        `Start it first with:  omniharnessd`,
        `(looked in ${process.env.OMNIHARNESS_DATA_DIR ?? "~/.omniharness"})`,
      ].join("\n"),
    );
    process.exit(1);
  }

  const client = new OmniClient({
    url: daemonUrl(info),
    authToken: info.authToken,
    client: { kind: "tui", name: "omni-tui", version: VERSION },
  });

  try {
    await client.connect();
  } catch (err) {
    console.error(
      `Could not connect to the ${displayName} daemon at ${daemonUrl(info)}: ${
        err instanceof Error ? err.message : String(err)
      }\nIf it is not running, start it with:  omniharnessd`,
    );
    process.exit(1);
  }

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const controller = new AppController(client, {
    onChange: () => tui.requestRender(),
    onError: (message) => {
      controller.chat.addSystemMessage(`error: ${message}`);
      controller.statusFlash = `error: ${message}`;
    },
  });
  controller.attach();

  const shell = new AppShell(tui, controller, displayName);
  tui.addChild(shell);
  tui.setFocus(shell);

  terminal.setTitle(`${displayName} TUI`);

  const shutdown = (): void => {
    tui.stop();
    void client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  tui.start();

  try {
    await controller.init();
  } catch (err) {
    controller.chat.addSystemMessage(
      `startup error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  tui.requestRender();
}

void main();
