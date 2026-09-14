# dsh-codex-connector

把 **Codex CLI** 接到 **DeepSeek Harness** 上：让 DSH 通过对话或自动路由调用 Codex 做功能设计、出图、产出美术素材、代码评审等，并把产物回收进工作区。

架构决策、实测数据与自审记录见同仓的 `DESIGN.md`。本文件是使用与排错手册。

---

## 它解决什么问题

直接让 DSH 跑一条 `codex exec` 命令是行不通的，也不是好设计：

| 问题 | 实测证据 | 本项目的做法 |
|---|---|---|
| Codex 需要写自己的 `~/.codex`（app-server socket、tmp、多个 sqlite），而会话文件沙箱禁止工作区外写入 | `Error: failed to initialize in-process app-server client: 拒绝访问。 (os error 5)` | 执行层走**宿主侧 `ctx.subprocess`**（宿主执行世界），而不是让模型拼 shell |
| 出图产物落在 `$CODEX_HOME/generated_images/<run-dir>/`，而 `<run-dir>` **不等于** thread_id | 目录 `01a0a0f7-…` vs thread `01a0a0f5-…` | 运行前后目录快照 diff + 采纳 agent 回报的路径 |
| JSONL 里的传输告警**不代表失败**，且有两种形态 | 一次成功运行里既有 4 条 `Reconnecting…`，又有一条 item 包裹的 WebSocket 回退 | 按**语义**分类，不按事件形态 |
| 项目级 `.codex/config.toml` 默认**不生效**（信任门禁），但 `AGENTS.md` 不受影响 | 不可信 → model 仍是用户级值；加 trusted → 项目值生效 | 知识走 `AGENTS.md`，执行策略才需要授权，并如实报告 |
| 二进制路径会随升级变化（按哈希命名的目录） | 本机有两个副本：`…/Codex/bin/bffc…/codex.exe` 与 `~/.codex/plugins/.plugin-appserver/codex.exe` | 有序探测 + 配置覆盖，绝不硬编码 |

---

## 安装

```bash
# 1) 看变更计划（不写任何东西）
node scripts/install.mjs --profile web

# 2) 确认后写入（会自动备份，失败即还原）
node scripts/install.mjs --profile web --apply

# 3) 链接依赖
cd "$DSH_HOME/profiles/web" && pnpm install

# 4) 重启 DSH
```

卸载：

```bash
node scripts/install.mjs --profile web --uninstall --apply
```

安装脚本只改三处，且每处都先备份：

- `$DSH_HOME/profiles/<profile>/package.json` —— 增加一条 `link:` 依赖
- `$DSH_HOME/profiles/<profile>/cordis.patch.yml` —— 增加一行 `tool-codex-connector`
- **绝不**修改 shipped bundle（`dsh-base` / `dsh-web-app`）或 shipped preset

安装后可以验证（**必须在该 profile 目录里运行**，这样模块解析基准与加载器一致）：

```bash
cd "$DSH_HOME/profiles/web"
node <本仓库>/scripts/verify-install.mjs
```

它回答四个安装本身无法确认的问题：包能否从 profile 解析到、解析出的入口是否具备加载器采纳的形状（`name` / `apply` / `inject`）、patch 文件是否是**单一合法的根序列**、依赖是否是本地链接（改动即时生效而无需重新打包）。

### 让会话真正拿到工具

上面的 patch 把 **service 层**挂在 host 面。工具行属于 agent 面，需要加到一个 preset 上。推荐让脚本复制一个 shipped preset 再改副本：

```bash
node scripts/install.mjs --profile web --preset standard --apply
```

之后在新会话里选择该 preset 即可看到 `codex_*` 工具。

> 为什么 service 在 host 面：同一工作区的并发串行化必须**进程级**生效，否则多个会话各自持有队列，等于没有限制。

### 零依赖

本包**没有任何运行时依赖**（frontmatter 解析器是自带的）。这样它能在 profile 的模块解析环境里确定地加载，不会因为缺一个包而整行挂掉。

### 不想重启？先用动态插件

如果只想马上试、不想动 profile，可以用一个动态 Cordis 插件把工具挂进**当前会话**。
它不复制实现，而是调用本包的**真实 worker**：

```javascript
// cordis_define 的 host 半边（要点摘录）
const PKG = '<本包绝对路径>'
const WORKER = PKG + '\\lib\\workers\\worker.js'
const spec = { tool: 'codexDo', args: { task, workspace } }
const handle = ctx.subprocess.spawn({
  argv: [node, WORKER, JSON.stringify(spec)],
  cwd: workspace,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 4 * 1024 * 1024 }, stderr: { maxBytes: 512 * 1024 } },
  graceMs: 5000,
})
// 等 handle.done 后用 handle.collected.stdout.readFrom(0) 取 JSON
```

验证的是**同一份代码**，不会出现「临时能跑、落盘就坏」的分叉。缺点是进程重启即失效——长期使用仍建议走上面的 profile 安装。

