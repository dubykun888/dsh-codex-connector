# 开发文档

面向**维护者与二次开发者**。用户请看 [`../README.md`](../README.md)。

> 设计与实测依据在 [`DESIGN.md`](./DESIGN.md)。本文件讲**怎么改、怎么验、怎么排错**。

---

## 1. 代码结构

```
lib/
├── index.js                 Cordis 插件外壳（host 面）：注册 codex service + 6 个工具
├── tools-schema.js          参数 spec → 原始 JSON Schema 编译器
├── core/
│   ├── locate.js            二进制定位（有序探测 + npm shim 拆包）
│   ├── codex-run.js         执行编排：argv 组装、事件消费、制品回收、成败判定
│   ├── events.js            JSONL 逐行容错解析（按语义分类成败）
│   ├── catalog.js           能力卡解析 / 校验 / 播种 / 关键词匹配
│   ├── frontmatter.js       自研 YAML frontmatter 解析器（零依赖）
│   ├── serialize.js         frontmatter 序列化（写卡用）
│   ├── prompt.js            能力卡 + inputs → 最终 prompt
│   ├── artifacts.js         快照 diff、glob、去重命名、路径提取
│   ├── project.js           项目注册、所有权判定、幂等
│   ├── project-facts.js     项目画像静态探测
│   ├── trust.js             用户级 trust 条目读写（备份/校验/还原）
│   ├── runs.js              runId、事件落盘、健康计数、会话续接
│   ├── env.js               子进程环境白名单收敛
│   └── parallel.js          每工作区串行化 + 瞬态重试
└── workers/
    ├── workers.js           6 个工具的实现在这里（返回纯 JSON）
    ├── worker.js            JSON-in / JSON-out 的 CLI 外壳
    └── spawn.js             原生 spawn（收集输出、超时终止）
```

**数据流**：工具调用 → `index.js` 的 `execute` → `workers.<handler>` → `codex-run.run` → spawn Codex → 解析事件 → 回收制品 → 净化结果 → 返回。

**两个边界**（改动时最容易踩）：

1. **工具返回值必须无损 JSON**。`index.js` 里有 `toLosslessJson` 统一净化，规则与宿主校验器逐条对齐。任何新增字段都要能被它处理。
2. **工具参数必须是合法 JSON Schema**。`tools-schema.js` 的 `compileParameters` 会拒绝未知键——这是刻意的，静默丢键比报错危险得多。

---

## 2. 本地验证

```bash
npm run selftest          # 70 项离线检查：不联网、不调 Codex
npm run live-check        # 真实链路：会真的调用 Codex（每次 2 分钟起）
npm run verify-install    # 安装是否真的生效（必须在 profile 目录里跑）
npm run verify-boundary   # 对着宿主真实校验器验证参数与工具返回值
```

### `live-check` 开关

```bash
node scripts/live-check.cjs --quick        # 只做定位/鉴权/注册/路由，不调 Codex
node scripts/live-check.cjs --with-image   # 额外验证出图与制品回收
node scripts/live-check.cjs --workspace <dir>
```

### `verify-boundary` 为什么必须单独存在

它需要已安装的 Profile（从那里加载 harness 包），验证两层：

1. **参数**：注册的 `parameters` 是合法 JSON Schema，且没有把可选参数错标为必填。
2. **返回值**：每个 worker 的真实结果都能通过宿主的 `isJsonValue`。

之所以不能只靠离线自测：有一次失败的报错是 `returned invalid output: value is not lossless JSON`，**指向输出层，真实原因却在参数层**。离线自测只能**复刻**规则，无法证明复刻正确；只有对着真实校验器跑，才能把两层区分开。

```bash
node scripts/verify-boundary.mjs --live   # 额外跑一次真实出图
```

---

## 3. 安装到 Profile

```bash
# 1) 看变更计划（不写任何东西）
node scripts/install.mjs --profile web

# 2) 确认后写入（自动备份，失败即还原）
node scripts/install.mjs --profile web --apply

# 3) 链接依赖
cd "$DSH_HOME/profiles/web" && pnpm install

# 4) 重启 DSH
```

卸载：`node scripts/install.mjs --profile web --uninstall --apply`

脚本只改两处，且都先备份：

- `$DSH_HOME/profiles/<profile>/package.json` —— 增加一条 `link:` 依赖
- `$DSH_HOME/profiles/<profile>/cordis.patch.yml` —— 增加一行

**绝不**修改 shipped bundle（`dsh-base` / `dsh-web-app`）或 shipped preset。

### patch 行的格式很容易写错 ⚠️

加载器对 patch 条目的语义是二选一的：

| 写法 | 含义 |
|---|---|
| `- insert:` 包裹 | **新增**行（包裹层不带 `id` 时，把内部行追加到根列表） |
| 顶层 `- id: <x>` | **覆盖既有行**，`x` 必须已存在 |

新增一行**必须**写成：

