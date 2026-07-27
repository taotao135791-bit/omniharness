# OmniHarness

> 本地优先、模型无关的桌面 Agent 运行环境。一个运行时同时覆盖编程 Agent、
> 知识工作、浏览器自动化和桌面 Computer Use——接入任意模型。

[English README](./README.md) · [功能矩阵](./docs/FEATURE_MATRIX.md) · [已知限制](./KNOWN_ISSUES.md) · [架构](./docs/ARCHITECTURE.md)

## 它是什么

OmniHarness 围绕一个本地 **Agent Daemon** 构建：所有状态（会话、任务、工具、
审批、记忆、自动化）都由 daemon 统一管理。TUI、桌面 GUI、CLI、远程渠道都只是
它的客户端,通过带版本协商的本地 RPC 协议连接。整个产品只有一个 Agent 循环
（基于 [Pi](https://github.com/earendil-works/pi) 内核）、一个权限引擎、一套
Schema 驱动的配置系统。

- **模型自由**：OpenAI、Anthropic、Gemini、OpenRouter、Azure、Mistral、Groq、
  xAI、Kimi、MiniMax、DeepSeek、智谱、阿里云、火山引擎、Ollama、LM Studio、
  任意 OpenAI 兼容端点，以及自定义 Provider 插件。
- **默认安全**：能力（Capability）策略引擎、沙箱执行、审批流、API Key 存
  操作系统钥匙串、完整审计日志。
- **可扩展**：Tool、Plugin、Skill、MCP 是四个明确区分的概念，权限声明式管理。

## 快速开始

环境要求：Node.js ≥ 22.12（推荐 24）、pnpm 10、git。

```bash
git clone https://github.com/taotao135791-bit/omniharness.git
cd omniharness
pnpm setup              # 环境检查 + 安装依赖 + 构建全部包

# 方式一：开发模式直接从仓库运行
pnpm dev:daemon         # 终端 1：启动本地 daemon
pnpm dev:tui            # 终端 2：启动 TUI

# 方式二：构建独立安装包（单文件 bundle，不依赖本仓库）
pnpm release:local      # 产出 release/omniharness-<版本>.tar.gz
```

安装到系统（无需 root）：

```bash
tar -xzf release/omniharness-*.tar.gz -C /tmp
/tmp/omniharness-*/install.sh ~/.local     # 安装到 ~/.local/bin
export PATH="$HOME/.local/bin:$PATH"
omniharnessd &          # 启动 daemon（数据在 ~/.omniharness/）
omni doctor             # 验证：数据库、密钥库、数据目录、事件日志
```

桌面版（macOS 未签名测试包）：

```bash
cd apps/desktop && pnpm build && npx electron-builder --dir
open release/mac-arm64/OmniHarness.app
```

## 三分钟完成第一个任务

```bash
# 1. 添加模型（任选其一；Key 会存进系统钥匙串，不写明文文件）
omni provider add --kind anthropic --name "Claude" --api-key sk-ant-...
omni provider add --kind openai --name "OpenAI" --api-key sk-...
omni provider add --kind ollama --name "本地 Ollama"           # 本地模型无需 Key
omni provider add --kind kimi --name "Kimi" --api-key sk-...
omni provider add --kind openai-compatible --name "自建网关" --base-url http://localhost:8080/v1

omni provider test --provider <id>    # 测连通
omni model list                        # 查看模型及能力标签
omni model bind --role primary --model <modelId>   # 绑定主 Agent 模型

# 2. 建工作区和会话
omni project create demo
omni workspace register --project <id> --roots $PWD
omni session create --workspace <id> --title "第一个任务"

# 3. 跑任务（流式输出）
omni run start --session <id> "帮我梳理这个仓库的结构"
```

TUI 里更舒服：`omni-tui`，按 `ctrl+p` 打开命令面板（所有功能都能从这里到达），
`esc` 中断正在运行的 Agent，`/model` 热切换模型，`/diff` 审查改动。

## 核心理念

### 一个 Daemon，多个客户端

```
TUI / GUI / CLI / SDK / 远程渠道 ──► 本地 Daemon（唯一状态所有者）
                                      ├── Pi Agent 内核（唯一的 Agent 循环）
                                      ├── 模型路由器（角色绑定 / 降级 / 重试 / 预算）
                                      ├── 工具运行时（校验→策略→审批→沙箱→执行→审计）
                                      ├── 工作区与 Git（worktree 隔离 / hunk 级审查）
                                      ├── 记忆引擎 / Skill 引擎 / 自动化引擎
                                      └── OpenClaw 渠道适配器（Telegram/Slack/…）
```

TUI 和 GUI 共享同一个 daemon：在 TUI 里建的会话，打开 GUI 可以无缝继续。

### 多模型不是口号

每个模型声明**能力**（视觉、原生工具调用、结构化输出、上下文窗口、Computer
Use……），路由器按能力而不是按名字调度。可以为不同角色绑定不同模型：
主 Agent、规划者、执行者、审查者、摘要、记忆提取、Skill 学习、嵌入、快速小模型。
429 限流自动指数退避 + 按链降级；不支持原生工具调用的模型走受控兼容模式。

### 安全是核心层

- 高风险操作（shell、网络、删除、发消息、支付）默认每次询问
- 工作区内读写默认放行；越界访问一律需要审批
- 子 Agent 权限只能 ≤ 父 Agent；自动化任务权限更严格
- 插件在 `node:vm` 沙箱里运行，没有声明的能力物理上不存在
- 密钥永不进入模型上下文（secure-fill 机制直接填充）

### 长期记忆与 Skill 自学习

Agent 可以**提议**记忆和 Skill，但默认绝不静默生效：提取 → 自动测试 →
展示 Diff → 你批准 → 才生效。记忆有来源、置信度、作用域隔离，
你可以随时审查、修改、拒绝、删除、导出。

### 自动化不依赖界面开着

常驻调度器支持 cron、一次性任务、文件变化、Git 变化触发。TUI 和 GUI 都
关掉，自动化照常在 daemon 里运行，结果进审查队列。

## 数据都在你手里

| 内容 | 位置 |
| --- | --- |
| 数据库（会话/事件/设置） | `~/.omniharness/omniharness.db` |
| 认证 token | `~/.omniharness/.auth-token`（0600） |
| 日志（NDJSON，自动脱敏） | `~/.omniharness/daemon.log` |
| 导出全部数据 | `omni data export --target-dir <目录>` |
| 删除全部数据 | `omni data delete --confirm true` |

支持导入：Pi 会话/设置/Skill、Hermes 记忆/Skill/会话、MCP 配置、
AGENTS.md / CLAUDE.md 项目指令。

## 常用命令速查

```bash
omni doctor                     # 系统诊断
omni session list               # 会话列表
omni run start --session <id> "任务"   # 启动 Agent
omni approval list              # 待审批队列
omni diff show                  # 查看改动
omni checkpoint create          # 创建检查点（可回滚）
omni memory search "关键词"      # 搜索记忆
omni skill list                 # Skill 管理
omni automation list            # 自动化任务
omni task list                  # 多 Agent 任务
```

## 文档

- [入门指南](./docs/user-guide/GETTING_STARTED.md)
- [Provider 与模型](./docs/developer-guide/PROVIDERS.md)
- [扩展开发（Tool/Plugin/Skill）](./docs/developer-guide/EXTENDING.md)
- [架构](./docs/ARCHITECTURE.md) · [威胁模型](./docs/THREAT_MODEL.md)
- [上游审计：Pi / OpenClaw / Hermes / Codex / Claude](./docs/research/)

## 许可证

Apache-2.0。详见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
