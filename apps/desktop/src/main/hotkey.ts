import { globalShortcut, type BrowserWindow } from "electron";
import { loadBrand } from "@omniharness/config-schema";
import { defaults, getPath, SETTINGS_SCHEMA } from "@omniharness/config-schema";

export function registerGlobalHotkey(getWindow: () => BrowserWindow | null): void {
  void loadBrand; // branding reserved for future menu labels
  const accel = String(getPath(defaults(SETTINGS_SCHEMA), "gui.globalHotkey"));
  try {
    globalShortcut.register(accel, () => {
      const win = getWindow();
      if (!win) return;
      if (win.isVisible() && win.isFocused()) win.hide();
      else {
        win.show();
        win.focus();
      }
    });
  } catch {
    // Invalid accelerator or already taken — non-fatal; configurable in settings.
  }
}
