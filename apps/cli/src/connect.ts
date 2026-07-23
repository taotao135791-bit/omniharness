import { OmniClient } from "@omniharness/client-sdk";
import { loadBrand } from "@omniharness/config-schema";
import { daemonUrl, readDaemonInfo } from "./paths.js";

export async function connectToDaemon(): Promise<OmniClient> {
  const info = readDaemonInfo();
  if (!info) {
    const brand = loadBrand();
    throw new Error(
      `No running ${brand.product.displayName} daemon found.\n` +
        `Start one with: omniharnessd  (or: pnpm dev:daemon from the repo)`,
    );
  }
  const client = new OmniClient({
    url: daemonUrl(info),
    authToken: info.authToken,
    client: { kind: "cli", name: "omni", version: "0.1.0" },
    autoReconnect: false,
  });
  await client.connect();
  return client;
}
