---
id: art.assets
title: 项目美术素材批产
description: 为一个项目批量产出风格统一的美术素材：图标组、场景图、UI 素材、游戏贴图、营销配图，一次会话内多张并保持风格一致。
triggers: [一套素材, 美术素材, 批量出图, 图标组, 素材包, 统一风格, 游戏素材, 一整套图, asset pack]
engine: codex-exec
sandbox: workspace-write
skills: [imagegen]
output: paths
timeoutMs: 1800000
artifacts:
  patterns: ["$CODEX_HOME/generated_images/**/*.png"]
  collectTo: assets/generated
inputs:
  - name: brief
    required: true
  - name: items
    required: true
  - name: style
    required: false
    default: "（未指定，请先给出一份风格锚点再开始出图）"
  - name: size
    required: false
    default: "1024x1024"
---

<!-- Seeded from dsh-codex-connector. This is now a PROJECT file: edit it freely;
     package upgrades will not overwrite it. Delete it to be re-seeded. -->
为项目批量产出美术素材，**整套风格必须一致**。

项目与用途：{{brief}}
需要产出的素材清单：{{items}}
风格锚点：{{style}}
统一尺寸：{{size}}

工作流程（按顺序执行）：

1. **先定风格锚点**：用一段话固定下来——配色（给出具体色值）、线条/形状语言、材质与光影、构图习惯、以及明确排除的风格。若上面已给风格锚点，则沿用并补全，不要另起一套。
2. **再逐项出图**：清单里每一项单独调用一次内置 `image_gen`，每次提示词都要**重复带上完整风格锚点**，避免风格漂移。
3. **每张图出完后核对**：是否与锚点一致、主体是否符合该项要求、有无多余文字水印。
4. **落盘**：把最终选中的图复制到工作区 `assets/generated/`，用语义化文件名（如 `icon-settings.png`、`scene-forest-dawn.png`）。不要覆盖已有文件，重名加 `-v2`。

硬性要求：

- 只用内置 `image_gen` 工具，不要用 SVG / CSS 占位代替位图。
- 不要指定输出路径（`image_gen` 不支持），统一从 `$CODEX_HOME/generated_images/` 复制出去。
- 不要偷工减料把多项合并成一张图；清单有几项就产出几张。
- 某一张反复失败时，如实报告该项失败与原因，其余继续完成。

最后一段回复里给出：风格锚点全文、以及每个产出文件的**绝对路径**与对应清单项。
