/** Library entry (main.ts is the CLI binary entry). */
export { AppController, type ControllerCallbacks } from "./core/app-controller.js";
export { AppShell } from "./shell/app-shell.js";
export { ChatViewModel } from "./vm/chat-vm.js";
export { SessionsViewModel } from "./vm/sessions-vm.js";
export { DiffViewModel } from "./vm/diff-vm.js";
export { ModelsViewModel } from "./vm/models-vm.js";
export { PaletteViewModel } from "./vm/palette-vm.js";
export { dataDir, readDaemonInfo, daemonUrl } from "./daemon-discovery.js";
