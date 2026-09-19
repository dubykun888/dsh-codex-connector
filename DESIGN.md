# dsh-codex-connector 设计文档

> 本文档与代码同仓，**自包含**：所有事实、数字、结论都来自本项目自身的实测记录，不依赖仓库外的任何文档或链接。
> 阅读顺序建议：§1 实测事实 → §3 架构 → §5 项目注册与信任 → §7 接口 → §9 自审记录。

---

## 1. 实测事实

下面每一条都在本机跑过并留下可复现的证据。凡属推断的，明确标注为推断。

### 1.1 Codex 侧

| 事实 | 值 | 对设计的影响 |
|---|---|---|
| 可执行文件存在**两个副本，为同一构建** | `%LOCALAPPDATA%\OpenAI\Codex\bin\bffc5354119c8421\codex.exe` 与 `%USERPROFILE%\.codex\plugins\.plugin-appserver\codex.exe`；SHA256 同为 `081E4DE4…`，大小同为 297 858 352 字节，时间戳同为 2026-09-13 10:59:41 | 两个入口等价，实测结论对二者同时成立；但**路径不可硬编码**（见 §1.4） |
| 版本 | `codex-cli 0.154.0-alpha.6.2` | 可编程接口齐全 |
| 鉴权 | `codex login status` → `Logged in using ChatGPT`（`auth_mode: chatgpt`） | 无需 API Key，走订阅额度 |
| 默认模型 | `model = "gpt-6-astra"`，`model_reasoning_effort = "xhigh"` | 「用高级模型做设计」天然成立，且可按调用覆盖 |
| 非交互接口 | `codex exec [OPTIONS] [PROMPT]`，子命令 `resume` / `fork` / `review` | 控制器主通道；`resume <id>` 支持续接会话 |
| 关键参数 | `--json`(JSONL) `-m/--model` `-s/--sandbox` `-C/--cd` `-p/--profile` `-o/--output-last-message` `-i/--image` `--output-schema` `--ephemeral` `--skip-git-repo-check` `--add-dir` | 足以做结构化、可审计、可限权的调用 |

### 1.2 能力面实测（让 Codex 自己枚举）

一条 `codex exec --json` 询问即可拿到**完整的**可用 skill 清单，比扫描目录更准（插件的 skill 带命名空间前缀）：

```
imagegen            openai-docs         plugin-creator
skill-creator       skill-installer
computer-use:computer-use
documents:documents  pdf:pdf            presentations:Presentations
sites:sites-building sites:sites-hosting
spreadsheets:Spreadsheets  spreadsheets:excel-live-control
template-creator:template-creator      visualize:visualize
```

能力面远超「写代码」，因此值得做成可编排的目录（§4）。

### 1.3 出图链路端到端实测

一次真实出图任务的观测结果：

| 观测项 | 实测值 |
|---|---|
| agent 是否命中 skill | 是。输出 `I'll use the imagegen skill to create one small square PNG…` |
| 是否真的产出位图 | 是。`%USERPROFILE%\.codex\generated_images\01a0a0f7-…\exec-c1752015-….png`，**337 514 字节** |
| agent 是否回报路径 | 是。最后一条 `agent_message` 就是该 PNG 的绝对路径 |
| **产物目录名 vs thread_id** | **不相等**：目录 `01a0a0f7-…`，同一轮 thread `01a0a0f5-…` |
| 耗时 | 195 330 ms |

`imagegen` 的首选路径是 Codex 的**内置 `image_gen` 工具**，它在 CLI 里没有独立子命令，只能由会话内的 agent 触发；**且不接受目标路径参数**——图一律落在 `$CODEX_HOME/generated_images/`。

**结论**：DSH 想让 Codex 出图，唯一现实通道是「跑一次会话 + 主动回收制品」。这也直接决定了架构形态（§3）。

### 1.4 二进制路径会漂移

`bin/` 下是**按内容哈希命名的版本目录**（观察到 `bffc5354119c8421` 与 `116cfc4fd47f015a` 两个，后者已不存在），升级会换名。因此定位必须是**有序探测**，绝不硬编码（实现见 §7.4）。

### 1.5 事件流 schema

`codex exec --json` 输出 JSONL。实测到的事件类型与字段：

```jsonl
{"type":"thread.started","thread_id":"01a0a0f5-40d5-7173-8a2c-a954f076a2ef"}
{"type":"turn.started"}
{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}
{"type":"error","message":"Falling back from WebSockets to HTTPS transport. request timed out"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport. request timed out"}}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"CONNECTOR_OK"}}
{"type":"turn.completed","usage":{"input_tokens":17183,"cached_input_tokens":13056,"cache_write_input_tokens":0,"output_tokens":177,"reasoning_output_tokens":91}}
```

