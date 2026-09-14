---
name: codex-connector
description: 通过 dsh-codex-connector 调用 Codex 做事：用高级模型做功能/架构设计、用 imagegen 出图、批量产出项目美术素材、代码评审，以及为项目新增/修订 Codex 能力卡（自扩展）。当用户提到让 codex 画图、出素材、做设计、评审代码，或需要把某类任务交给 codex 时使用。
whenToUse: 用户要求 Codex 参与（设计、出图、素材、评审），或你判断某任务更适合交给 Codex 的模型/技能时。若只是常规编码与文件操作，不要用它。
---

# 使用 Codex 连接器

这个 Skill 教你**何时**以及**如何**把任务交给 Codex。执行入口是 `codex_do`，能力清单在项目的能力目录里。

## 先看有什么能力，再决定怎么做

调用 `codex_capabilities` 读当前项目的能力目录。**不要凭记忆假设某张卡存在**——能力卡是项目资产，每个项目的内容不同。

## 何时该交给 Codex

| 情形 | 用哪张卡 | 说明 |
|---|---|---|
| 画图、出插画/贴图/封面/mockup | `image.generate` | 走 Codex 内置 `image_gen`，不是调画图 API |
| 要一整套风格统一的素材 | `art.assets` | 一次会话多张，强制风格锚点 |
| 要一份可评审的功能/架构方案 | `design.spec` | 用 Codex 高级模型 + xhigh 推理；产出方案而非代码 |
| 评审改动 | `code.review` | 只读沙箱，给出按严重度排序的问题清单 |
| 用户的明确要求 | 按 `codex_capabilities` 结果 | 有卡就用卡，别手写 prompt |

**不该用的时候**：常规编码、文件读写、搜索、跑测试——这些你自己做更快。Codex 一次调用在当前网络下要 2 分钟起，别为小事付这个代价。

## 怎么调用

```
# 自动路由：把用户的自然语言需求直接交给它
codex_do { task: "<用户的原话或改写后的需求>" }

# 明确指定能力卡，并传卡片声明的参数
codex_do { capability: "image.generate", inputs: { prompt: "…", count: "2" } }

# 多轮协作：延续同一能力上一次的会话
codex_do { capability: "design.spec", continueThread: true, task: "把第 3 点展开" }

# 目录里没有合适的能力，且不值得建卡：直接把原始任务下发
codex_do { mode: "force", task: "…" }
```

## 无匹配时怎么办（重要）

`codex_do` 命中不了任何能力卡时**会拒绝执行**并返回目录清单。这不是故障，是刻意的设计——猜测路由会产生难以复现的错误结果。

此时你有三个选择，按优先级：

1. **先看是不是该用现有卡**：`codex_capabilities { query: "<任务描述>" }` 看排名与命中理由；命中分低可能是你措辞和卡片 `triggers` 不匹配。
2. **确认确实缺能力** → 走下面的自扩展流程建卡。
3. **一次性任务、不值得建卡** → `mode: "force"` 直接下发。

**不要**为了绕过拒绝而改用 `pwsh` 直接跑 `codex exec`：那样会绕开制品回收、事件解析、项目注册与并发控制，而且会被文件沙箱拦住（见下）。

## 自扩展：新增一张能力卡

当某类需求反复出现、而目录里没有对应能力时，建卡让它变成可复用能力。

```
① 先查重
   codex_capabilities { query: "<需求关键词>" }

② 确认 Codex 侧是否已有可用资产
   - 让 Codex 自己报一遍：codex_do { mode: "force", task: "列出你当前可用的全部 skill 名称，每行一个" }
   - 若已有对应 skill → 只需写一张薄封装卡，在 skills 字段里点名它
   - 若没有 → 卡里直接写 prompt 级流程

③ 写卡（见 references/capability-authoring.md 的字段说明与范例）
   codex_skill_write { id: "<slug>", content: "<完整 markdown>" }

④ 验证（必做）
   codex_skill_verify { id: "<slug>" }
   通过 → 卡片离开 draft，之后可被 auto 选中
   失败 → 读诊断（模型不可用 / skill 不存在 / 超时）→ 修卡 → 重试

⑤ 报告给用户：新增了什么能力、验证证据（runId / 耗时 / 产物路径）
```

护栏（系统已强制，你只需知道）：

- 同名 id 是**修订**而非新建，不会堆积近似卡片。
- 覆盖已有卡必须显式 `overwrite: true`——逼迫先读后写。
- 未验证的卡是 `draft`；连续失败 3 次自动降级 `needs-review` 并退出 auto 选择。

## 结果怎么用

- **产物只以路径回传**，正文不入上下文。图片要判断质量时用 `read_image` 自己看。
- `codex_do` 返回 `artifacts`（已回收到工作区的绝对路径）与 `artifactSources`（Codex 侧的原始位置）。
- 返回里的 `warnings` 要读：里面会有传输重试、被抑制的环境变量、跳过的制品等。
- `threadId` 记下来，需要多轮时配合 `continueThread` 使用。

## 常见失败

见 `references/troubleshooting.md`。最常遇到的两条：

1. **`os error 5` / `拒绝访问`** —— 说明执行没走宿主侧通道，被文件沙箱拦了。让用户确认插件在 host 面加载，**不要**试图用 `pwsh` 绕过。
2. **`configEffective: false`** —— 项目未被标记为可信，项目级执行策略不生效。**项目知识仍然生效**，如实告知用户即可，不要谎报已生效。
