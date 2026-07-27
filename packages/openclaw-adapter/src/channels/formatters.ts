/**
 * Per-channel-kind payload formatters. They shape an OutboundMessage into the
 * body a channel delivery endpoint expects. Telegram/Slack/Discord specifics
 * live here and ONLY here — the connectors stay generic.
 */

import type { OutboundMessage } from "./connector.js";

export interface ChannelFormatter {
  /** Parse a normalized inbound webhook payload into MsgContext fields, or null to drop. */
  parseInbound(body: unknown): {
    from: string;
    chatType: "direct" | "group" | "channel";
    senderId: string;
    senderName?: string;
    senderUsername?: string;
    body: string;
    threadId?: string;
    media?: Array<{ mediaType: string; sizeBytes?: number; url?: string }>;
  } | null;
  /** Shape an outbound message for this channel's delivery endpoint. */
  formatOutbound(message: OutboundMessage): Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Telegram: chat.id addressing; message.chat.type private/group/supergroup/channel. */
export const telegramFormatter: ChannelFormatter = {
  parseInbound(body) {
    if (!isRecord(body)) return null;
    const message = isRecord(body["message"]) ? body["message"] : body;
    const chat = isRecord(message["chat"]) ? message["chat"] : null;
    const from = isRecord(message["from"]) ? message["from"] : null;
    const chatId = chat
      ? (str(chat["id"]) ?? String(num(chat["id"]) ?? ""))
      : str(message["chat_id"]);
    const senderId = from
      ? (str(from["id"]) ?? String(num(from["id"]) ?? ""))
      : senderIdFallback(message);
    const text = str(message["text"]) ?? str(message["caption"]);
    if (!chatId || !senderId || !text) return null;
    const chatTypeRaw = str(chat?.["type"]) ?? "private";
    const chatType =
      chatTypeRaw === "private" ? "direct" : chatTypeRaw === "channel" ? "channel" : "group";
    const out: ReturnType<ChannelFormatter["parseInbound"]> = {
      from: chatId,
      chatType,
      senderId,
      body: text,
    };
    if (!out) return null;
    const name = [str(from?.["first_name"]), str(from?.["last_name"])].filter(Boolean).join(" ");
    if (name) out.senderName = name;
    const username = str(from?.["username"]);
    if (username) out.senderUsername = username;
    const threadId = num(message["message_thread_id"]);
    if (threadId !== undefined) out.threadId = String(threadId);
    return out;
  },
  formatOutbound(message) {
    const out: Record<string, unknown> = { chat_id: message.to, text: message.text };
    if (message.threadId) out["message_thread_id"] = message.threadId;
    if (message.replyToId) out["reply_to_message_id"] = message.replyToId;
    return out;
  },
};

function senderIdFallback(message: Record<string, unknown>): string | undefined {
  return str(message["sender_id"]) ?? str(message["senderId"]);
}

/** Slack: channel/event payload; app_mention/message events. */
export const slackFormatter: ChannelFormatter = {
  parseInbound(body) {
    if (!isRecord(body)) return null;
    const event = isRecord(body["event"]) ? body["event"] : body;
    const channelId = str(event["channel"]);
    const userId = str(event["user"]);
    const text = str(event["text"]);
    if (!channelId || !userId || !text) return null;
    const channelType = str(event["channel_type"]);
    const out: ReturnType<ChannelFormatter["parseInbound"]> = {
      from: channelId,
      chatType: channelType === "im" ? "direct" : channelType === "channel" ? "channel" : "group",
      senderId: userId,
      body: text,
    };
    if (!out) return null;
    const threadTs = str(event["thread_ts"]);
    if (threadTs) out.threadId = threadTs;
    return out;
  },
  formatOutbound(message) {
    const out: Record<string, unknown> = { channel: message.to, text: message.text };
    if (message.threadId) out["thread_ts"] = message.threadId;
    return out;
  },
};

/** Discord: channel_id + author.id; guild messages are "channel" chats. */
export const discordFormatter: ChannelFormatter = {
  parseInbound(body) {
    if (!isRecord(body)) return null;
    const channelId = str(body["channel_id"]);
    const author = isRecord(body["author"]) ? body["author"] : null;
    const authorId = str(author?.["id"]);
    const text = str(body["content"]);
    if (!channelId || !authorId || !text) return null;
    const guildId = str(body["guild_id"]);
    const out: ReturnType<ChannelFormatter["parseInbound"]> = {
      from: channelId,
      chatType: guildId ? "channel" : "direct",
      senderId: authorId,
      body: text,
    };
    if (!out) return null;
    const username = str(author?.["username"]);
    if (username) out.senderUsername = username;
    return out;
  },
  formatOutbound(message) {
    const out: Record<string, unknown> = { channel_id: message.to, content: message.text };
    if (message.replyToId) out["message_reference"] = { message_id: message.replyToId };
    return out;
  },
};

/** Generic pass-through: the webhook payload is already MsgContext-normalized. */
export const genericFormatter: ChannelFormatter = {
  parseInbound(body) {
    if (!isRecord(body)) return null;
    const from = str(body["from"]);
    const senderId = str(body["senderId"]);
    const text = str(body["body"]);
    if (!from || !senderId || !text) return null;
    const chatType = str(body["chatType"]);
    const out: ReturnType<ChannelFormatter["parseInbound"]> = {
      from,
      chatType: chatType === "group" || chatType === "channel" ? chatType : "direct",
      senderId,
      body: text,
    };
    if (!out) return null;
    const name = str(body["senderName"]);
    if (name) out.senderName = name;
    const username = str(body["senderUsername"]);
    if (username) out.senderUsername = username;
    const threadId = str(body["threadId"]);
    if (threadId) out.threadId = threadId;
    const media = body["media"];
    if (Array.isArray(media)) {
      const items: Array<{ mediaType: string; sizeBytes?: number; url?: string }> = [];
      for (const item of media) {
        if (!isRecord(item)) continue;
        const mediaType = str(item["mediaType"]);
        if (!mediaType) continue;
        const entry: { mediaType: string; sizeBytes?: number; url?: string } = { mediaType };
        const size = num(item["sizeBytes"]);
        if (size !== undefined) entry.sizeBytes = size;
        const url = str(item["url"]);
        if (url) entry.url = url;
        items.push(entry);
      }
      if (items.length > 0) out.media = items;
    }
    return out;
  },
  formatOutbound(message) {
    const out: Record<string, unknown> = { to: message.to, text: message.text };
    if (message.threadId) out["threadId"] = message.threadId;
    if (message.replyToId) out["replyToId"] = message.replyToId;
    return out;
  },
};

export const CHANNEL_FORMATTERS: Record<string, ChannelFormatter> = {
  telegram: telegramFormatter,
  slack: slackFormatter,
  discord: discordFormatter,
  whatsapp: genericFormatter,
  generic: genericFormatter,
};

export function formatterFor(kind: string): ChannelFormatter {
  return CHANNEL_FORMATTERS[kind.toLowerCase()] ?? genericFormatter;
}

/** Format an approval prompt for a channel user. */
export function formatApprovalPrompt(params: {
  approvalId: string;
  capability: string;
  risk: string;
  summary: string;
  expiresInSeconds: number;
}): string {
  return [
    `⚠️ Approval required (${params.risk} risk)`,
    `Capability: ${params.capability}`,
    params.summary,
    ``,
    `Reply "yes" to approve or "no" to deny (expires in ${Math.round(params.expiresInSeconds)}s).`,
    `ref: ${params.approvalId}`,
  ].join("\n");
}

/** Parse a channel user's approval reply. Returns null when not an approval reply. */
export function parseApprovalReply(text: string): "approve" | "deny" | null {
  const t = text.trim().toLowerCase();
  if (/^(y|yes|approve|approved|ok|allow)$/.test(t)) return "approve";
  if (/^(n|no|deny|denied|reject|block)$/.test(t)) return "deny";
  return null;
}