三条必须按此实现的要点：

1. **`thread_id` 是会话续接的钥匙**（`codex exec resume <thread_id>`）。
2. **传输告警不是失败，且没有单一形态**。跨两次真实运行观测到同一条告警的两种形态：一次是普通 `{"type":"error"}`，另一次是 `item.completed` 包裹。**两次运行都成功返回了答案**。因此判定必须按**语义**而非事件形态。
3. **stdout 可能混入非 JSON 行**（宿主 shell 的噪声、被合并的原生 stderr）。必须逐行容错解析，绝不能整体 `JSON.parse`。

### 1.6 运行环境硬约束

会话文件沙箱下（仅工作区可写）执行 `codex exec` **直接失败**：

```
Error: failed to initialize in-process app-server client: 拒绝访问。 (os error 5)
```

原因：Codex 需要写自己的 `~/.codex`——app-server socket、`tmp/arg0*`、多个 sqlite 库。升权到完整访问后同一命令立刻成功。

**这是设计必须正视的约束**：执行层**必须走宿主侧执行世界**（本项目中即 `ctx.subprocess`），而不是让模型拼一条 shell 命令（见 §3）。

### 1.7 网络延迟实测

当前网络环境下每次调用都出现 4–5 次 `Reconnecting…` 与一次 WebSocket 回退，**单次极简调用耗时 118–126 秒**。因此：超时默认值是 15 分钟量级；批量任务必须提前告知用户预期耗时；`codex_status` 把传输健康纳入自检。

### 1.8 两个独立调查（未得出确定结论，如实标注）

| 项 | 观测 | 状态 |
|---|---|---|
| `codex exec` 为何会自己写 trust 条目 | 三次独立运行后，用户级配置里都多出一条本项目路径的 trusted 条目，而控制器从未写入 | **现象已复现，触发条件未确定**。实现上的应对是每次**现读**可信状态、绝不缓存 |
| 孙进程是否在超时后残留 | 实现用 `child.kill` 而非进程树终止 | **未实测**（沙箱禁止在会话内创建带管道的子进程）。本报告不声称结论 |

---

## 2. 设计目标与非目标

### 目标

1. 用 DSH 对话或自动路由驱动 Codex 完成：高级模型做设计、`imagegen` 出图、批量产出美术素材、代码评审。
2. 能力目录**用户可扩展**：加一种能力 = 写一张 Markdown 卡，不改代码。
3. 能力目录**DSH 可自扩展**，但有护栏，不退化成垃圾堆积。
4. 制品可靠回收进工作区。
5. 副作用可见、可撤销、可审计。

### 非目标

- 不重写 Codex 的沙箱与审批：只传递 `-s`，不改变其语义。
- 不做图片内容理解：出图质量由 DSH 自己看图判断。
- 不代理交互式 TUI：只走非交互 `exec`；需要人工介入时明确报错而不是挂起。
- 不在 DSH 侧复刻 Codex 的 skill 体系：Codex 侧 skill 归 Codex，这边只做薄封装与编排。

---

## 3. 架构

四层，用户唯一需要维护的是最上层：

```
┌──────────────────────────────────────────────────────────────┐
│ L4  能力目录  <workspace>/.dsh-codex/capabilities/*.md        │
│     人可读可写、可 git 管理、DSH 可自扩展 ← 用户扩展点          │
├──────────────────────────────────────────────────────────────┤
│ L3  工具面  codex_do / codex_capabilities / codex_skill_*     │
│             codex_project / codex_status                      │
├──────────────────────────────────────────────────────────────┤
│ L2  控制器（host 面 service）                                  │
│     定位 · 预检 · 编排 · 事件消费 · 制品回收 · 运行账本 · 并发   │
├──────────────────────────────────────────────────────────────┤
│ L1  执行通道                                                  │
│     ctx.subprocess（宿主执行世界）· ctx.tools 注册 · 子 Node    │
└──────────────────────────────────────────────────────────────┘
```

### 为什么需要 L2，而不是「让 DSH 直接跑一条命令」

| 直接跑命令的问题 | 依据 | L2 的做法 |
|---|---|---|
| 沙箱拒写 `~/.codex` | §1.6（实测 os error 5） | 走宿主侧 `subprocess`（宿主执行世界，不受会话文件沙箱限制） |
| 无结构化结果 | — | `--json` + 逐行容错解析（§1.5） |
| 产物散落 `~/.codex` 无人回收 | §1.3 | 快照 diff + 路径采纳（§8.1） |
| 长任务无法取消 | — | 超时终止，且把「被终止」纳入成败判定（§9.1 H-1） |
| 每次重述 prompt | — | 能力卡模板 + 会话续接 |
| 二进制路径漂移 | §1.4 | 有序探测（§7.4） |

