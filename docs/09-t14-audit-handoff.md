# T14 平台审核交接材料（首批运营候选）

> 2026-11-23 由 captain 按用户访谈结论（D4）整理。审核动作由用户在平台设置面完成；本材料只读，不改变任何验收状态。审核完成后请回填文末「登记结果」并告知 captain。

## 审核基准

- 精确提交：**main `85dcdb2`**（台账约定：平台从该精确提交审核并冻结最终发布版本）。
- 复核（2026-11-23 实测）：三份候选文件自 `85dcdb2` 起零改动；当前 HEAD 的 SHA-256 与下表登记值逐字一致。审核者可在任意检出上用 `shasum -a 256 <源码路径>` 对照下表。

## 三候选清单

| 候选                     | 源码                                                                 | SHA-256                                                            |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 插件「验收会话提示」     | `dsh/candidates/requirement-acceptance/session-guidance.mjs`         | `61503576fbd7b04a5e4ea21d023713f6face39af8562ddcb43b37e952be7ebec` |
| 手动技能「需求验收清单」 | `dsh/candidates/requirement-acceptance/checklist.mjs`                | `6fc2db1d58d08c327ae3f9689ae319078a6ea2567817501752709b50f07e1070` |
| MCP「需求资料只读」      | `dsh/candidates/requirement-acceptance/requirement-readonly-mcp.mjs` | `84a14f9ed728deb87ddad0f1c4c8a1446a108285fc3ab23615c6a9e47200b027` |

三份均为自包含 DSH 模块：插件经锁版 `systemPrompt` 作用域追加固定中文提示；技能走现有 Native 技能注册表且仅允许用户手动调用；MCP 仅作用域内离线静态定义（数据字段限标题、说明、验收标准），无传输地址、命令、凭据、执行回调或新 Tool 注册。

## 证据锚点

- 装配与隔离验证：[工程 §11.17 首批运营候选的本地制品与离线验证](02-directory-and-engineering-design.html#t14-acceptance-candidate-plan-20261121)与[本地装配证据](02-directory-and-engineering-design.html#t14-acceptance-candidate-evidence-20261121)（真实锁版 paused Native 读取模块字节与 SHA-256、需求级 preset 装配、错摘要反例、冷启动复装、回环供应商零 TCP）。
- 集成测试：`tests/integration/t14-acceptance-candidates.test.ts`。
- 候选行为的产品确认：[决策台账](00-decision-ledger.html)与清单 T14 条目。

## 平台设置面操作清单（登记与冻结）

按 [T14 审核登记交付](02-directory-and-engineering-design.html#t14-allowlist-delivery-20261118)已交付的界面与约束执行：

1. 平台设置 → 白名单登记，逐条登记三候选（联合键：类别、来源／标识、人工确认的审核版本）。标识建议直接用源码文件名（如 `session-guidance`），版本写审核确认的版本号；同一来源的多个审核版本相互独立，登记值仅用于精确比对与展示。
2. 审核冻结：冻结每项制品的来源、精确提交（`85dcdb2`）与最终发布制品 SHA-256（即上表登记值），按[现有白名单与模板版本流程](02-directory-and-engineering-design.html#t14-first-operational-candidates-20261120)登记；发布制品进入[全平台封闭制品目录](02-directory-and-engineering-design.html#t14-acceptance-candidate-plan-20261121)约束（发布代码精确固定类别、引用、版本、受审模块及 SHA-256）。
3. 已登记版本的停用为单向操作；登记与停用均有原命令回执，可在「核对」入口回查。

## 登记后联动

- 用户侧验收：按 [docs/08-user-acceptance-checklist.md](08-user-acceptance-checklist.md) T14 三条走查。
- MCP 实际连接与调用：等 T07 准入与具名环境授权（当前仅静态定义）。
- 回填「登记结果」（登记的标识/版本三元组），captain 据此更新清单 T14 状态为「已冻结、待用户验收」。
