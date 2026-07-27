# Extending OmniHarness: Tools, Plugins, Skills

Four distinct extension concepts — don't conflate them:

| Concept | What it is | Trust level |
| --- | --- | --- |
| **Tool** | One atomic executable capability | Runs inside tool-runtime with full policy pipeline |
| **Plugin** | A code package registering tools/providers/UI/hooks | Sandboxed (node:vm), declared permissions only |
| **Skill** | Procedural knowledge (SKILL.md + resources), loaded on demand | No code execution by itself |
| **MCP server** | External tool protocol endpoint | Bridged as tools through the same policy pipeline |

## Writing a tool (core)

```ts
import type { Tool } from "@omniharness/tool-runtime";

export const myTool: Tool = {
  name: "my.tool",
  description: "What it does, for the model.",
  parametersSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  requiredCapabilities: ["fs.read"],
  async execute(args, ctx) {
    return { ok: true, output: `you asked about ${args.path}` };
  },
};
```

Every call flows: schema validation → policy evaluation → approval →
sandbox selection → execution → output sanitization → audit.

## Writing a plugin

`my-plugin/manifest.json`:

```json
{
  "id": "me.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "...",
  "author": "me",
  "license": "MIT",
  "entry": "index.js",
  "platforms": ["macos", "windows", "linux"],
  "permissions": {
    "capabilities": ["fs.read"],
    "tools": ["me.tool"],
    "uiExtensions": [],
    "registersProviders": false,
    "secrets": [],
    "networkDomains": []
  }
}
```

`my-plugin/index.js`:

```js
export function register(api) {
  api.registerTool({ name: "me.tool", /* ... */ });
}
```

The sandbox is absence-based: `require`, `process`, `fs`, network — none of it
exists inside the plugin context. Anything the manifest doesn't declare is
rejected at registration or execution. Permission expansion on update requires
explicit re-confirmation. See `plugins/examples/hello-tool`.

## Writing a skill

`my-skill/SKILL.md`:

```markdown
---
name: my-skill
description: When to use this skill (the router matches on this).
version: 1.0.0
requiredCapabilities: ["fs.read"]
---

# Instructions for the agent

Step-by-step procedural knowledge...
```

Install: `omni skill install --source local --ref ./my-skill`.
Scopes: global / profile / workspace / project (project wins on name shadowing).

## Skill learning

After a successful run the agent may produce a *skill proposal*. Proposals are
never auto-activated: they run through automated tests, show a diff, and wait
for your approval (`omni skill proposals`, TUI Skills view).

## Pi compatibility

- Pi extensions (`export default function(pi)`) load through the Pi adapter in
  extension-host (supported subset: `pi.registerTool`, `pi.registerCommand`,
  `pi.on` for session_start/agent_end/tool_call).
- Pi skills import from `.pi/skills` and `.agents/skills`.
- Pi sessions import with `omni session import --source pi <path>`.
