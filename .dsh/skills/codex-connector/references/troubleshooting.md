# 排错

## 先跑诊断

```
codex_status
```

它会告诉你：二进制定位到哪个路径、**从哪条探测规则命中的**、版本、是否登录、能力卡数量、项目是否注册与可信。
多数问题看这一条输出就能定位。

---

## 症状 → 原因 → 处理

### `Codex CLI not found`

探测全部未命中。`codex_status` 的 `codex.probes` 会列出每条规则试过的路径。

处理：在 `<workspace>/.dsh-codex/config.json` 里显式指定：

```json
{ "codexBinary": "C:\\path\\to\\codex.exe" }
```

### `failed to initialize in-process app-server client: 拒绝访问。 (os error 5)`

**这是最重要的一条。** Codex 需要写自己的 `~/.codex`（app-server socket、`tmp/arg0*`、多个 sqlite），
而会话文件沙箱只放行工作区。升权后同一命令立刻成功（已实测）。

处理：
1. 确认插件在 **host 面**加载（`subprocess` 是宿主执行世界，不受会话文件沙箱限制）。
2. **不要**用会话里的 `pwsh` 直接调 `codex.exe` —— 那会撞同一个墙。
3. 若部署确实无法提供宿主执行，则只能整会话用 `danger-full-access`，这属于显式取舍。

### 运行明明成功，却报 `ok: false`

先看 `errors` 里的内容：

- 含 `WebSockets` / `Reconnecting` / `transport` → 传输通知被误判为失败。这是解析器的语义分类问题，已在包含 `classifyMessage` 的版本修复。升级即可。
- 含 `not supported when using Codex with a ChatGPT account` → 能力卡的 `model` 用了账号不可用的模型。**把卡片 `model` 留空**。
- 含 `timed out` → 提高 `timeoutMs`，或拆分任务。

### `configEffective: false`

项目级 `.codex/config.toml` **不生效**：Codex 对未标记可信的项目会完全忽略它（已实测 A/B 对照）。

关键区分：

| | 是否需要可信 |
|---|---|
| 项目**知识**（`AGENTS.md` / `.codex/project/`） | **不需要**，始终生效 |
| 项目**执行策略**（`.codex/config.toml`） | **需要** |

处理：如实告诉用户「项目知识已生效、执行策略未生效」。需要执行策略时显式授权：

```
codex_project { action: "grant-trust" }
```

这会在 `~/.codex/config.toml` 里加一条 `[projects.'<路径>'] trust_level = "trusted"`。
写入前备份、写入后校验、失败即还原；撤销用 `action: "revoke-trust"`。

### 出图成功但工作区看不到文件

1. 看 `codex_do` 返回的 `artifactSources` —— 那是 Codex 侧的原始位置。
2. 看 `.dsh-codex/runs/<runId>/result.json` 的完整记录。
3. 检查能力卡的 `artifacts.patterns` 是否匹配实际落点（默认应为 `$CODEX_HOME/generated_images/**/*.png`）。
4. 若 `warnings` 里出现 `artifacts: N file(s) could not be copied`，是复制阶段失败，看 `skipped` 里的原因。

> 注意：**不要**用 `threadId` 去拼产物路径。实测 `<run-dir>` 与 thread id 是两个不同的值。

### `检测到既有 .codex/ 目录（非本工具创建）`

该目录不是本工具创建的，控制器拒绝写入。确认内容后显式接管：

```
codex_project { action: "register", adopt: true }
```

接管后仍然**不会**改写既有 `config.toml` 的内容，也**不会**动既有 `AGENTS.md`。

### `capability "x" is marked needs-review`

该卡连续失败 3 次后被自动降级，`codex_do` 拒绝再自动选它（防止反复踩同一个坑）。

处理：`codex_capabilities { id: "x" }` 看它的健康计数 → 修卡 → `codex_skill_verify { id: "x" }` 复审。

### `capability is missing required input(s)` / `still has unfilled placeholder(s)`

卡片声明的必填参数没给，或正文里有占位符没填上。这是**有意的早失败**，避免把半成品 prompt 送出去。

处理：`codex_capabilities { id: "x" }` 看 `inputs` 声明，补齐参数；或修卡去掉多余占位符。

### `ambiguous: two capabilities scored equally`

两张卡打分相同，无法自动选。

处理：显式指定 `capability`。若长期歧义，说明两张卡的 `description`/`triggers` 区分度不够，应当修订。

### 每次调用都要 2 分钟以上

当前网络环境下 WebSocket 握手超时后回退 HTTPS，实测 118–126 秒/次，属于**正常现象**，不是故障。
`codex_status` 的 `codex.loggedIn` 与版本正常即可放心。

处理：长任务别在前台等；批量任务提前告知用户预期耗时。

### 重名产物变成了 `xxx-v2.png`

这是**设计行为**：控制器从不覆盖已有文件。若不想要版本后缀，先自行移动或删除旧文件。

---

## 仍然不行时，收集这些信息

```javascript
codex_status                                    // 定位、鉴权、目录、项目状态
codex_capabilities                              // 目录内容与每张卡的健康状态
// 最近一次运行的完整记录（原始事件流 + 结果 + 元数据）：
//   <workspace>/.dsh-codex/runs/<runId>/events.jsonl
//   <workspace>/.dsh-codex/runs/<runId>/result.json
//   <workspace>/.dsh-codex/runs/<runId>/meta.json
```

`events.jsonl` 是 `codex exec --json` 的**原始输出**，含有 Codex 侧的逐条事件，是判定问题根源最可靠的证据。
