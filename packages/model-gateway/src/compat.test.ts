import { describe, expect, it } from "vitest";
import { ToolCallCompatLayer } from "./compat.js";
import { textMessage, type ToolSpec } from "./types.js";

const tools: ToolSpec[] = [
  {
    name: "get_weather",
    description: "Get the weather for a city.",
    parametersJsonSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
  {
    name: "calculator",
    description: "Evaluate an arithmetic expression.",
    parametersJsonSchema: { type: "object", properties: { expr: { type: "string" } } },
  },
];

describe("ToolCallCompatLayer", () => {
  it("serializes tool specs into a deterministic system prompt", () => {
    const layer = new ToolCallCompatLayer();
    const prompt = layer.buildToolPrompt(tools);
    expect(prompt).toContain('"name": "get_weather"');
    expect(prompt).toContain('"description": "Evaluate an arithmetic expression."');
    expect(prompt).toContain("```json");
    // Deterministic: same input, same prompt.
    expect(new ToolCallCompatLayer().buildToolPrompt(tools)).toBe(prompt);
  });

  it("injects a system message, merging with an existing one", () => {
    const layer = new ToolCallCompatLayer();
    const withoutSystem = layer.injectTools([textMessage("user", "hi")], tools);
    expect(withoutSystem[0]?.role).toBe("system");
    expect(withoutSystem[1]?.role).toBe("user");

    const withSystem = layer.injectTools(
      [textMessage("system", "Be terse."), textMessage("user", "hi")],
      tools,
    );
    expect(withSystem).toHaveLength(2);
    expect(withSystem[0]?.role).toBe("system");
    const sysText = withSystem[0]?.parts[0];
    expect(sysText?.type === "text" && sysText.text.includes("Be terse.")).toBe(true);
    expect(sysText?.type === "text" && sysText.text.includes("get_weather")).toBe(true);
  });

  it("parses a fenced tool-call block out of mixed output", () => {
    const layer = new ToolCallCompatLayer();
    const output = [
      "Let me check that for you.",
      "```json",
      '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}',
      "```",
    ].join("\n");
    const parsed = layer.parseResponse(output);
    expect(parsed.text).toBe("Let me check that for you.");
    expect(parsed.toolCalls).toEqual([
      { id: "compat_1", name: "get_weather", argumentsJson: '{"city":"Paris"}' },
    ]);
  });

  it("generates deterministic sequential ids and honors provided ids", () => {
    const layer = new ToolCallCompatLayer();
    const first = layer.parseResponse('```json\n{"tool_calls":[{"name":"a","arguments":{}}]}\n```');
    const second = layer.parseResponse(
      '```json\n{"tool_calls":[{"id":"given","name":"b","arguments":{}},{"name":"c"}]}\n```',
    );
    expect(first.toolCalls[0]?.id).toBe("compat_1");
    expect(second.toolCalls.map((c) => c.id)).toEqual(["given", "compat_2"]);
    expect(second.toolCalls[1]?.argumentsJson).toBe("{}");
  });

  it("ignores malformed or non-tool-call fences", () => {
    const layer = new ToolCallCompatLayer();
    const output = [
      "Here is some JSON:",
      "```json",
      '{"not":"a tool call"}',
      "```",
      "and broken:",
      "```json",
      "{oops",
      "```",
    ].join("\n");
    const parsed = layer.parseResponse(output);
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.text).toContain('"not":"a tool call"');
  });

  it("round-trips: prompt → model output → parsed call → formatted result message", () => {
    const layer = new ToolCallCompatLayer();
    const messages = layer.injectTools([textMessage("user", "Weather in Paris?")], tools);
    expect(messages[0]?.role).toBe("system");

    // Simulated weak-model reply following the injected instructions.
    const reply = 'Checking.\n```json\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}\n```';
    const parsed = layer.parseResponse(reply);
    expect(parsed.toolCalls).toHaveLength(1);
    const call = parsed.toolCalls[0];
    expect(call?.name).toBe("get_weather");

    const resultMessage = layer.formatToolResult(call ?? { id: "x", name: "x", argumentsJson: "{}" }, "18°C, cloudy");
    expect(resultMessage.role).toBe("user");
    const part = resultMessage.parts[0];
    expect(part?.type).toBe("text");
    if (part?.type !== "text") throw new Error("unreachable");
    expect(part.text).toContain("```json");
    const parsedResult = JSON.parse(part.text.replace(/^```json\n/, "").replace(/\n```$/, "")) as {
      tool_result: { id: string; name: string; result: string; is_error: boolean };
    };
    expect(parsedResult.tool_result).toEqual({
      id: call?.id,
      name: "get_weather",
      arguments: { city: "Paris" },
      result: "18°C, cloudy",
      is_error: false,
    });
  });
});
