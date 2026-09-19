---
id: image.generate
title: 生成图片
description: 需要 AI 生成的位图素材时使用：概念图、插画、贴图、sprite、UI mockup、透明底抠图、封面图。
triggers: [画一张图, 画个图, 生成图片, 出图, 配图, 插画, 立绘, 图标, 位图, hero image, mockup, 美术素材, 封面]
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
  - name: size
    required: false
    default: "1024x1024"
---

使用 `imagegen` skill 生成图片。

主提示词：{{prompt}}
数量：{{count}}
期望尺寸：{{size}}

硬性要求：

1. 必须使用内置 `image_gen` 工具出图，不要用 SVG / HTML / CSS 占位，也不要用文字描述代替图片。
2. 每张图单独调用一次；需要 {{count}} 张就调用 {{count}} 次，不要用 `n` 参数代替多个不同提示词。
3. 参数里不要指定输出路径——`image_gen` 不支持目标路径，图片会自动落到 `$CODEX_HOME/generated_images/` 下。
4. 出图后，把最终选中的图片**复制**到工作区的 `assets/generated/` 目录，文件名用语义化英文短横线命名（例如 `hero-ceramic-mug.png`）。不要覆盖已存在的文件，重名时加 `-v2` 后缀。
5. 如果 `image_gen` 不可用或调用失败，直接说明失败原因，不要用其他方式伪造产物。
6. 最后一段回复里，逐行列出你实际写入磁盘的每个文件的**绝对路径**，并附上最终使用的完整提示词。
7. 只保留你**最终选中**的产物。中途重试产生的废弃变体不要复制进工作区——把选中的那些报告出来即可。

已知约束（实测所得，请如实说明，不要为凑指标反复重试）：

- **实际输出尺寸由 `image_gen` 决定，不严格等于请求的尺寸。** 实测请求 `1024x1024` 得到的是 `1254x1254`。请求尺寸只用于传达构图意图。
- **平涂区域会带极轻微的抗锯齿色差**，边缘像素不是精确纯色。这是位图渲染的固有特性，不要声称「精确纯色」。
- 某个条目重试后仍不达标时，**如实报告并停止**：不要无限重试，也不要用其他工具偷偷修补。
