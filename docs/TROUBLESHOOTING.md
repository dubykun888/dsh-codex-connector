# 排障手册

遇到问题时的**逐步诊断流程**。用户主指南见 [`../README.md`](../README.md)，代码层面的坑见 [`DEVELOPMENT.md`](./DEVELOPMENT.md)。

> 阅读顺序建议：先做 §1 的三步体检，多数问题在那里就能定位。

---

## 1. 三步体检

### 第一步：连接器本身健康吗

让 DSH 跑：

```
codex_status
```

看四个关键字段：

| 字段 | 期望 | 不对时说明 |
|---|---|---|
| `codex.found` | `true` | 找不到 Codex，见 §2 |
| `codex.source` | `path` | 若是 `codex-config-hint` 或 `desktop-bin`，说明用的是**桌面端捆绑版**而非你装的独立 CLI，见 §3 |
| `codex.loggedIn` | `true` | 未登录，终端跑 `codex login` |
| `catalog.count` | ≥ 1 | 能力卡没加载，见 §6 |

### 第二步：Codex 自己能跑吗

在终端（不是 DSH 里）：

```bash
codex --version
codex login status
codex doctor --summary
```

`doctor` 里重点看两行：

- `reachability` —— 能不能连上推理端点
- `websocket` —— WebSocket 握手是否超时（超时后回退 HTTPS，慢但可用）

### 第三步：网络通吗

```powershell
Test-NetConnection chatgpt.com -Port 443
```

TCP 不通 → 连接器无能为力，问题在网络层。

---

## 2. 找不到 Codex CLI

`codex_status` 会返回 `codex.probes`，列出**每一条探测规则试过的路径**。对照它就能知道为什么没命中。

### 探测顺序

```
① 用户显式配置（.dsh-codex/config.json 的 codexBinary）
② PATH 上的 codex
③ 用户级 Codex 配置里的 CODEX_CLI_PATH（桌面端捆绑版）
④ %LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe
⑤ %CODEX_HOME%\plugins\.plugin-appserver\codex.exe
```

### 处理

最省事的办法是**显式指定路径**。在项目里建 `.dsh-codex/config.json`：

```json
{
  "codexBinary": "C:\\完整\\路径\\codex.exe"
}
```

注意 JSON 里反斜杠要写两次。

---

## 3. 用的是桌面端版本，不是独立 CLI

**现象**：`codex_status` 的 `codex.source` 显示 `codex-config-hint` 或 `desktop-bin`，而 PATH 上其实装了独立 CLI。

**原因**：桌面端会把自己的捆绑 CLI 路径写进 `CODEX_CLI_PATH`。当前版本的探测顺序把 PATH 排在它**之前**，所以正常情况不会出现这个现象——如果出现了，说明：

1. PATH 上找不到 `codex`（没装独立 CLI），或
2. 运行中的 DSH 进程还是旧版本代码（需要重启）

**确认两者版本是否不同**：

```bash
codex --version                                                    # 独立 CLI
& "$env:LOCALAPPDATA\OpenAI\Codex\bin\<哈希>\codex.exe" --version   # 桌面端捆绑
```

实测这两个可能是**不同构建**（例如 0.155.1 与 0.154.0-alpha.6.2）。

**处理**：装上独立 CLI（`npm i -g @openai/codex`），然后重启 DSH。

---

## 4. `failed to initialize in-process app-server client: 拒绝访问。 (os error 5)`

Codex 需要写自己的 `~/.codex`（app-server socket、临时目录、多个 sqlite 库），而 DSH 的会话文件沙箱只放行工作区。

**这个错误说明执行没有走宿主侧通道。**

处理：

1. 确认插件挂在 **host 面**（默认安装就是这样）。
2. **不要**在会话里用 shell 直接调 `codex.exe`——那会撞同一堵墙。
3. 如果确认插件已正确挂载仍然报错，说明该部署的宿主执行世界不可用，这属于环境限制。

---

## 5. 出图成功但项目里没有文件

按顺序查：

1. `codex_status` 是否正常
2. 运行记录：

```
<你的项目>/.dsh-codex/runs/<运行ID>/result.json
```

重点看三个字段：

| 字段 | 含义 |
|---|---|
| `artifacts` | 最终交付物的绝对路径（应指向你的工作区） |
| `recovered` | 连接器**补收**的文件；为空说明 Codex 自己放好了 |
| `artifactSources` | Codex 侧的原始位置 |

3. 核对能力卡的 `artifacts.patterns` 是否匹配实际落点（默认应为 `$CODEX_HOME/generated_images/**/*.png`）。
4. 看返回值里的 `warnings`，如果有 `artifacts: N file(s) could not be copied`，说明是复制阶段失败。

**注意**：不要试图用 `threadId` 去拼产物路径。实测产物目录名与 thread id 是**两个不同的值**。

---

## 6. 能力卡没加载 / 数量不对

```
codex_capabilities
```

看 `invalid` 字段——解析失败的卡会连同**具体问题**列在那里。

常见原因：

| 原因 | 表现 |
|---|---|
| 用 tab 缩进 frontmatter | 解析失败 |
| 缺 `id` 或 `description` | 校验不通过 |
| `sandbox` 值拼错 | 校验不通过 |
| 两个文件用了同一个 `id` | 后者被报告并忽略 |
| 正文占位符没有对应的 `inputs` | 调用时立刻失败 |

**能力卡文件必须以前三个短横线开头**：

```markdown
---
id: my.capability
description: ...
---
```

如果被复制进项目时带了横幅注释，横幅会在**正文开头**——写在 frontmatter 之前会让整张卡失效。

---

## 7. 报 `value is not lossless JSON`

这条报错**指向错误的层**，要小心。

它的字面意思是「工具返回值无法无损序列化」，真实原因有两种：

