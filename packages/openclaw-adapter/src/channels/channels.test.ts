import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { MsgContextInput } from "../router.js";
import { MockConnector } from "./mock.js";
import { WebhookConnector } from "./webhook.js";
import { formatApprovalPrompt, parseApprovalReply, telegramFormatter } from "./formatters.js";

describe("WebhookConnector", () => {
  let outbound: Server;
  let outboundBodies: unknown[];
  let outboundPort: number;
  let connector: WebhookConnector;

  beforeEach(async () => {
    outboundBodies = [];
    outbound = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        outboundBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => outbound.listen(0, "127.0.0.1", resolve));
    const addr = outbound.address();
    outboundPort = typeof addr === "object" && addr !== null ? addr.port : 0;

    connector = new WebhookConnector("telegram", {
      port: 0,
      secretToken: "s3cret",
      outboundUrl: `http://127.0.0.1:${outboundPort}/send`,
    });
  });

  afterEach(async () => {
    await connector.stop();
    await new Promise<void>((resolve) => outbound.close(() => resolve()));
  });

  function postWebhook(body: unknown, token?: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${connector.port}/webhook/telegram`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token !== undefined ? { "x-hook-token": token } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("rejects requests without the shared secret", async () => {
    const received: MsgContextInput[] = [];
    await connector.start((raw) => received.push(raw));
    expect((await postWebhook({})).status).toBe(401);
    expect((await postWebhook({}, "wrong")).status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("normalizes a telegram update into a MsgContext-like message", async () => {
    const received: MsgContextInput[] = [];
    await connector.start((raw) => received.push(raw));
    const res = await postWebhook(
      {
        update_id: 1,
        message: {
          message_id: 5,
          from: { id: 42, first_name: "Al", username: "alice" },
          chat: { id: 42, type: "private" },
          text: "hello bot",
          message_thread_id: 7,
        },
      },
      "s3cret",
    );
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      Provider: "telegram",
      AccountId: "default",
      From: "42",
      ChatType: "direct",
      SenderId: "42",
      SenderUsername: "alice",
      Body: "hello bot",
      MessageThreadId: "7",
    });
  });

  it("returns 422 for unrecognized payloads", async () => {
    await connector.start(() => {});
    expect((await postWebhook({ random: true }, "s3cret")).status).toBe(422);
  });

  it("send() posts the telegram-formatted payload to the outbound endpoint", async () => {
    await connector.start(() => {});
    await connector.send({ to: "42", text: "hi back", threadId: "7" });
    await new Promise((r) => setTimeout(r, 20));
    expect(outboundBodies).toEqual([{ chat_id: "42", text: "hi back", message_thread_id: "7" }]);
  });
});

describe("MockConnector", () => {
  it("injects inbound and records outbound", async () => {
    const mock = new MockConnector("slack", "team1");
    const received: MsgContextInput[] = [];
    await mock.start((raw) => received.push(raw));
    mock.inject({
      Provider: "slack",
      AccountId: "team1",
      From: "C123",
      ChatType: "channel",
      SenderId: "U1",
      Body: "yo",
    });
    expect(received).toHaveLength(1);
    await mock.send({ to: "C123", text: "reply" });
    expect(mock.sent).toEqual([{ to: "C123", text: "reply" }]);
    await mock.stop();
    await expect(mock.send({ to: "C123", text: "x" })).rejects.toThrow(/not started/);
  });
});

describe("formatters", () => {
  it("formats telegram outbound", () => {
    expect(telegramFormatter.formatOutbound({ to: "1", text: "t", replyToId: "9" })).toEqual({
      chat_id: "1",
      text: "t",
      reply_to_message_id: "9",
    });
  });

  it("parses approval replies", () => {
    expect(parseApprovalReply("yes")).toBe("approve");
    expect(parseApprovalReply("  Y ")).toBe("approve");
    expect(parseApprovalReply("no")).toBe("deny");
    expect(parseApprovalReply("deny")).toBe("deny");
    expect(parseApprovalReply("what is the weather?")).toBeNull();
  });

  it("formats approval prompts", () => {
    const text = formatApprovalPrompt({
      approvalId: "a1",
      capability: "shell.exec",
      risk: "high",
      summary: "run it",
      expiresInSeconds: 60,
    });
    expect(text).toContain("shell.exec");
    expect(text).toContain("high");
    expect(text).toContain("a1");
  });
});
