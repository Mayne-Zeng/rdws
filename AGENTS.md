# Repository Guidelines

## 项目边界与结构

RDWS 正在按已确认规格分阶段实现最小 Web PoC。`apps/console` 是 React 工作台，`apps/server` 是 Fastify API / BFF；编排与镜像同步按后续阶段进入 `apps/orchestrator`、`apps/syncer`。`packages/contracts` 存共享业务契约，`packages/db` 存 Drizzle 模型和迁移。

DSH 接入归 `dsh/`，`dsh/client` 承载原生浏览器运行时适配，业务代码通过公开适配层访问；运行数据归独立 `RDWS_HOME`，不进 Git。`demo/` 是历史假数据原型，单文件约束仅适用于原型，不约束工程代码。

## 任务阅读入口

- 改范围、权限或数据模型：读 [决策台账当前基线](docs/00-decision-ledger.html#implementation-20261117)。
- 改目录、DSH 或运行配置：读 [工程实施基线](docs/02-directory-and-engineering-design.html#implementation-20261117)。
- 改界面：读 [设计基线](docs/04-design-baseline.html)，复用 TDesign 与 RDWS 主题令牌。
- 改安装或凭据：读 [本地开发说明](README.md) 和 [安全边界](SECURITY.md)。

## 开发与验证

使用 Node.js 24 和 `package.json` 固定的 pnpm。先从 scripts 核对命令；`pnpm dev` 启动本地 Web / API，数据库初始化顺序见 README。

行为修改跑 `pnpm test`；界面旅程跑 `pnpm test:e2e`。同时执行 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`。`pnpm test:web-live` 运行真实 GLM / 原生权限验证，需要本机原生配置且产生真实调用。测试使用独立测试库与运行空间；模拟结果不能替代真实 DSH、GitLab 或 Linux 验收。只报告实际运行结果。

## 编码与数据约定

使用严格 TypeScript；由 Prettier 格式化新工程，ESLint 检查。标识符、必要注释用英文，界面保持中文。测试文件用 `*.test.ts`，浏览器用例放 `tests/e2e/*.spec.ts`。

数据库变更先改 schema，再用 `pnpm db:generate` 生成可审阅迁移，通过 `pnpm db:migrate` 应用；不要直接改表或改写已应用迁移。历史 HTML 与上游文件不做无关格式化。

## 交付与指南维护

提交沿用英文 Conventional Commits，如 `feat: add local authentication`。PR 描述目的、关联决策和验证结果，界面改动附截图。提交、推送、PR 和外部写入需要明确授权。

工具链或目录变化时同步本指南与 README；详细决定保留在台账，实际 scripts 是命令事实源。本指南保持导航性质，不追加逐轮执行日志。
