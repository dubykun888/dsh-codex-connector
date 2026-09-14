# 能力卡字段说明与范例

能力卡放在 `<workspace>/.dsh-codex/capabilities/<id>.md`，一个文件一张卡。
人可读、可 diff、可进 git；DSH 用 `codex_skill_write` 写它，你也可以直接编辑。

## frontmatter 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 唯一标识，同时是文件名。必须匹配 `[a-z0-9][a-z0-9._-]*` |
| `title` | | 人类可读标题，参与路由打分 |
| `description` | ✅ | 描述**何时该用这张卡**，参与路由打分。写清楚使用场景，不要只写它做什么 |
| `triggers` | | 关键词/短语数组，命中权重最高。用用户会真实说出的词 |
| `engine` | | 目前只有 `codex-exec` |
| `model` | | 覆盖模型。**留空以继承 Codex 默认**——填了账号不可用的模型会导致运行失败 |
| `reasoningEffort` | | `medium` / `high` / `xhigh`，谨慎用，越高越慢 |
| `sandbox` | | `read-only` / `workspace-write` / `danger-full-access`。默认 `workspace-write` |
| `skills` | | 期望 Codex 命中的 skill 名数组，会被写进 prompt 作为硬约束 |
| `output` | | `paths` / `text` / `json`，影响你如何解读结果 |
| `timeoutMs` | | 超时毫秒。当前网络下单次调用 2 分钟起，别设太小 |
| `background` | | 是否建议后台运行 |
| `artifacts` | | `{ patterns: [...], collectTo: "..." }`，制品回收规则 |
| `inputs` | | 参数声明数组，每项 `{ name, required, default }` |

### `artifacts.patterns` 支持的路径

- `$CODEX_HOME` 会展开为 Codex 主目录
- `~` 展开为用户目录
- 支持 `*`、`**`、`?`

出图类能力的固定写法：

```yaml
artifacts:
  patterns: ["$CODEX_HOME/generated_images/**/*.png"]
  collectTo: assets/generated
```

> Codex 内置的 `image_gen` **不接受输出路径参数**，图片一律落在
> `$CODEX_HOME/generated_images/<run-dir>/`，且 `<run-dir>` 与 thread id 无关。
> 因此卡片的 prompt 正文里必须要求 Codex 自己把图复制到工作区——控制器同时还会
> 做快照 diff 与路径采纳，三重保险。

## prompt 正文

frontmatter 之后的 Markdown 就是发给 Codex 的任务说明书。

- `{{name}}` 从 `inputs` 取值填充。
- **必填项缺失、或占位符没填上，会在发出去之前直接失败**，不会让 Codex 猜。
- 正文里应当明确：要做什么、产物放哪、命名规则、禁止事项、以及**最后要报告什么**。

## 范例一：薄封装一个既有 skill

```markdown
---
id: image.generate
description: 需要 AI 生成的位图素材时使用：概念图、插画、贴图、UI mockup、透明底抠图。
triggers: [画一张图, 生成图片, 出图, 插画, 封面]
sandbox: workspace-write
skills: [imagegen]
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

使用 `imagegen` skill 生成图片：{{prompt}}，共 {{count}} 张。

要求：
1. 必须用内置 image_gen 工具，不要用 SVG/CSS 占位。
2. 每张图单独调用一次。
3. 不要指定输出路径（image_gen 不支持），出图后复制到 assets/generated/。
4. 不要覆盖已有文件，重名加 -v2。
5. 最后逐行列出实际写入的绝对路径与最终提示词。
```

## 范例二：纯 prompt 级流程（Codex 侧没有对应 skill）

```markdown
---
id: docs.changelog
description: 根据提交历史生成面向用户的变更日志时使用。
triggers: [变更日志, changelog, 发版说明, release notes]
sandbox: read-only
output: text
inputs:
  - name: range
    required: false
    default: "最近一次发版以来的所有提交"
---

阅读 git 历史（范围：{{range}}），生成**面向用户**的变更日志。

要求：
1. 只写用户能感知的变化；重构、测试、内部调整不单列。
2. 按「新增 / 改进 / 修复 / 破坏性变更」分组。
3. 每条一句话，说清「以前怎样、现在怎样」。
4. 不要编造提交里没有的内容；条目少就写少。

本次只读：不要修改任何文件。
```

## 写卡时的常见错误

| 错误 | 后果 | 正确做法 |
|---|---|---|
| `description` 写成「这是一个画图能力」 | 路由打分低，auto 命中不了 | 写「**何时**用它」 |
| `triggers` 用抽象词（`image`、`task`） | 误命中，抢走别的任务 | 用用户真实会说出口的中文/英文短语 |
| 正文里没要求报告文件路径 | 制品回收只能靠目录 diff，弱一些 | 明确要求逐行列出绝对路径 |
| `model` 填了账号不可用的模型 | 运行直接失败 | 留空继承默认 |
| 把 `danger-full-access` 写进卡里 | 不构成授权，会被拒绝 | 保持 `workspace-write`；确有需要时调用方显式传参 |
| `timeoutMs` 设成 30000 | 必然超时 | 出图类 ≥ 900000 |
| 用 tab 缩进 frontmatter | 解析失败，卡片被报告为 invalid | 只用空格 |

## 修订已有卡片

```javascript
// 1. 先读
codex_capabilities { id: "image.generate" }
// 2. 再带 overwrite 写回
codex_skill_write { id: "image.generate", overwrite: true, content: "<修订后的完整 markdown>" }
// 3. 重新验证
codex_skill_verify { id: "image.generate" }
```

修订后卡片回到 `draft`，`codex_skill_verify` 通过才会重新参与 auto 路由。