### 平面选择

| 组件 | 所在平面 | 理由 |
|---|---|---|
| `codex` service、工具注册 | **host 面** | 同一工作区的并发串行化必须**进程级**生效；若每个会话各持一份队列，等于没有限制 |
| 执行通道 | **宿主执行世界** | §1.6：会话沙箱下根本起不来 |
| 能力目录、运行账本 | **项目内文件** | 能力随项目走、可进 git；状态本机可重建 |
| 项目信息（`.codex/`） | **项目内文件** | Codex 自己会读；随 git 共享给协作者 |

---

## 4. 能力目录（用户扩展点）

### 4.1 位置与分工

```
<workspace>/.dsh-codex/            ← 控制面状态（本机可重建）
├── capabilities/*.md              ← 能力卡（一个能力一个文件）
├── config.json                    ← 可选：二进制路径、默认模型/沙箱、并发上限
├── project.json                   ← 所有权记录
├── state.json                     ← 运行计数与每张卡的健康度
└── runs/<runId>/                  ← meta.json / events.jsonl / result.json / last-message.txt

<workspace>/.codex/                ← 交给 Codex 的项目信息（随 git 共享）
├── config.toml                    ← Codex 读；含 project_root_markers
├── project/                       ← PROJECT.md / CAPABILITIES.md / HISTORY.md
└── dsh/                           ← notes.md / binding.json
```

两者职责不重叠：前者是本机可重建的控制器状态，后者是团队可见的项目资产。

### 4.2 能力卡格式

一张卡 = Markdown + YAML frontmatter。**零依赖自研解析器**（§7.3），因此构造上是确定可解析的。

```markdown
---
id: image.generate
title: 生成图片
description: 需要 AI 生成的位图素材时使用：概念图、插画、贴图、sprite、UI mockup、透明底抠图、封面图。
triggers: [画一张图, 生成图片, 出图, 插画, 封面]
engine: codex-exec
sandbox: workspace-write
skills: [imagegen]
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

使用 imagegen skill 生成图片：{{prompt}}，共 {{count}} 张。
出图后把选中的图复制到工作区 assets/generated/，文件名语义化，不要覆盖已有文件。
最后逐行列出实际写入的文件绝对路径。
```

**为什么是 Markdown 文件而不是数据库或 JSON**：用户能直接改；DSH 能用现成的文件工具改；能进 git；出问题人眼一看就懂。

### 4.3 种子卡与项目自举

新项目目录为空。首次使用时会从包内置的 `capabilities/` 复制 4 张种子卡进项目：

| id | 用途 | 关键点 |
|---|---|---|
| `image.generate` | 画图 / 编图 | 命中 `imagegen`；从 `generated_images` 回收；落到 `assets/generated/` |
| `design.spec` | 功能与架构设计 | 要求决策完备、可评审；只读沙箱；输出方案而非代码 |
| `code.review` | 代码评审 | 只读；按严重度排序；必须给文件与行号 |
| `art.assets` | 美术素材批产 | 先定风格锚点再逐项出图，强制风格一致 |

复制后即为**项目文件**，包升级不会覆盖。想重置就删掉重新播种。

种子横幅写在**正文开头**而非 frontmatter 之前——写在前面会让整张卡解析失败（§9.1 H-2）。

### 4.4 路由

`codex_do` 的匹配打分：`id` 逐字出现 +10；`triggers` 命中 +6；`title` 词命中 +3；`description` 词命中 +2。

- 最高分与次高分**相等** → 判定歧义，拒绝执行并要求明确指定。
- **完全没有命中 → 拒绝执行**，返回完整目录。

拒绝是有意的：猜测路由会产生「看起来成功、其实答非所问」的结果，且难以复现。

---

## 5. 项目注册与 `.codex` 项目信息

### 5.1 Codex 的项目级机制（实测）

| 事实 | 证据 |
|---|---|
| 项目级配置在项目内 `.codex/config.toml` | Codex 自身指引文本：*"Project `.codex/config.toml`: settings for a trusted repository, including sandbox, MCP, hooks, model, and reasoning defaults"* |
| 项目配置结构只有一个字段 | `struct ProjectConfig with 1 element` → `trust_level` |
| 注册表路径 | `projects."<路径>".trust_level` |
| 项目根边界可配置 | `project_root_markers`，默认示例 `project_root_markers = [".git"]` |
| 指令文件 | `AGENTS.md` |
| 指令预算与回退名 | `project_doc_max_bytes`、`project_doc_fallback_filenames` |
| 项目级 hook / agents / skills | `.codex/hooks`、`.codex/agents`、`.codex/skills` |

### 5.2 信任门禁：A/B 对照实测