---

## 用法

DSH 侧看到 6 个工具：

| 工具 | 用途 |
|---|---|
| `codex_status` | 健康检查：定位到哪个二进制、版本、是否登录、能力卡数量、项目是否已注册/可信 |
| `codex_project` | `status` / `register` / `refresh` / `grant-trust` / `revoke-trust` |
| `codex_capabilities` | 列出/检索/查看能力卡 |
| `codex_skill_write` | 新增或修订一张能力卡（自扩展写入端） |
| `codex_skill_verify` | 跑一次受控真实调用验证能力卡 |
| `codex_do` | 执行入口：给能力 id 或自然语言任务 |

### 典型调用

```
# 画图（自动路由到 image.generate）
codex_do { task: "帮我画一张金色怀表的写实特写，用作首页 hero" }

# 强制走某张卡，并传参数
codex_do { capability: "image.generate", inputs: { prompt: "…", count: "3", size: "1536x1024" } }

# 高级模型做设计
codex_do { task: "设计一下多租户配额系统的方案" }      # → design.spec

# 代码评审
codex_do { capability: "code.review", inputs: { scope: "uncommitted" } }

# 绕过目录，直接把原始任务丢给 Codex
codex_do { mode: "force", task: "解释这个仓库的构建流程" }

# 延续上一次会话（同一能力的 thread）
codex_do { capability: "design.spec", continueThread: true, task: "按上面的方案，把第 3 点展开" }
```

### 无匹配时的行为

`codex_do` **不会猜**。没有命中任何能力卡时它返回目录清单并让你决定：要么 `mode: "force"` 直接下发任务，要么先写一张能力卡。这是刻意的——猜测路由会产生难以复现的错误结果。

---

## 项目注册：`<workspace>/.codex/`

首次在某工作区调用时，控制器会把该工作区登记为 Codex 项目：

```
<workspace>/
├── AGENTS.md                   ← 项目指令（**已存在则绝不修改**）
└── .codex/                     ← 项目根标志 + 项目信息
    ├── config.toml             ← Codex 读；含 project_root_markers
    ├── project/
    │   ├── PROJECT.md          ← 技术栈、常用命令、目录结构（自动探测）
    │   ├── CAPABILITIES.md     ← 能力清单与产物约定（由能力卡生成）
    │   └── HISTORY.md          ← 追加式运行历史
    └── dsh/                    ← 说明与绑定信息
```

控制面状态在 `.dsh-codex/`（能力卡、运行记录、健康计数），本机可重建。

### 三个不变量

1. **根 `AGENTS.md` 存在即冻结。** 它同时是 DSH 自己的指令来源（host 组合的 `agent-instructions` 行会读它）。改写它等于静默改掉 DSH 的提示词。仅在文件不存在时创建，且只写指针。
2. **`.codex/config.toml` 只补缺失键。** 已存在则完全不动——它是用户的文件。
3. **外来 `.codex/` 未经确认不写入。** 检测到不是我们创建的目录时，`register` 返回 `needsAdoption: true`，需要显式 `adopt: true`。

### 关于「可信」与 `configEffective`

Codex 会把项目级 `.codex/config.toml` **完全忽略**，除非该项目在用户级配置里被标记为可信：

```toml
# ~/.codex/config.toml
[projects.'f:\your\project']
trust_level = "trusted"
```

因此 `codex_project` 的报告里有两个独立字段：

- `configEffective` —— 项目级**执行策略**是否真的生效（需要可信）
- 项目**知识**（`AGENTS.md` / `.codex/project/`）不受影响，始终生效

控制器**绝不会**自己写你的用户级配置。需要时用 `codex_project action=grant-trust` 显式授权（写入前备份、写入后校验、失败即还原、提供对称的 `revoke-trust`）。

> 注意：Codex 自己也可能在运行中往 `~/.codex/config.toml` 追加 trust 条目（实测发生过）。所以可信状态**每次都重新读取**，不缓存。

---

## 能力卡：扩展点

一张卡 = 一个 Markdown 文件，放在 `<workspace>/.dsh-codex/capabilities/<id>.md`，人可读、可 diff、可进 git。

```markdown
---
id: image.generate
title: 生成图片
description: 需要 AI 生成的位图素材时使用。
triggers: [画一张图, 生成图片, 出图, 美术素材]
engine: codex-exec
sandbox: workspace-write            # read-only | workspace-write | danger-full-access
skills: [imagegen]                  # 期望 Codex 命中的 skill，会写进 prompt 硬约束
output: paths
timeoutMs: 900000
artifacts:
  patterns: ["$CODEX_HOME/generated_images/**/*.png"]
  collectTo: assets/generated
inputs:
  - name: prompt
    required: true
  - name: count
    required: false
    default: "1"
---

用 `imagegen` skill 出图：{{prompt}}，共 {{count}} 张。
出图后把选中的图复制到 assets/generated/，文件名语义化，不要覆盖已有文件。
最后逐行列出实际写入的文件绝对路径。
```

