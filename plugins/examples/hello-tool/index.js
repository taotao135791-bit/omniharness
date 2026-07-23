/** Example plugin entry. The extension host calls register() with a sandboxed API. */
export function register(api) {
  api.registerTool({
    name: "example.hello",
    description: "Return a greeting. Demonstrates the plugin tool contract.",
    parametersSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(args) {
      return { ok: true, output: `Hello, ${args.name}!` };
    },
  });
}
