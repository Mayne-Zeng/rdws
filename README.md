# RDWS · AI-Native R&D Workstation

面向项目研发全过程的多租户工程工作站。

> **当前状态：D18 探索稿 · 非契约 · 可推翻。** 仓库里全部是假数据与可点击原型，不连接后端、DSH 实例或模型服务。页面结构、字段与交互都是可推翻的设计假设，不与后续实现绑定。

仓库：<https://github.com/Mayne-Zeng/rdws> · 维护身份：`Mayne-Zeng <rdws@mayne.cn>`

## 这个仓库现在有什么

| 路径 | 内容 |
| --- | --- |
| `docs/00-decision-ledger.html` | **决策台账 v3 · 唯一事实来源**，先读这份 |
| `docs/01-feasibility-report.html` | 基于 DSH 的开源使用风险与二次开发难度评估 |
| `docs/02-directory-and-engineering-design.html` | `.rdws` 运行空间、分支/worktree 策略、工程骨架 |
| `docs/03-design-crosscheck-report.html` | 三面独立评审 + 运行时实测 + Q1–Q4 决策台账 |
| `docs/04-design-baseline.html` | 设计基线与交接规格：令牌、组件规格、a11y 实测、16 视图一致性走查 |
| `demo/rdws-workbench.html` | **当前设计稿**：16 视图可点击工作台，单文件、零外链、假数据 |
| `demo/rdws-overall-demo.html` | D17 第一版探索稿（管理看板范式），保留作对照 |

所有 HTML 都是单文件、无外部依赖，直接双击或拖进浏览器即可打开；hash 路由形如 `#/overview/D-1042`。

建议阅读顺序：`00 决策台账` → `04 设计基线`（要接实现时）→ `03 交叉检查报告`（要了解口径怎么定的）→ 其余按需要。

## 设计口径（摘要，完整版以台账为准）

- 首版只做**浏览器模式**；Tauri 薄壳是后续演进路线，不进 PoC、不进这版原型。
- 项目级 DSH 实例 + 每需求 `agent preset`；一个需求下可有多个 AI 会话，同一时刻只有一个写会话。
- 本地 `sources/` 是只读 bare mirror，**GitLab 主仓才是事实源**；平台服务账号只 push 非保护的 `rdws/*`，环境分支一律走 MR + 人工审批。
- 三级模型作用域（平台 / 项目 / 个人）与平台白名单内的能力模板；关闭会话日志上传与 OTel 遥测。
- 功能入口跟随作用域；表单与详情走页内一等面板，不使用右侧抽屉。

## 接下来的路线

按台账 §5.2，下一步是**单需求 PoC（D1）**，验证四件事：会话 header cwd 归属、`sources` 零写入可脚本验证、≥5 会话的 resume / fork / replay、`rdws/*` push + MR 映射表闭环。

PoC **不验证**：HA / 多机、Tauri 薄壳、多环境自动编排、中心化日志在线迁移，以及生产档（Docker 强隔离）验收——后者因 C1 不追认明确排除。

## 安全与残余风险

本仓库是设计与原型产物，**未经过安全审计，不是生产可用实现**。两条必须携带的残余风险见 `SECURITY.md`：R-A（无 Docker 档的隔离强度）与 R-B（模型主请求可能携带源码出企业边界）。上游合规与品牌口径见 `THIRD_PARTY_NOTICES.md`。

## 许可证

[MIT](LICENSE) · Copyright (c) 2026 Mayne-Zeng。

选型说明：当前仓库只有文档与原型、且上游技术基线同为 MIT，MIT 是成本最低的默认值；这一选择属于本轮自决、**可推翻**，如需更换请显式说明：可替换为 Apache-2.0（含专利授权）、AGPL-3.0（网络使用也要求开源）或「暂不授权」；注意仓库已公开，更换后已分发版本仍受原许可约束。决策台账 v3 的产品决策不受许可证影响。
