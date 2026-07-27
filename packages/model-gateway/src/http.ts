import { ProviderHttpError } from "./errors.js";
import { SseDecoder, type SseEvent } from "./sse.js";

export type FetchLike = typeof fetch;

export interface PostSseOptions {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * POSTs a JSON body and yields the SSE events of the streaming response.
 * Non-2xx responses throw a ProviderHttpError carrying status, body and the
 * Retry-After hint.
 */
export async function* postSse(options: PostSseOptions): AsyncGenerator<SseEvent> {
  const res = await options.fetchImpl(options.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...options.headers,
    },
    body: JSON.stringify(options.body),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
    throw new ProviderHttpError(
      res.status,
      `Provider request failed with HTTP ${res.status}: ${bodyText.slice(0, 300)}`,
      { ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), body: bodyText },
    );
  }
  if (res.body === null)
    throw new Error("Provider returned no response body for a streaming request");

  const decoder = new SseDecoder();
  const text = new TextDecoder();
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const ev of decoder.push(text.decode(value, { stream: true }))) yield ev;
    }
    for (const ev of decoder.push(text.decode())) yield ev;
    for (const ev of decoder.flush()) yield ev;
  } finally {
    reader.releaseLock();
  }
}