```yaml
- insert:
    - id: tool-codex-connector
      name: 'dsh-codex-connector'
```

写成顶层 `- id: ...` 时，加载器认为你要覆盖一个不存在的行，打印
`patch: entry "tool-codex-connector" not found` 然后**整行跳过**——插件不挂载，而配置文件看起来「明明写了」。这个错误真实发生过，且当时所有更弱的检查都通过了。`verify-install.mjs` 现在会检查**包裹结构**而不只是 id 是否存在。

判断是否真的生效，用官方诊断（打印**组合后**的树）：

```bash
dsh --profile web --dump-config | Select-String 'tool-codex-connector'
```

能搜到该行且开头没有 `patch: entry ... not found` 才算进入组合。

### 让会话真正拿到工具

patch 把 **service 层**挂在 host 面；工具行属于 agent 面，要加到 preset 上。推荐复制一个 shipped preset 再改副本：

```bash
node scripts/install.mjs --profile web --preset standard --apply
```

> 为什么 service 在 host 面：同一工作区的并发串行化必须**进程级**生效，否则多个会话各持一条队列，等于没有限制。

### 零运行时依赖

本包**没有任何运行时依赖**（frontmatter 解析器与 schema 编译器都在树内）。这样它能在 profile 的模块解析环境里确定地加载，不会因缺一个包而整行挂掉。**新增依赖前请先权衡这一点。**

### 不想重启？用动态插件桥接

用动态 Cordis 插件把工具挂进**当前会话**。它不复制实现，而是调用本包的**真实 worker**：

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

验证的是**同一份代码**，不会出现「临时能跑、落盘就坏」的分叉。注意它与 profile 行**注册同名工具**，重启后应先停掉它。

---

## 4. 扩展点

### 4.1 新增一种 Codex 能力 → 写能力卡（不改代码）

放在 `<workspace>/.dsh-codex/capabilities/<id>.md`。用户级说明见 README；开发者要注意的是**卡片字段与实现契约的对应**：

| 字段 | 实现影响 |
|---|---|
| `id` | 文件名与唯一键；重复会被报告并丢弃后定义 |
| `triggers` / `description` | 路由打分输入（低命中率通常是不该写抽象词） |
| `sandbox` | 传给 `codex-run`；写 `danger-full-access` **不构成授权**（见 `sandboxExplicit`） |
| `skills` | 只写进 prompt 作为硬约束，不被代码强制 |
| `artifacts.patterns` | `$CODEX_HOME` / `~` / `*` / `**` / `?` |
| `artifacts.collectTo` | **视为不可信输入**，有包含性断言，越界即拒绝 |
| `inputs` | 必填缺失或占位符未填 → **发出去之前就失败** |
| `timeoutMs` | 不得大于插件声明的工具超时上限（当前 1 小时） |

内置种子卡在 `capabilities/`，首次使用时复制进项目并加横幅。**横幅必须写在正文开头**——写在 frontmatter 之前会让整张卡解析失败。

### 4.2 新增一个工具

1. 在 `lib/index.js` 的 `TOOL_SPECS` 加一条（`parameters` 用本项目的 spec 方言）。
2. 在 `lib/workers/workers.js` 实现 handler，**返回纯 JSON**。
3. 加离线测试：`compileParameters` 能编译、结果能过 `toLosslessJson`。
4. 跑 `npm run verify-boundary`——它会用**宿主真实校验器**复核参数与返回值两层。

用到的 spec 方言：顶层是属性映射，每个属性是类型 spec，`required: true` 标记必填，`object` 类型可带 `properties`，未知键会被**拒绝**。

### 4.3 新增插件行 / 改平面

平面规则：**会发布 service 的行不能松放在 preset 里**（第二次挂载会撞名）。本项目把 service 与工具都放在 host 面的同一行，因此不涉及 realm。若要拆分，务必先读 `docs/DESIGN.md` §3 的平面选择表。

---

## 5. 维护须知：容易改坏的地方

按「曾经真实踩过」排序：

| 位置 | 陷阱 | 防線 |
|---|---|---|
| `index.js` 工具返回值 | 含 `undefined` 会被宿主拒绝，且报错指向输出层、真实原因可能在别处 | `toLosslessJson`；`verify-boundary` 双层验证 |
| `events.js` 成败判定 | 传输告警**有两种形态**且都不代表失败；但真实失败也不能被吞 | 按语义分类；`classifyMessage` |
| `codex-run.js` 超时 | 只看事件流会把「被超时杀掉」报成成功 | `ok = parsed.ok && !timedOut` |
| `codex-run.js` 制品回收 | 从 thread_id 推路径是错的；重复导入会存两份；废弃变体会被误收 | 快照 diff + 路径采纳 + 「agent 已放置则不导入」 |
| `codex-run.js` `codexHome` | 未传时会静默回退到默认 `~/.codex`，设了 `CODEX_HOME` 就回收失效 | 入口解析一次、全程使用 |
| `project.js` 所有权判定 | 只查存在性会让**用户的**目录被判成我们的 | 内容校验 + 首行标记 |
| `project.js` 写入顺序 | 先写文件后记所有权 → 崩在中途会把自家目录变成「外来」 | 所有权先立 |
| `locate.js` 探测顺序 | 配置线索排在 PATH 前会跑到桌面端捆绑的旧构建 | PATH 优先；`.cmd` 必须拆包 |
| `serialize.js` 多行值 | 产出自己解析器读不回的卡 | 直接拒绝多行 |
| `selftest.cjs` 测试写法 | 把 `async` 回调传给同步的 `test()` 会**假绿** | 一律用 `testAsync` |

