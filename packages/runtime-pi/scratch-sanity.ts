/* eslint-disable no-console */
// Sanity checks for pi-agent-core / pi-ai integration seams. Deleted before delivery.
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  AssistantMessageEventStream,
  Type,
  validateToolArguments,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";

// 1. Plain JSON schema (no TypeBox symbols) through validateToolArguments.
const plainSchema = {
  type: "object",
  properties: { path: { type: "string" }, n: { type: "integer" } },
  required: ["path"],
  additionalProperties: false,
};
try {
  const out = validateToolArguments(
    { name: "t", description: "d", parameters: plainSchema as never },
    { id: "1", name: "t", type: "toolCall", arguments: { path: "x", n: 3 } },
  );
  console.log("plain schema OK:", JSON.stringify(out));
} catch (e) {
  console.log("plain schema FAILED:", (e as Error).message);
}

// 2. TypeBox schema via pi-ai's re-exported Type.
const tbSchema = Type.Object({ path: Type.String() });
try {
  const out = validateToolArguments(
    { name: "t", description: "d", parameters: tbSchema },
    { id: "1", name: "t", type: "toolCall", arguments: { path: "y" } },
  );
  console.log("typebox schema OK:", JSON.stringify(out));
} catch (e) {
  console.log("typebox schema FAILED:", (e as Error).message);
}

// 3. Custom StreamFn + Agent end-to-end (text + tool call + follow-up turn).
function makeModel(): Model<"pi-messages"> {
  return {
    id: "fixture",
    name: "fixture",
    api: "pi-messages",
    provider: "omniharness",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function baseMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "pi-messages",
    provider: "omniharness",
    model: "fixture",
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

let call = 0;
const streamFn: StreamFn = () => {
  call += 1;
  const stream = new AssistantMessageEventStream();
  queueMicrotask(() => {
    if (call === 1) {
      const msg = baseMessage();
      msg.content = [
        { type: "toolCall", id: "tc1", name: "echo", arguments: { text: "hi" } },
      ];
      msg.stopReason = "toolUse";
      stream.push({ type: "start", partial: { ...msg, content: [] } });
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...msg, content: [] } });
      stream.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "tc1", name: "echo", arguments: { text: "hi" } },
        partial: msg,
      });
      stream.push({ type: "done", reason: "toolUse", message: msg });
      stream.end(msg);
    } else {
      const msg = baseMessage();
      msg.content = [{ type: "text", text: "hello world" }];
      msg.usage.input = 10;
      msg.usage.output = 5;
      msg.usage.totalTokens = 15;
      stream.push({ type: "start", partial: { ...msg, content: [] } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "hello ", partial: { ...msg, content: [{ type: "text", text: "hello " }] } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "world", partial: msg });
      stream.push({ type: "done", reason: "stop", message: msg });
      stream.end(msg);
    }
  });
  return stream;
};

const agent = new Agent({
  initialState: {
    systemPrompt: "sys",
    model: makeModel(),
    tools: [
      {
        name: "echo",
        description: "echo tool",
        label: "Echo",
        parameters: plainSchema as never,
        execute: async (_id, params) => ({
          content: [{ type: "text", text: `echo:${JSON.stringify(params)}` }],
          details: {},
        }),
      },
    ],
  },
  streamFn,
});

agent.subscribe((event) => {
  console.log("event:", event.type, JSON.stringify(event).slice(0, 160));
});

await agent.prompt("do it");
await agent.waitForIdle();
console.log("final messages:", agent.state.messages.length);
console.log("roles:", agent.state.messages.map((m) => m.role).join(","));