探针手法：在项目 `.codex/config.toml` 写入 `model = "PROJECT-CONFIG-PROBE-ZZZ"`（故意不存在的模型），观察 `codex exec` 运行头部实际使用的 model。

| cwd | 项目 config | 信任状态 | 实际 `model:` |
|---|---|---|---|
| neutral | 无 | — | `gpt-6-astra` |
| ctrl | 有（无害键） | 不可信 | `gpt-6-astra` |
| proj | `model = "PROBE-ZZZ"` | **不可信** | **`gpt-6-astra`** ← 项目配置被忽略 |
| proj | 同上 | **已标记 trusted** | **`PROJECT-CONFIG-PROBE-ZZZ`** ← 生效 |

第四行拿到确证：服务端直接拒绝了该假模型（`not supported when using Codex with a ChatGPT account`）。

**结论：信任门禁对非交互 `codex exec` 同样生效。**

### 5.3 门禁的作用域：`AGENTS.md` 不受影响

在**仍然不可信**的项目里，往 `AGENTS.md` 写入自定义规则后提问，agent 准确答出了规则中的标记值。

| 机制 | 受信任门禁约束？ | 能交付什么 |
|---|---|---|
| 根 `AGENTS.md` | **否，始终生效** | 项目知识、约定、能力说明 —— **零门槛** |
| `.codex/config.toml` | **是，不可信则完全忽略** | 只用于执行策略 —— 需要显式授权 |

**这条分工决定了注册策略的重心**：注册的主要价值不需要任何授权就能兑现，`config.toml` 只承载薄薄一层执行策略，缺授权时如实标注 `configEffective: false`，不假装生效。

### 5.4 为什么必须显式写项目根标记

`project_root_markers` 默认是 `[".git"]`。因此：

- 工作区是 git 仓库 → 根边界天然正确。
- 工作区**不是** git 仓库 → 向上找不到 `.git`，项目根无法确定，`AGENTS.md` 与项目配置的生效范围不可预期。

对策是注册时写入：

```toml
project_root_markers = [".git", ".codex"]
```

保留 `.git` 在前（有 git 时行为与默认一致），追加 `.codex` 作为兜底锚点。**这才是「注册为 Codex 项目」在实现层真正需要的动作**——不是写个清单文件，而是给出可靠的根边界。

### 5.5 文件所有权（最重要的安全约束）

根 `AGENTS.md` **同时是 DSH 自己的指令来源**（host 组合的 `agent-instructions` 行会读它）。实测确认：本仓库注册后生成的 `AGENTS.md` 被 DSH 自己加载进了系统提示词。因此改写它等于**静默改掉 DSH 的行为**。

所有权规则：

| 文件 | 所有者 | 控制器行为 |
|---|---|---|
| 根 `AGENTS.md` | **用户** | **存在则绝不修改**；仅在不存在时创建，只写指针 |
| `.codex/config.toml` | **Codex / 用户** | **已存在则完全不动**（含 `project_root_markers` 补写） |
| `.codex/skills`、`.codex/hooks`、`.codex/agents` | 用户 | 视为用户资产，不改动 |
| `.codex/project/`、`.codex/dsh/` | 控制器 | 自由读写 |
| `.dsh-codex/` | 控制器 | 自由读写 |

外来 `.codex/`（非本工具创建）需 **显式 `adopt: true`** 才写入。

### 5.6 注册流程

```
① 探测形态：git 仓库 / 非 git / 已有外来 .codex/
② 确立所有权（必须在任何 .codex/ 写入之前，见 §9.1 H-3）
③ 播种能力卡
④ 补写 project_root_markers（仅当我们创建该文件）
⑤ 生成项目画像：PROJECT.md / CAPABILITIES.md / HISTORY.md
⑥ 创建 AGENTS.md（仅当不存在）
⑦ 报告可信状态：configEffective，并在缺失授权时说明如何申请
```

幂等：可重复执行，结果一致，用户内容不被覆盖。失败安全：任一步失败只记 warning，不阻断本次调用——项目信息是增强，不是前置条件。

### 5.7 写入用户级配置的规则

1. **默认不写**。注册流程自身绝不静默修改用户级配置。
2. **需要时显式请求**：经宿主审批通道请求授权；**没有审批通道就拒绝**并给出手工条目。
3. 写入前备份、写入后校验、失败即还原。
4. 条目格式照抄 Codex 自身写法（实测自用户既有配置）：

```toml
[projects.'f:\deepseekproject\dsh-codex-controller\dsh-codex-connector']
trust_level = "trusted"
```

即**单引号字面量键 + 小写 Windows 路径**。

5. **先查祖先覆盖**：既有配置里存在父子两条条目，说明信任按路径逐条记录且**父目录条目可覆盖子目录**。已覆盖时不再写冗余条目。
6. 写入与撤销对称。

---

