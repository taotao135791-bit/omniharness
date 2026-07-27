import { app, Menu, Tray, nativeImage, type BrowserWindow } from "electron";
import type { BrandConfig } from "@omniharness/config-schema";

export function createTray(brand: BrandConfig, getWindow: () => BrowserWindow | null): Tray {
  // 16x16 template image; real assets land in brand/assets — placeholder empty image
  // keeps the tray functional until icons are generated.
  const icon = nativeImage.createEmpty();
  const tray = new Tray(icon);
  tray.setToolTip(brand.product.displayName);
  const menu = Menu.buildFromTemplate([
    {
      label: `Open ${brand.product.displayName}`,
      click: () => {
        const win = getWindow();
        if (win) {
          win.show();
          win.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => {
    const win = getWindow();
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.show();
  });
  return tray;
}
