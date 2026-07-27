import { nowIso } from "@omniharness/shared-types";
import { CdpClient } from "./cdp/client.js";
import { launchBrowser, type LaunchedBrowser, type LaunchOptions } from "./cdp/launch.js";
import { sanitizeObservation } from "./sanitize.js";
import type {
  BrowserMode,
  BrowserObservation,
  BrowserPage,
  ConsoleRecord,
  NetworkRecord,
  PolicyGate,
} from "./types.js";

export interface BrowserRuntimeOptions {
  /** Declared observation mode; every observation records it. */
  mode: BrowserMode;
  policyGate?: PolicyGate;
  /** Required for uploadFiles; without it uploads are refused. */
  onUploadApproval?: (paths: string[]) => Promise<boolean>;
  /** Bound on the console / network event rings. */
  eventBufferLimit?: number;
}

export class PolicyDeniedError extends Error {
  readonly domain: string;

  constructor(domain: string) {
    super(`navigation to domain "${domain}" denied by policy gate`);
    this.name = "PolicyDeniedError";
    this.domain = domain;
  }
}

export class UploadDeniedError extends Error {
  constructor(paths: string[]) {
    super(`file upload denied: ${paths.join(", ")}`);
    this.name = "UploadDeniedError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * Isolated browser automation over raw CDP. One runtime = one browser
 * process with its own user-data-dir, so cookies/storage are isolated per
 * runtime instance by construction.
 */
export class BrowserRuntime {
  private readonly client: CdpClient;
  private readonly browser: LaunchedBrowser | null;
  private readonly options: BrowserRuntimeOptions;
  private readonly consoleRing: ConsoleRecord[] = [];
  private readonly networkRing: NetworkRecord[] = [];
  private readonly bufferLimit: number;
  private readonly detachEvents: Array<() => void> = [];

  private constructor(
    client: CdpClient,
    options: BrowserRuntimeOptions,
    browser: LaunchedBrowser | null,
  ) {
    this.client = client;
    this.options = options;
    this.browser = browser;
    this.bufferLimit = options.eventBufferLimit ?? 500;
    this.wireEventCollection();
  }

  /** Launches a real Chromium-based browser with an isolated profile. */
  static async launch(
    options: BrowserRuntimeOptions & { launch?: LaunchOptions },
  ): Promise<BrowserRuntime> {
    const browser = await launchBrowser(options.launch ?? {});
    try {
      const client = await CdpClient.connect(browser.wsUrl);
      return new BrowserRuntime(client, options, browser);
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  /** Attaches to an existing CDP endpoint (tests, externally-run Chrome). */
  static async connect(
    browserWsUrl: string,
    options: BrowserRuntimeOptions,
  ): Promise<BrowserRuntime> {
    const client = await CdpClient.connect(browserWsUrl);
    return new BrowserRuntime(client, options, null);
  }

  /** Builds a runtime around an existing CDP client (test seam). */
  static fromClient(client: CdpClient, options: BrowserRuntimeOptions): BrowserRuntime {
    return new BrowserRuntime(client, options, null);
  }

  get mode(): BrowserMode {
    return this.options.mode;
  }

  /** The isolated profile directory, when this runtime launched the browser. */
  get profileDir(): string | null {
    return this.browser?.profileDir ?? null;
  }

  /** Audit views over the bounded event rings. */
  consoleLog(): readonly ConsoleRecord[] {
    return this.consoleRing;
  }

  networkLog(): readonly NetworkRecord[] {
    return this.networkRing;
  }

  /** Opens a new page/target and attaches a flat CDP session to it. */
  async openPage(url = "about:blank"): Promise<BrowserPage> {
    const created = asRecord(await this.client.send("Target.createTarget", { url }));
    const targetId = asString(created.targetId);
    if (targetId === null) {
      throw new Error("Target.createTarget returned no targetId");
    }
    const attached = asRecord(
      await this.client.send("Target.attachToTarget", { targetId, flatten: true }),
    );
    const sessionId = asString(attached.sessionId);
    if (sessionId === null) {
      throw new Error("Target.attachToTarget returned no sessionId");
    }
    await this.client.send("Page.enable", {}, sessionId);
    await this.client.send("Runtime.enable", {}, sessionId);
    await this.client.send("Network.enable", {}, sessionId);
    return { targetId, sessionId, url };
  }

  async closePage(page: BrowserPage): Promise<void> {
    await this.client.send("Target.closeTarget", { targetId: page.targetId });
  }

  /** Navigates, consulting the policy gate for the target domain first. */
  async navigate(page: BrowserPage, url: string): Promise<void> {
    const domain = new URL(url).hostname;
    if (this.options.policyGate !== undefined) {
      const allowed = await this.options.policyGate.check(domain);
      if (!allowed) {
        throw new PolicyDeniedError(domain);
      }
    }
    await this.client.send("Page.navigate", { url }, page.sessionId);
    page.url = url;
  }

  /** PNG screenshot of the page (base64). */
  async screenshot(page: BrowserPage): Promise<string> {
    const result = asRecord(
      await this.client.send("Page.captureScreenshot", { format: "png" }, page.sessionId),
    );
    const data = asString(result.data);
    if (data === null) {
      throw new Error("Page.captureScreenshot returned no data");
    }
    return data;
  }

  /** Evaluates an expression in the page, returning the JSON value. */
  async evaluate<T = unknown>(page: BrowserPage, expression: string): Promise<T> {
    const result = asRecord(
      await this.client.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        page.sessionId,
      ),
    );
    const exception = asRecord(result.exceptionDetails);
    if (Object.keys(exception).length > 0) {
      throw new Error(`Runtime.evaluate raised: ${JSON.stringify(exception).slice(0, 300)}`);
    }
    return asRecord(result.result).value as T;
  }

  /** Full DOM snapshot (DOMSnapshot.captureSnapshot). */
  async domSnapshot(page: BrowserPage): Promise<unknown> {
    return this.client.send(
      "DOMSnapshot.captureSnapshot",
      { computedStyles: [], includeDOMRects: true },
      page.sessionId,
    );
  }

  /** Full accessibility tree (Accessibility.getFullAXTree). */
  async axTree(page: BrowserPage): Promise<unknown> {
    return this.client.send("Accessibility.getFullAXTree", {}, page.sessionId);
  }

  /** Visible page text, sanitized before it can enter model context. */
  async domText(page: BrowserPage): Promise<{ text: string; flagged: boolean }> {
    const raw = await this.evaluate<string>(page, "document.body ? document.body.innerText : ''");
    const sanitized = sanitizeObservation(typeof raw === "string" ? raw : "");
    return { text: sanitized.text, flagged: sanitized.flagged };
  }

  /**
   * Produces an observation strictly according to the declared mode:
   *  - visual: screenshot only;
   *  - dom: sanitized text + DOM snapshot, no pixels;
   *  - hybrid: both, plus the accessibility tree.
   * The mode is recorded on the observation itself.
   */
  async observe(page: BrowserPage): Promise<BrowserObservation> {
    const mode = this.options.mode;
    const base: BrowserObservation = {
      mode,
      url: page.url,
      title: null,
      screenshotPngBase64: null,
      domText: null,
      domSnapshot: null,
      axTree: null,
      sanitizeFlagged: false,
      capturedAt: nowIso(),
    };
    if (mode === "visual" || mode === "hybrid") {
      base.screenshotPngBase64 = await this.screenshot(page);
    }
    if (mode === "dom" || mode === "hybrid") {
      const { text, flagged } = await this.domText(page);
      base.domText = text;
      base.sanitizeFlagged = flagged;
      base.domSnapshot = await this.domSnapshot(page);
      base.title = await this.evaluate<string>(page, "document.title").catch(() => null);
    }
    if (mode === "hybrid") {
      base.axTree = await this.axTree(page);
    }
    return base;
  }

  /**
   * Uploads files into an <input type=file> matched by selector. Always
   * requires the explicit approval callback; denial throws UploadDeniedError.
   */
  async uploadFiles(page: BrowserPage, selector: string, paths: string[]): Promise<void> {
    if (this.options.onUploadApproval === undefined) {
      throw new UploadDeniedError(paths);
    }
    const approved = await this.options.onUploadApproval(paths);
    if (!approved) {
      throw new UploadDeniedError(paths);
    }
    const doc = asRecord(await this.client.send("DOM.getDocument", { depth: 1 }, page.sessionId));
    const rootId = asNumber(asRecord(doc.root).nodeId);
    if (rootId === null) {
      throw new Error("DOM.getDocument returned no root nodeId");
    }
    const queried = asRecord(
      await this.client.send("DOM.querySelector", { nodeId: rootId, selector }, page.sessionId),
    );
    const nodeId = asNumber(queried.nodeId);
    if (nodeId === null || nodeId === 0) {
      throw new Error(`no element matches selector: ${selector}`);
    }
    await this.client.send("DOM.setFileInputFiles", { files: paths, nodeId }, page.sessionId);
  }

  /** Routes browser downloads into the given directory. */
  async setDownloadDir(dir: string): Promise<void> {
    await this.client.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: dir,
    });
  }

  async close(): Promise<void> {
    for (const detach of this.detachEvents) {
      detach();
    }
    this.detachEvents.length = 0;
    await this.client.close();
    if (this.browser !== null) {
      await this.browser.close();
    }
  }

  private wireEventCollection(): void {
    this.detachEvents.push(
      this.client.on("Runtime.consoleAPICalled", (params) => {
        const record = asRecord(params);
        const args = Array.isArray(record.args) ? record.args : [];
        const text = args
          .map((arg) => {
            const a = asRecord(arg);
            return asString(a.value) ?? asString(a.description) ?? "";
          })
          .filter((part) => part.length > 0)
          .join(" ");
        this.pushConsole({
          type: asString(record.type) ?? "log",
          text,
          url: null,
          at: nowIso(),
        });
      }),
      this.client.on("Runtime.exceptionThrown", (params) => {
        const details = asRecord(asRecord(params).exceptionDetails);
        this.pushConsole({
          type: "exception",
          text: asString(details.text) ?? "unknown exception",
          url: asString(details.url),
          at: nowIso(),
        });
      }),
      this.client.on("Network.requestWillBeSent", (params) => {
        const record = asRecord(params);
        const request = asRecord(record.request);
        this.pushNetwork({
          kind: "request",
          url: asString(request.url) ?? "",
          method: asString(request.method),
          status: null,
          at: nowIso(),
        });
      }),
      this.client.on("Network.responseReceived", (params) => {
        const record = asRecord(params);
        const response = asRecord(record.response);
        this.pushNetwork({
          kind: "response",
          url: asString(response.url) ?? "",
          method: null,
          status: asNumber(response.status),
          at: nowIso(),
        });
      }),
      this.client.on("Network.loadingFinished", () => {
        this.pushNetwork({
          kind: "loading_finished",
          url: "",
          method: null,
          status: null,
          at: nowIso(),
        });
      }),
      this.client.on("Network.loadingFailed", (params) => {
        const record = asRecord(params);
        this.pushNetwork({
          kind: "loading_failed",
          url: asString(record.errorText) ?? "",
          method: null,
          status: null,
          at: nowIso(),
        });
      }),
    );
  }

  private pushConsole(record: ConsoleRecord): void {
    this.consoleRing.push(record);
    while (this.consoleRing.length > this.bufferLimit) {
      this.consoleRing.shift();
    }
  }

  private pushNetwork(record: NetworkRecord): void {
    this.networkRing.push(record);
    while (this.networkRing.length > this.bufferLimit) {
      this.networkRing.shift();
    }
  }
}