### 关于 `AGENTS.md`

仓库根 `AGENTS.md` 是**给 DSH 自己**的项目指令，同时本项目运行时也会为工作区生成同名文件。**已存在的根 `AGENTS.md` 绝不被代码改写**——它同时是 DSH 的指令来源，改写它等于静默改掉 DSH 的提示词。改动相关代码时请保留这条不变量。

---

## 6. 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| `Codex CLI not found` | 探测全部未命中 | `codex_status` 看 `probes`；在 `.dsh-codex/config.json` 设 `codexBinary` |
| `failed to initialize in-process app-server client: 拒绝访问。 (os error 5)` | 执行层没走宿主 `subprocess` | 确认插件在 host 面加载；不要用会话里的 shell 直接调 Codex |
| `configEffective: false` | 项目未被标记可信 | 项目知识仍生效；需要执行策略时 `codex_project action=grant-trust` |
| 出图成功但工作区没有文件 | 制品未被回收 | 查 `result.artifactSources` 与 `runs/<id>/result.json`；核对 `artifacts.patterns` |
| 每次调用 2 分钟以上 | 网络回退 HTTPS（实测 118–126s） | 正常现象。调用是**同步阻塞**的，批量任务应拆成多次 |
| 报 `timed out ... and was terminated` | 超过 `timeoutMs` | 结果可能被截断且**不会**被当成成功。提高上限或拆小任务 |
| 模型报 `not supported when using Codex with a ChatGPT account` | 卡片 `model` 用了账号不可用的模型 | 卡片 `model` 留空以继承默认 |
| `.codex/` 被判为外来目录 | 既有目录非本工具创建 | 确认后 `codex_project { action: "register", adopt: true }` |
| 重启后插件列表看不到 | patch 行写成了顶层 `- id:` | `dsh --profile web --dump-config` 若出现 `patch: entry ... not found` 即此因。改成 `- insert:` 包裹后重启 |
| 重启后工具仍不出现 | 工具行属于 agent 面，patch 只挂了 service | 用 `--preset` 加工具行 |
| `--dump-config` 报 `EPERM ... cordis.yml` | 它需要重写 profile 根文件 | 不是配置错误，用有权限的终端跑 |
| `grant-trust` 返回 `no-approval-channel` | 该部署无审批通道 | 按提示手工加入条目，或让用户在配置里允许 |
| 报 `value is not lossless JSON` | 返回值含 `undefined`；**该报错会指向错误的层** | 用 `npm run verify-boundary` 对着真实校验器复现 |
| 每次调用跑满 `timeoutMs`（伴随多条 `Reconnecting`） | 网络到推理端点不通，**不是插件故障** | `codex doctor --summary` 看 `reachability` / `websocket`；再测 `Test-NetConnection chatgpt.com -Port 443` |

> **关于后台运行**：本版本工具调用是**同步**的——不返回 job id，不接管后台作业。一次调用阻塞到 Codex 退出或被 `timeoutMs` 杀掉；宿主侧的工具调用超时策略在更外层生效。这里写清楚，是因为「长任务后台跑」曾经是一句没有实现支撑的承诺。

---

## 7. 版本与兼容

- **Codex CLI**：实测兼容 `0.154.0-alpha.6.2`（桌面端捆绑）与 `0.155.1`（npm 独立安装）。两者 `exec` 参数集经核对一致。
- **Node**：`>=20`（`package.json` engines）。
- **DSH**：需要 host 面提供 `subprocess` 与 `tools` 两个服务（`inject` 已声明）。
- **零运行时依赖**：这是刻意的约束，见 §3。

---

## 8. 提交前检查清单

- [ ] `npm run selftest` 全绿（新增行为都要有回归测试）
- [ ] 改了工具参数或返回值 → `npm run verify-boundary` 全绿
- [ ] 改了执行链 → `node scripts/live-check.cjs --quick` 全绿（必要时应跑真实出图）
- [ ] 文档里的章节引用仍然有效（`DESIGN.md` 的编号是引用目标）
- [ ] 没有把 `COMMIT_MSG.tmp`、临时 `_*.cjs` 探针脚本留在树里
- [ ] `assets/generated/` 与 `.dsh-codex/runs/` 未进版本库（`.gitignore` 已覆盖）
