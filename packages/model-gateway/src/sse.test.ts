import { describe, expect, it } from "vitest";
import { AnthropicSseMapper, OpenAiSseMapper, SseDecoder, parseSseText } from "./sse.js";

describe("parseSseText", () => {
  it("parses events with data and event fields", () => {
    const events = parseSseText("event: foo\ndata: hello\n\ndata: world\n\n");
    expect(events).toEqual([
      { event: "foo", data: "hello" },
      { data: "world" },
    ]);
  });

  it("joins multi-line data and ignores comments", () => {
    const events = parseSseText(": heartbeat\ndata: a\ndata: b\n\n");
    expect(events).toEqual([{ data: "a\nb" }]);
  });
});

describe("SseDecoder", () => {
  it("handles events split across arbitrary chunk boundaries", () => {
    const decoder = new SseDecoder();
    expect(decoder.push("data: hel")).toEqual([]);
    expect(decoder.push("lo\n\nda")).toEqual([{ data: "hello" }]);
    expect(decoder.push("ta: bye\n\n")).toEqual([{ data: "bye" }]);
    expect(decoder.flush()).toEqual([]);
  });

  it("flush parses a trailing unterminated event", () => {
    const decoder = new SseDecoder();
    expect(decoder.push("data: tail")).toEqual([]);
    expect(decoder.flush()).toEqual([{ data: "tail" }]);
  });
});

const OPENAI_SSE = [
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":" world"}}]}',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]}}]}',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
  'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":4}}}',
  "data: [DONE]",
  "",
].join("\n");

describe("OpenAiSseMapper", () => {
  it("maps canned OpenAI SSE (text + tool call + usage) to chunks", () => {
    const mapper = new OpenAiSseMapper();
    const chunks = parseSseText(OPENAI_SSE).flatMap((ev) => mapper.pushData(ev.data));

    expect(chunks).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      {
        type: "tool_call_start",
        toolCall: { id: "call_abc", name: "get_weather", argumentsJson: "" },
      },
      { type: "tool_call_delta", toolCallId: "call_abc", text: '{"city":' },
      { type: "tool_call_delta", toolCallId: "call_abc", text: '"Paris"}' },
      {
        type: "tool_call_end",
        toolCall: { id: "call_abc", name: "get_weather", argumentsJson: '{"city":"Paris"}' },
        toolCallId: "call_abc",
      },
      { type: "finish", finishReason: "tool_calls" },
      {
        type: "usage",
        usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 4, cacheWriteTokens: 0 },
      },
    ]);
  });

  it("maps reasoning_content to reasoning_delta and length finish", () => {
    const mapper = new OpenAiSseMapper();
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
    ].flatMap((line) => mapper.pushData(line.slice(6)));
    expect(chunks).toEqual([
      { type: "reasoning_delta", text: "thinking" },
      { type: "finish", finishReason: "length" },
    ]);
  });

  it("surfaces provider error payloads", () => {
    const mapper = new OpenAiSseMapper();
    const chunks = mapper.pushData('{"error":{"message":"rate limited","type":"tokens"}}');
    expect(chunks).toEqual([{ type: "error", error: "rate limited" }]);
  });
});

const ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":20,"output_tokens":1}}}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"Lyon\\"}"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}',
  "event: message_stop\ndata: {\"type\":\"message_stop\"}",
  "",
].join("\n\n");

describe("AnthropicSseMapper", () => {
  it("maps canned Anthropic SSE (text + tool_use + usage) to chunks", () => {
    const mapper = new AnthropicSseMapper();
    const chunks = parseSseText(ANTHROPIC_SSE).flatMap((ev) => mapper.pushEvent(ev));

    expect(chunks).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 20, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      { type: "text_delta", text: "Hi" },
      {
        type: "tool_call_start",
        toolCall: { id: "toolu_1", name: "get_weather", argumentsJson: "" },
      },
      { type: "tool_call_delta", toolCallId: "toolu_1", text: '{"city":' },
      { type: "tool_call_delta", toolCallId: "toolu_1", text: '"Lyon"}' },
      {
        type: "tool_call_end",
        toolCall: { id: "toolu_1", name: "get_weather", argumentsJson: '{"city":"Lyon"}' },
        toolCallId: "toolu_1",
      },
      {
        type: "usage",
        usage: { inputTokens: 0, outputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      { type: "finish", finishReason: "tool_calls" },
    ]);
  });

  it("emits a stop finish from message_stop when no stop_reason was seen", () => {
    const mapper = new AnthropicSseMapper();
    const chunks = mapper.pushEvent({ event: "message_stop", data: '{"type":"message_stop"}' });
    expect(chunks).toEqual([{ type: "finish", finishReason: "stop" }]);
  });

  it("ignores ping events and reports malformed payloads as error chunks", () => {
    const mapper = new AnthropicSseMapper();
    expect(mapper.pushEvent({ event: "ping", data: '{"type":"ping"}' })).toEqual([]);
    expect(mapper.pushEvent({ event: "content_block_delta", data: "not json" })[0]?.type).toBe("error");
  });
});
