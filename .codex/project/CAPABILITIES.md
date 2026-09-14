<!-- managed by dsh-codex-connector; 由能力目录自动生成 -->

# 可用的 Codex 能力（能力卡）

> 本文件由 `dsh-codex-connector` 从 `.dsh-codex/capabilities/` 生成。
> 修改能力请改能力卡，不要改本文件。

## `art.assets` — 项目美术素材批产

为一个项目批量产出风格统一的美术素材：图标组、场景图、UI 素材、游戏贴图、营销配图，一次会话内多张并保持风格一致。

- 依赖 skill: imagegen
- 产物目录: `assets/generated`
- 沙箱: `workspace-write`

## `code.review` — 代码评审

让 Codex 评审当前仓库的改动：未提交变更、某个提交、或相对某个基线分支的差异，产出按严重度排序的问题清单。

- 沙箱: `read-only`

## `design.spec` — 功能与架构设计

用 Codex 的高级模型做功能设计、方案设计、架构评审：产出决策完备、可评审的设计文档，而不是直接写实现代码。

- 沙箱: `read-only`

## `image.generate` — 生成图片

需要 AI 生成的位图素材时使用：概念图、插画、贴图、sprite、UI mockup、透明底抠图、封面图。

- 依赖 skill: imagegen
- 产物目录: `assets/generated`
- 沙箱: `workspace-write`