## 6. 自扩展闭环

```
① codex_do 未命中
② 先查：codex_capabilities(query) + 让 Codex 自报可用 skill 清单
③ 分类：(a) 已有对应 skill → 写薄封装卡；(b) 没有 → 卡内直接写 prompt 级流程
④ codex_skill_write 落盘（项目级）
⑤ codex_skill_verify：零成本预检 → 一次真实受限调用
⑥ 下次同类任务直接命中
```

### 防劣化护栏

| 护栏 | 机制 |
|---|---|
| 同名覆盖而非堆积 | 能力按 `id` 唯一；重复 id 会被**报告并丢弃后定义**，不让目录顺序决定行为 |
| 先查后写 | 已存在的卡必须显式 `overwrite: true` 才能改，逼迫先读 |
| 写后必验 | 新卡初始状态为 `draft`；未通过验证不参与 auto 路由 |
| 连续失败降级 | 连续失败达 3 次自动转为 `needs-review`，`mode=auto` 不再选它 |
| 变更留痕 | `.codex/project/HISTORY.md` 追加每次运行；`runs/<id>/` 保留完整原始事件 |

### 验证的分两段

`codex_skill_verify` 先做**零成本预检**（校验必填输入与占位符渲染），再花一次真实调用。这样坏的卡会立刻报错，而不是等两分钟才发现输入缺失。

---

## 7. 接口

### 7.1 工具面

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `codex_status` | 健康检查：定位到哪个二进制、版本、是否登录、卡数量与健康度、项目是否注册/可信 | `workspace?` |
| `codex_project` | `status` / `register` / `refresh` / `grant-trust` / `revoke-trust` | `action` `adopt?` `force?` |
| `codex_capabilities` | 列出 / 按关键词排名 / 按 id 读取 | `query?` `id?` |
| `codex_skill_write` | 新增或修订能力卡 | `id` `content?` `fields?` `overwrite?` |
| `codex_skill_verify` | 零成本预检 + 一次真实受限调用 | `id` `probeInputs?` |
| `codex_do` | 执行入口：给能力 id 或自然语言任务 | `task` `capability?` `mode?` `inputs?` `sandbox?` `continueThread?` `timeoutMs?` |

### 7.2 执行契约

```
① 预检：定位二进制 + 确认已登录；失败给出可执行的修法而非堆栈
② 解析能力：明确 id 直接用；否则按 §4.4 打分路由；未命中则拒绝
③ 渲染 prompt：卡片正文 + inputs 占位 + 运行上下文
   必填缺失或占位符未填 → **立刻失败**，不把半成品送出去
④ 执行：subprocess.spawn({
     argv: [codex, 'exec', '--json', '--skip-git-repo-check',
            '-s', sandbox, '-C', cwd, '-m', model?, '-o', lastMessageFile,
            ...(resumeThreadId ? ['resume', resumeThreadId] : [])],
     stdio: { stdin: { data: prompt },   # prompt 走 stdin：避开 Windows 参数
                                          # 长度/引号问题，也不进进程表
              stdout: {maxBytes, spill}, stderr: {maxBytes, spill} },
     cwd: <工作区>, env: <白名单收敛>
   })
⑤ 消费事件：按 §1.5 逐行容错；只有 `turn.completed` 且无真实错误才算成功
⑥ 回收制品：快照 diff + agent 回报路径交叉校验
⑦ 回传：{ ok, summary, artifacts, runId, threadId, usage, sandbox, warnings }
```

**成败判定**（三条都必须成立）：

1. 事件流出现 `turn.completed`；
2. 没有**真实错误**（按 §1.5 的语义分类，传输告警不算）；
3. **进程没有被超时杀掉**。

第 3 条是必需的：超时按墙钟触发，事件流里可能已经出现较早阶段的 `turn.completed`，只看事件流会把被截断的运行报成成功。

### 7.3 依赖策略：零运行时依赖

能力卡解析器（frontmatter）与工具参数 schema 编译器都由本项目自带。原因：

- 包需要能在 profile 的模块解析环境里**确定地**加载，不因缺一个依赖而整行挂掉。
- 自研解析器能**拒绝**不支持的结构，而不是静默接受；这对驱动外部 agent 的文件尤其重要。

工具参数**自己编译成原始 JSON Schema** 后注册，不依赖宿主 SDK 的编译入口——因为两者是不同方言，混淆会导致注册期或调用期才报错。

### 7.4 二进制定位（有序探测，绝不硬编码）

```
① 用户显式配置（config.json 的 codexBinary）    ← 最高优先级
② 用户级 Codex 配置里的 CLI 路径线索
③ %LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe（取最新）
④ %CODEX_HOME%\plugins\.plugin-appserver\codex.exe
⑤ PATH 上的 codex
```

