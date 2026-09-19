<!-- dsh-codex-connector:project-pointer -->
# 项目说明

本项目是 **dsh-codex-connector**：让 DeepSeek Harness 能够调用 Codex 的 Cordis 插件。

## 文档在哪

| 文件 | 面向谁 |
|---|---|
| `README.md` | 用户（中文） |
| `README.en.md` | 用户（英文） |
| `docs/DEVELOPMENT.md` | 改代码、加功能的人 |
| `docs/DESIGN.md` | 设计取舍与实测依据 |
| `docs/TROUBLESHOOTING.md` | 逐步排障 |

## 改代码前必须知道的三条

1. **工具返回值必须无损 JSON**。`lib/index.js` 的 `toLosslessJson` 统一处理；含 `undefined` 会让宿主拒绝整个结果，而报错**指向错误的层**。
2. **根 `AGENTS.md` 存在即冻结**。它同时是 DSH 自己的指令来源，代码绝不改写已存在的同名文件。这是不变量，改动相关逻辑时必须保留。
3. **本包零运行时依赖**。这是刻意的约束——它必须能在 profile 的模块解析环境里确定加载。

## 验证

```bash
npm run selftest          # 离线，不联网不调 Codex
npm run verify-boundary   # 对着宿主真实校验器
npm run live-check        # 真实调用（2 分钟起）
```

改行为必须带回归测试。`scripts/selftest.cjs` 里异步用例一律用 `testAsync`——传给同步的 `test()` 会**假绿**。

## Codex 项目信息

项目知识在 `.codex/project/`（技术栈、能力清单、运行历史）；执行策略在 `.codex/config.toml`（仅当项目被标记为可信时生效）。
