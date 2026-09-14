---
id: code.review
title: 代码评审
description: 让 Codex 评审当前仓库的改动：未提交变更、某个提交、或相对某个基线分支的差异，产出按严重度排序的问题清单。
triggers: [代码评审, 评审代码, 审查代码, review, 看看改动, 检查这个提交, code review]
engine: codex-exec
sandbox: read-only
output: text
timeoutMs: 900000
inputs:
  - name: scope
    required: false
    default: "uncommitted"
  - name: focus
    required: false
    default: "正确性、边界条件、错误处理、可维护性；安全与性能问题优先"
---

<!-- Seeded from dsh-codex-connector. This is now a PROJECT file: edit it freely;
     package upgrades will not overwrite it. Delete it to be re-seeded. -->
对当前仓库做一次严格的代码评审。

评审范围：{{scope}}（uncommitted = 已暂存/未暂存/未跟踪的改动；也可以给出分支名或提交 SHA）
重点关注：{{focus}}

要求：

1. 只报告**你真正在 diff 里看到**的问题，必须给出文件路径与行号，并引用关键代码片段。
2. 按严重度排序：阻断性缺陷 → 正确性问题 → 边界/错误处理 → 可维护性 → 风格。
3. 每条给出：问题、触发条件、影响、建议修法。不要只说「建议优化」。
4. 明确区分「确定是问题」与「需要作者确认的疑点」。
5. 如果这个范围内没有问题，就明确说没有问题——不要为凑数编造。
6. 本次是只读评审：**不要修改任何文件**，也不要执行会改变仓库状态的命令。
7. 如果当前工作区不是 git 仓库，或没有可评审的差异，直接说明并停止。