实测命中第 ② 条。每一条的尝试结果都会记录在 `codex_status` 的 `probes` 里，便于排错。

### 7.5 环境收敛

Codex 是一台会执行命令的外部 agent。默认**不把宿主完整环境**交给它——白名单放行 `PATH`、`SystemRoot`、`TEMP`、`USERPROFILE`、`CODEX_HOME` 等必要项，其余剔除。实测一次调用抑制了 **51** 个无关变量，其中包含形如凭据的键。

### 7.6 挂载方式与 patch 层语义

本插件以 **host 面的一行**挂进 profile 的 patch 层（profile 自有层，不改动任何 shipped 组合）。加载器对 patch 条目的语义是二选一的，**写错不会报错、只会静默跳过**：

| 写法 | 含义 |
|---|---|
| `- insert:` 包裹 | **新增**行；包裹层不带 `id` 时，把内部行追加到根列表 |
| 顶层 `- id: <x>` | **覆盖既有行**；`x` 必须已存在，否则打印 `patch: entry "<x>" not found` 并跳过 |

因此新增行必须写成：

```yaml
- insert:
    - id: tool-codex-connector
      name: 'dsh-codex-connector'
```

行上**不挂 `config`**：把 `defaultWorkspace` 钉成宿主进程的 cwd 会让每次调用都针对「DSH 恰好在哪个目录启动」而不是调用方会话的工作区。工具从自己的调用上下文解析工作区，只有在无人提供时才回退到进程 cwd。

**判定是否真的进了组合，不能看配置文件，要看组合结果**：

```bash
dsh --profile web --dump-config
```

它会打印**组合后**的树。能搜到该行、且开头没有 `patch: entry ... not found` 警告，才算生效。直接读 `cordis.patch.yml` 会给出假阳性——文件里明明写着，组合时却被跳过了。

**模块解析基准**：加载器把 `baseUrl` 锚定在 profile 目录，因此包需要能从 `<profile>/node_modules` 解析到。安装脚本走 `link:` 依赖 + `pnpm install` 建 junction，使仓库改动即时生效而无需重新打包。

### 7.7 并发

同一 `CODEX_HOME` 内有多个 sqlite（含 `-wal`/`-shm`）。默认**同一工作区串行**，并发上限可配；疑似锁冲突按瞬态处理并重试。

---

## 8. 制品回收

三重手段，因为它是最容易出错的一环：

1. **不是从 thread_id 推路径**。§1.3 已实测目录名与 thread_id 不同。
2. **运行前后目录快照 diff**，只收「本次新增或变化」的文件。
3. **采纳 agent 在最终消息里回报的绝对路径**作为交叉校验（实测可靠）。

落盘规则：默认复制到能力卡声明的 `collectTo`；不覆盖同名文件，冲突时加 `-v2` 后缀。

**`collectTo` 视为不可信输入**：它来自能力卡，而能力卡由用户与自扩展的 agent 共同产生。实测 `collectTo: "../../escaped"` 会把文件写到工作区外，因此实现里做包含性断言，越界即拒绝并告警。

---

## 8.1 工具边界契约（无损 JSON）

工具返回值必须是**无损 JSON**：宿主校验器拒绝任何无法在一次 JSON 往返中存活的值。规则比「不能有 `undefined`」严格得多，实现与测试都按校验器的**真实规则**对齐：

| 值 | 是否可跨越边界 | 本项目的处理 |
|---|---|---|
| `string` / `boolean` / `null` | 可以 | 原样 |
| 有限数、且不是 `-0` | 可以 | 原样（`-0` 会被校验器拒绝，转为 `null`） |
| `NaN` / `±Infinity` | 不可以 | 转为 `null` |
| `undefined` / 函数 / symbol | 不可以 | 对象里**丢弃该键**（写成 `null` 会谎称「已知为空」）；数组里转为 `null` 以保长度 |
| `bigint` | 不可以 | 转为 `number` |
| `Date` | 不可以（非平凡对象） | 转为 ISO 字符串 |
| 带额外自有属性的数组 | 不可以 | 重建为纯数组 |
| 循环引用 | 不可以 | 打断并标记 `"[circular]"`，不丢弃整个结果 |

**为什么必须放在工具边界统一处理**：worker 结果里 `undefined` 出现在若干诚实的位置——未返回的 `threadId`、制品回收被拒后没有目标目录、尚无健康记录的卡片。任何一处都会让整个结果不可表示，而失败发生在**工作已经完成之后**。

**这条报错误导性极强**：`returned invalid output: value is not lossless JSON` 指向输出层，但实际原因可能是**参数必填性写错**（§9.1 L-6）。因此验证必须同时覆盖参数与返回值两层，且要对着宿主**真实校验器**跑（见 §10）。

---