1. 返回值里确实有 `undefined`（当前版本已在工具边界统一处理）
2. **参数被声明为必填，而调用方合理地省略了它**

第二种正是 `codex_do` 曾经的问题：`task` 被列为必填，导致 `{ capability, inputs }` 这种完全合法的调用被拒，而报错却指向输出层。

**处理**：升级到包含该修复的版本。维护者可用 `npm run verify-boundary` 对着宿主**真实校验器**复现并区分这两层。

---

## 8. 插件重启后不出现

### 先看组合结果，而不是配置文件

```bash
dsh --profile web --dump-config | Select-String 'tool-codex-connector'
```

- **能搜到、且开头没有警告** → 已进入组合
- **搜不到，或出现 `patch: entry "tool-codex-connector" not found`** → 行格式写错了

### 行格式为什么容易写错

| 写法 | 含义 |
|---|---|
| `- insert:` 包裹 | **新增**一行 |
| 顶层 `- id: <x>` | **覆盖既有行**，该行必须已存在 |

写成顶层 `- id:` 时，加载器以为你要覆盖一个不存在的行，打印警告后**整行跳过**——插件不挂载，而配置文件看起来「明明写了」。

正确写法：

```yaml
- insert:
    - id: tool-codex-connector
      name: 'dsh-codex-connector'
```

重新跑一次安装脚本即可修正。

### 插件出现了但会话里没有工具

patch 挂的是 **service 层**（host 面），工具行属于 **agent 面**，需要加到预设上：

```bash
node scripts/install.mjs --profile web --preset standard --apply
```

之后用该预设新建会话。

### `--dump-config` 报 `EPERM ... cordis.yml`

它会重写 profile 的根文件。在受限沙箱里会失败——**这不是配置错误**，用有权限的终端跑即可。

---

## 9. 每次都跑到超时

**先区分是「慢」还是「不通」。**

### 慢（正常）

实测基线：单次调用 **118–126 秒**；出图约 **3–4 分钟**；批量按张数线性增长。日志里有若干条 `Reconnecting…` 属正常——WebSocket 握手超时后回退 HTTPS。

### 不通（异常）

**症状**：每次调用都跑满 `timeoutMs`，伴随**大量**重连（例如 10 条），且任务是「回一个单词」这种极简请求也超时。

**诊断**：

```bash
codex doctor --summary
```

看 `reachability` 与 `websocket`。再在终端直接测：

```powershell
Test-NetConnection chatgpt.com -Port 443
```

**TCP 不通就是网络问题**，连接器无能为力。需要检查代理、VPN、防火墙、DNS。

> 注意：在受限沙箱里跑的连通性测试可能给出**假阴性**。以 `codex doctor` 的判断为准。

### 超时的行为是正确的

被超时杀掉的任务会报 `ok: false` 并附「已终止、结果可能被截断」的告警——**不会被当成成功**。这是刻意的。

处理：提高 `timeoutMs`，或把任务拆小。

---

## 10. `configEffective: false`

项目级 `.codex/config.toml` **不生效**：Codex 对未标记可信的项目会完全忽略它。

**关键区分**：

| 内容 | 是否需要可信 |
|---|---|
| 项目**知识**（`AGENTS.md` / `.codex/project/`） | **不需要**，始终生效 |
| 项目**执行策略**（`config.toml`） | **需要** |

**处理**：需要执行策略时显式授权：

```
codex_project { action: "grant-trust" }
```

它会先征求同意，写入前备份、写入后校验、失败即还原。撤销用 `action: "revoke-trust"`。

若返回 `no-approval-channel`，说明该部署没有审批通道。按提示手工在 `~/.codex/config.toml` 加入：

```toml
[projects.'f:\your\project']
trust_level = "trusted"
```

路径用小写、单引号包裹（这是 Codex 自己写条目的格式）。

---

## 11. 能力卡处于 `needs-review`

某张卡连续失败 3 次后被自动降级，`codex_do` 拒绝再自动选它——这是防止反复踩同一个坑的护栏。

**处理**：

```
codex_capabilities { id: "那张卡的id" }     # 看健康计数
codex_skill_verify { id: "那张卡的id" }     # 复审
```

复审分两段：先做**零成本预检**（校验必填输入与占位符），再花一次真实调用。预检失败会立刻返回且**不会调用 Codex**。

若复审也失败，诊断会告诉你原因（模型不可用、skill 不存在、超时等），据此修卡。

---

## 12. 制品出现重复或多余文件

**当前版本应当不会出现。** 如果出现，说明运行的可能是旧代码——重启 DSH 后再试。

已知的两种历史表现：

| 表现 | 原因 |
|---|---|
| 工作区出现两个同字节的 PNG（一个语义名、一个哈希名） | 旧版本会无条件把 Codex 侧源文件再复制一份 |
| 工作区文件数多于清单项数 | 旧版本会把**重试后放弃的变体**也导入 |

两个都已修复：agent 已自行放置文件时不再重复导入；未被选中的源视为草稿跳过。

---

## 13. 收集诊断信息

问题无法自行解决时，把这些交给维护者：

```javascript
codex_status          // 定位、鉴权、能力卡、项目状态
codex_capabilities    // 目录内容与每张卡的健康状态
```

以及运行记录目录：

```
<你的项目>/.dsh-codex/runs/<运行ID>/
├── meta.json       本次运行的元数据
├── events.jsonl    Codex 的**原始**输出（逐条事件，最可靠的事实来源）
├── result.json     结构化结果
└── last-message.txt
```

**`events.jsonl` 是最有价值的证据**——它是 `codex exec --json` 的原始输出，不受本项目解析逻辑影响。判定问题到底出在 Codex 侧还是连接器侧，看它最快。
