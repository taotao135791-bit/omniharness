import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

declare global {
  interface Window {
    omni: {
      call: (name: string, params: unknown) => Promise<unknown>;
      onEvent: (handler: (event: unknown) => void) => () => void;
      onState: (handler: (state: string) => void) => () => void;
      window: { minimize: () => Promise<void>; toggleMaximize: () => Promise<void> };
    };
  }
}

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