## 9. 自审记录

### 9.1 已修复的缺陷（全部有回归测试守护）

| # | 严重度 | 缺陷 | 发现方式 | 修法 |
|---|---|---|---|---|
| H-1 | 高 | **超时被上报为成功**：spawn 在超时时 resolve，而判定只看事件流；事件流里已有 `turn.completed` 时会把被截断的运行报成 `ok:true` | 对抗审查（用假 spawn 复现） | 成败判定加入「未被超时杀掉」，并在 warning 里说明结果可能被截断 |
| H-2 | 高 | **种子卡全部解析失败**：种子横幅被放在 frontmatter 的 `---` 之前，导致目录计数为 0 | 真实链路自测 | 横幅移入正文开头；加回归测试断言每张种子卡可解析 |
| H-3 | 高 | **自我死锁**：运行副作用会先创建 `.codex/`，而当时尚无所有权标记；下次注册把自己的目录判成「外来」并冻结 | 真实链路自测 | 所有权在**任何** `.codex/` 写入之前确立；所有权判定改为多信号 |
| H-4 | 高 | **所有权判定可被用户合法文件触发**：只查存在性或子串，用户自建的 `notes.md`、`{}` 的 `binding.json`、仅引用了标记串的文档都会让判定为真，从而跳过接管确认**直接写入用户的目录** | 对抗审查 | 改为**内容校验**：所有权记录的 `managedBy` 必须匹配；标记必须出现在**文件首行** |
| H-5 | 高 | **`collectTo` 可逃出工作区**：无包含性校验，实测把文件写到了工作区外 | 对抗审查 | 包含性断言 + 越界即拒绝并告警 |
| M-1 | 中 | **传输告警被当成失败**：一条成功的 118 秒运行因为事件流里有 5 条传输告警（其中一条是 item 形态）而被报成失败 | 真实链路自测 | 按**语义**分类：重连/回退类归 warning，模型或请求拒绝类归真实错误 |
| M-2 | 中 | **`grant-trust` 无审批闸门**：单次工具调用即可改写用户级配置 | 对抗审查 | 经宿主审批通道；无通道则拒绝并给出手工条目 |
| M-3 | 中 | **参数 schema 编译器静默丢键**：`default`、`minLength`、`oneOf` 等被无声丢弃，其中 `oneOf` 会退化成「任意 JSON」 | 对抗审查 | 未知键一律**报错**；`required` 非布尔也报错 |
| M-4 | 中 | **`revoke-trust` 硬编码成功**：实际没删到任何条目时仍返回成功 | 对抗审查 | 返回值反映是否真的发生变更 |
| M-5 | 中 | **危险沙箱授权边界写反**：守卫条件恒假，等于从不拦截 | 自测发现 | 只有调用方**显式传参**才授权；能力卡默认值不构成授权 |
| L-1 | 低 | 重复的能力卡 id 静默遮蔽，路由结果取决于目录顺序 | 对抗审查 | 报告并丢弃后定义 |
| L-2 | 低 | 新卡初始状态为「已验证」，会被 auto 路由选中 | 对抗审查 | 初始为 `draft`，通过验证才离开 |
| L-3 | 低 | 序列化器对多行值产出自身解析器读不回的卡 | 对抗审查 | 直接拒绝多行值 |
| L-4 | 低 | 工具参数以错误方言传入，注册期不报错、调用期才炸 | 自查 | 自行编译成原始 JSON Schema 后注册 |
| **L-5** | **高** | **patch 行被静默跳过**：新增行写成了顶层 `- id: <row>`，而加载器把「不带 `insert` 的条目」一律理解为**覆盖既有行**，于是打印 `patch: entry "<row>" not found` 后整行跳过。插件从未挂载，但配置文件看起来「明明写了」 | 用户重启后反馈「插件列表里看不到」 | 新增行必须用 `- insert:` 包裹；验证脚本改为检查**包裹结构**而非仅检查 id 是否存在（旧的弱检查在错误格式下也会通过） |
| **L-6** | **高** | **返回值含 `undefined` 导致工具调用在完成工作后被拒**：报错是 `returned invalid output: value is not lossless JSON`，但它**指向错误的层**——同一句报错也可能由「参数被错标为必填」触发。真实原因有两个：(a) worker 结果里 `threadId` / `destRoot` / `usage` 等诚实位置为 `undefined`；(b) `codex_do` 把 `task` 声明为必填，而 `{ capability, inputs }` 是合法调用（卡片自带任务文本） | 用户在真实 DSH 实例里调用时触发 | (a) 在工具边界统一净化，规则按宿主校验器**逐条对齐**（含 `-0`、带额外自有属性的数组、循环引用）；(b) `task` 改为可选，缺任务文本时的规则由路由层执行。新增 `verify-boundary` 对着宿主**真实校验器**同时验证参数与返回值两层 |

