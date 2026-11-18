# 第三方声明与品牌口径

## 当前仓库的实际状况

工程通过 npm 依赖使用 React、Vite、TDesign React、Fastify、Better Auth、Drizzle、pg、TypeBox 及测试工具；直接与传递依赖的确切版本由 `pnpm-lock.yaml` 固定，各依赖的版权与许可随安装包提供。当前没有将第三方源码复制为本仓库自研代码。

`docs/` 与 `demo/` 的既有 HTML 保持单文件，不依赖远程静态资源；该约束不适用于工程应用。当前已引入 DSH npm 运行时并构建 Web 应用。后续制作可分发服务或静态包时，须核对并携带相应 LICENSE / NOTICE；目前未完成分发合规验收。

## 技术基线（事实性描述）

项目设计以 `deepseek-ai/deepseek-harness`（DSH）**0.2.2-rc.3** 为技术基线（版本锁定与回归门禁见决策台账 §8）。上游为 MIT 许可。npm 发布包用于原生 Web 会话、独立子进程与 SDK 探针；参考源码与发布接口的差异以锁定发布包为准。来源、版本、包完整性与依赖解析由 `dsh/upstream/manifest.json`、工作区包清单和 `pnpm-lock.yaml` 记录。未修改或复制上游源码为自研代码；DSH 包自带 `LICENSE`，安装产物位于忽略的 `node_modules/`。

## 品牌与商标

- 「DeepSeek Harness」是注册商标，**不用作本项目名**；本项目独立名称为 **RDWS**。
- DSH 仅以缩写形式作技术基线的事实性描述（例如「基于 DSH 构建」）。
- 界面沿用主流智能体工作台的三区骨架，但用 RDWS 自己的一主色 + 中性灰阶重建，不照搬参考产品品牌资产。

## 后续实现必须带入的合规项（来自决策台账 §1.5）

这些是**执行细则**，不是当前已发生的依赖：

1. 发布包剔除 `claude-code-mods` 相关实验插件及 Claude Code 平台 payload，不依赖其 identity-scoped 授权；相关 `LICENSE.md` 正文交法务复核。
2. MPL-2.0 的 LibreOffice 套件若被引入，保留对应源码与 NOTICE 可得路径。
3. 维护上游 `THIRD_PARTY_NOTICES.md` 的可得路径；立项时重新核对 README / SAFETY / THIRD_PARTY_NOTICES，不以 master 为部署源。
4. 平台只使用已审核的白名单插件 / 技能 / MCP，禁用第三方社区插件市场。

## 本仓库许可证

[MIT](LICENSE) · Copyright (c) 2026 Mayne-Zeng。本文件不构成对上游项目商标或品牌的任何授权主张。

## Web 原生客户端适配

`dsh/client` 使用发布包的公开 modules / Session API；Native Store 的运行依赖由工作区显式补齐。浏览器构建用明确失败的 Node 模块边界和上游 shell 相同的环境条件，无 Node 文件系统能力。Host 载体使用包 `exports` 明确公开的 `dsh-api-gateway/src/stream-server.ts`，由 tsx 加载以复用原生 mux；未修改该源码或私有认证映射。公开源码导出随上游升级仍需契约回归。