- `{{name}}` 从 `inputs` 取值；**必填项缺失或占位符未填会立刻失败**，不会把半成品 prompt 送出去。
- `sandbox: danger-full-access` 写在卡片里**不构成授权**，必须调用时显式传 `sandbox`。
- 内置 4 张种子卡（`image.generate` / `design.spec` / `code.review` / `art.assets`）在首次使用时复制进项目；**复制后就是项目文件，包升级不会覆盖**。

### 自扩展闭环

```
① codex_do 未命中
② 先查目录与 Codex 侧真实资产（skills / plugins）
③ 分类：薄封装既有 skill ｜ 或写 prompt 级流程
④ codex_skill_write 落盘能力卡（项目级）
⑤ codex_skill_verify 跑一次真实 probe
⑥ 下次同类任务直接命中
```

防劣化护栏：同名覆盖而非新建 · 先查后写（`overwrite` 必须显式）· 写后必验（未验证为 `draft`）· 连续失败 3 次自动降级 `needs-review` 并退出 auto 选择 · 变更留痕（`HISTORY.md` + `runs/<id>/`）。

---

## 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| `Codex CLI not found` | 探测全部未命中 | 用 `codex_status` 看 `probes`；在 `.dsh-codex/config.json` 里设 `codexBinary` |
| `failed to initialize in-process app-server client: 拒绝访问。 (os error 5)` | 执行层没走宿主 `subprocess`，被文件沙箱拦了 | 确认插件在 host 面加载；不要用会话里的 `pwsh` 直接调 Codex |
| 运行成功但报告 `ok:false` 且 errors 里有 WebSocket/Reconnecting 字样 | 事件分类过严（旧 bug） | 已修：传输通知按语义归为 warning。升级到包含该修复的版本 |
| `configEffective: false` | 项目未被标记可信 | 项目知识仍然生效；需要执行策略时 `codex_project action=grant-trust` |
| 出图成功但工作区没有文件 | 制品未被回收 | 检查 `result.artifactSources` 与 `.dsh-codex/runs/<id>/result.json`；能力卡的 `artifacts.patterns` 是否匹配 |
| 每次调用都要 2 分钟以上 | 当前网络下 WebSocket 握手超时后回退 HTTPS（实测 118–126s） | 正常现象。工具调用是**同步阻塞**的（见下），所以批量任务请拆成多次调用，并在开始前告知用户预期耗时 |
| 任务被报 `timed out ... and was terminated` | 超过 `timeoutMs`（默认 15 分钟）被杀 | 结果可能被截断，且**不会**被当成成功。提高 `timeoutMs` 或拆小任务 |
| 模型报 `not supported when using Codex with a ChatGPT account` | 能力卡里的 `model` 用了账号不可用的模型 | 把卡片 `model` 留空以继承默认 |
| `.codex/` 被判为外来目录 | 既有目录非本工具创建 | 确认内容后 `codex_project { action: "register", adopt: true }` |
| `grant-trust` 返回 `no-approval-channel` | 该部署没有审批通道，且写入你的全局配置必须经同意 | 按提示手工加入该条目；或让用户在配置里允许 |

> **关于后台运行**：本版本的工具调用是**同步**的——它不会返回 job id，也不接管后台作业。一次调用会一直阻塞到 Codex 退出或被 `timeoutMs` 杀掉。宿主侧的工具调用超时策略（`@deepseek-ai/dsh-tool-call-timeout-policy`）会在更外层生效。这一点在 README 里写清楚，是因为「长任务后台跑」曾经是一句没有实现支撑的承诺。

---

## 验证

```bash
npm run selftest     # 离线自测：58 项，不联网、不调 Codex
npm run live-check   # 真实链路：会真的调用 Codex（每次 2 分钟起）
```

`live-check` 支持的开关：

```bash
node scripts/live-check.cjs --quick        # 只做定位/鉴权/注册/路由，不调 Codex
node scripts/live-check.cjs --with-image   # 额外验证 imagegen 出图与制品回收
node scripts/live-check.cjs --workspace <dir>
```

自测覆盖了若干**只有在真实运行中才会暴露**的回归：种子卡的 frontmatter 完整性、运行副作用创建 `.codex/` 导致的自我死锁、item 形态的传输通知误判为失败、以及 `danger-full-access` 授权边界。

---

## 权限与安全

- **环境变量收敛**：spawn 时只放行白名单变量，`DEEPSEEK_API_KEY` 等凭据**不会**传给 Codex（实测抑制 51 个无关变量）。
- **沙箱由 Codex 自己执行**：本项目只传递 `-s`，不重写 Codex 的沙箱与审批语义。
- **默认 `workspace-write`**：出图落盘够用，且不越界。`danger-full-access` 必须单次显式请求。
- **不写用户级配置**：除显式 `grant-trust` 外，控制器不碰 `~/.codex/config.toml`。

## License

MIT