### 9.2 未验证 / 受限的项（不声称结论）

| 项 | 状态 |
|---|---|
| `codex exec` 自主写 trust 条目的触发条件 | 现象三次复现，**触发条件未知**。实现上每次现读、不缓存 |
| 超时后孙进程是否残留 | **未实测**（沙箱限制），只按实现推断 |
| `handle.done` 在终止后永不 settle 的场景 | 用假句柄验证了清理路径；真实 provider 挂住会让适配器一直 pending —— **推断，未复现** |
| 子 Node 执行外壳 | 在受限沙箱下不可用（`spawn EPERM`）；宿主组件路径不受影响 |

### 9.3 方法论教训

1. **命令成功返回 ≠ 测试有效。** 首轮探针返回 `exit=0` 但结论完全无效——执行目录不是我以为的那个（宿主 shell 的工作目录切换因临时目录路径不匹配而失败）。判定必须让运行日志**自证**（当时靠日志里的 `workdir:` 与 `model:` 字段才发现）。
2. **不实测就不会知道的那类问题最危险。** H-1、H-2、H-3、M-1 都只有真实跑一次才会暴露；纯读代码或纯离线测试全部漏过。
3. **测试数据本身会骗人。** 有一条回归测试因为字符串转义写错，导致被测的那行根本不是合法 JSON，于是「致命错误」从未进入解析器——失败的是探针，不是解析器。
4. **审查者要拿到固定的基准。** 审查期间源码被实时修改，导致审查者的结论一度基于过期版本，只能区分「已修」与「仍存在」两批报告。改动活跃时应先冻结再审查。

---

## 10. 验证方式

```bash
npm run selftest         # 60 项离线检查：不联网、不调用 Codex
npm run live-check       # 真实端到端（每次 2 分钟起）
npm run verify-install   # 安装是否真的生效（在该 profile 目录里跑）
npm run verify-boundary  # 对着宿主真实校验器验证参数与工具返回值
```

`live-check` 的开关：

```bash
node scripts/live-check.cjs --quick        # 仅定位/鉴权/注册/路由，不调用 Codex
node scripts/live-check.cjs --with-image   # 额外验证出图与制品回收
node scripts/live-check.cjs --workspace <dir>
```

`verify-boundary` 可加 `--live` 跑一次真实出图：

```bash
node scripts/verify-boundary.mjs --live
```

它需要已安装的 Profile（从那里加载宿主校验器），验证两层：

1. **参数**：注册的 `parameters` 是合法 JSON Schema，且没有把可选参数错标为必填。
2. **返回值**：每个 worker 的真实结果都能通过宿主的无损 JSON 校验。

**为什么必须单独有它**：§9.1 L-6 的报错指向输出层，真实原因却在参数层。只有对着**宿主真实校验器**跑，才能区分这两层。离线自测只能复刻规则、不能证伪。

实测结果：

| 套件 | 结果 |
|---|---|
| 离线自测 | **60 / 60** |
| 真实端到端（含出图并回收 PNG） | **9 / 9** |
| 注册与路由（quick） | **5 / 5** |
| 边界（参数 + 返回值，宿主真实校验器） | 全部通过 |
| 真实实例内工具调用 | `codex_status` / `codex_capabilities` 通过 |

离线自测覆盖了一批评审与实测回归：种子卡 frontmatter 完整性、运行副作用导致的自我死锁、用户文件冒充所有权、制品路径逃逸、超时误判为成功、工具返回值含 `undefined`、危险沙箱授权边界、重复 id、新卡状态、多行序列化。

**一次值得记录的真实失败**：在某次网络严重劣化时（10 条传输重连），出图任务在 900 秒上限被终止。结果被正确判为 `ok=false` 并附「已终止、结果可能被截断」的告警——这既是网络现实，也是 §9.1 H-1 那条修复在真实环境里的验证：**被超时杀掉的任务不会被报成成功**。

---

## 11. 权限与安全边界

- **环境收敛**：白名单放行，实测抑制 51 个无关变量（含凭据形态的键）。
- **沙箱语义不改写**：只传递 `-s`。默认 `workspace-write`。
- **危险级需显式请求**：`danger-full-access` 写在能力卡里**不构成授权**，必须调用时显式传参。
- **不写用户级配置**：除经审批的 `grant-trust` 外，控制器不碰用户级 Codex 配置。
- **不覆盖用户文件**：`AGENTS.md` 与既有 `config.toml` 冻结；制品重名加版本后缀。
- **外来目录需确认**：非本工具创建的 `.codex/` 未经 `adopt` 不写入。
- **副作用可回收**：所有注册（service、工具）都由宿主 effect 持有，停止即撤销。
