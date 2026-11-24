# RDWS 开发任务清单

本文件是后续智能体选择研发任务、核对依赖、记录验收和更新完成状态的统一入口。按任务顺序管理，不安排工期和日历日期。

## 确认范围与事实来源

用户于 2026-11-18 确认以下总体方向，并要求将任务清单落实到项目文件中：

- 主计划交付完整浏览器产品，覆盖全部 16 个视图；真实研发闭环到实际编码、测试验证、GitLab 人工合入和精确结果回写。
- Codex 主导实现，最多 3 路独立工作包并行；用户负责关键决策和用户侧验收。
- 实际部署执行／部署批准、完整测试用例与 Bug 管理系统另列后续阶段。Tauri、HA／多机、生产强隔离等继续单列。
- 仅安排任务、说明、可验收目标、依赖和执行顺序，不保留此前讨论的工期估算。

本清单管理任务编排与完成状态；目标行为、权限、数据和工程约束继续引用以下来源，不另建一套业务契约：

| 来源                                                                                         | 用途                                      |
| -------------------------------------------------------------------------------------------- | ----------------------------------------- |
| [决策台账当前基线](00-decision-ledger.html#implementation-20261117)                          | 当前 PoC 范围、权限、数据不变量及有效决定 |
| [工程实施基线](02-directory-and-engineering-design.html#implementation-20261117)             | 目录、运行空间、技术映射和详细执行证据    |
| [已批准多会话切片](02-directory-and-engineering-design.html#session-lifecycle-plan-20261118) | T02 的现有方案、边界、审阅及验证要求      |
| [设计基线](04-design-baseline.html)与[当前 Demo](../demo/rdws-workbench.html)                | 16 视图、视觉令牌、组件和交互来源         |
| [仓库指令](../AGENTS.md)、[本地开发说明](../README.md)、[安全边界](../SECURITY.md)           | 实施约束、当前工具链、操作说明及残余风险  |

总体浏览器目标不表示当前 PoC 已包含或已经完成全部能力。进入后续工作包时，先把该包的细节规格、权限和数据影响对齐到台账及工程设计，再实现。历史方案中已被替代的阶段人员审批、rebase、每需求一实例等内容不恢复。

**审阅状态：任务编排已经用户确认；修订后第二轮独立复审 A 面 APPROVE、B 面 APPROVE，无未关闭评审发现。** 评审范围及处置见文末记录。T02 继续复用仍有效的既有双面方案评审；其他任务按影响面完成各自的规格、设计评审和验证。总编排评审不替代具体任务的技术方案评审。本地功能提交按 [AGENTS.md 的交付规则](../AGENTS.md#交付与指南维护)执行；清单不授权推送、MR、部署或破坏性清理。

## 领取、验证与状态维护

1. 开始或恢复任务时，先读本清单和该任务的直接来源，核对当前代码、工作区、正在执行的任务及最新证据。
2. 从前置已满足的任务中领取一项；先由用户或既有主会话指定唯一协调者，并登记协调检出、执行者标识、实际改动路径、共享资源和工作树。所有工作包向协调检出上的同一份清单串行登记领取；各自工作树中的副本不作为领取权威。已有任务先核对归属，不因本文件未写执行者姓名就重复领取。
3. 尚未明确的业务规则在对应任务内先完成规格确认。例如导入失败策略、人员维护权限、配额维度和超限行为，不由实现者自行补成规则。
4. 按任务验收目标实现并验证；命令从当前 `package.json` 和配置读取，验证范围遵循 [AGENTS.md](../AGENTS.md)。模拟验证与真实 DSH、GitLab、Linux 证据分别记录。
5. 实施、验证或交接检查点由执行者提供状态和证据，协调者读取清单最新版后逐项回写。完整功能按 [AGENTS.md 的交付规则](../AGENTS.md#交付与指南维护)完成文档、进度、审阅及本地提交，再推进依赖任务；关联对应功能提交和验收证据。详细记录留在已有工程文档中，本清单只保存最新状态及证据指针。
6. 依赖满足后交付下一项；发现改变范围、权限、数据或验收的偏差，先对齐决定并更新原规格，不把偏差藏进“实现细节”。

状态只记录在任务首行：未勾选且无标注为待开始；可以标注“进行中”“阻塞：原因”或“待验收：缺口”；只有满足全部可验收目标后才勾选完成，并移除未完成状态。下游能复用一个已验证的子能力时，需要在来源方案中明确对应子项及证据，不能据此提前勾选整个父任务。

每个完成项至少关联：改动范围和对应代码修订、验证环境、实际执行的命令及退出码／关键结果、真实环境证据、适用的独立评审、用户侧验收及未关闭偏差。工作包在独立工作树验证后，先合入协调检出并通过受影响的集成检查，再勾选完成；外部动作仍按授权执行。新代码或配置使原证据失效时先补测，不沿用无关版本的结果。视觉任务内部检查通过后，仍保留用户对 Demo 一致性的验收；未取得真实环境证据的必需项保持未完成。

## 协调与资源登记

当前由既有主会话登记协调者 `codex-t00-2c7273ae`。T01 已交付并随 `af0a9d2` 完成登录页补充，T20 用户侧视觉复验已通过。T04 已通过具名授权 Gitee 仓库验收，T05 的真实需求工作树和 T06 的 macOS 隔离执行已交付。T02 已在 `4ecf870` 本地提交，2026-11-20 用户侧验收通过。协调角色只管理研发路径和资源。新工作包启动前必须复核实际占用。

| 登记项       | 当前记录／填写要求                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 唯一协调者   | `codex-t00-2c7273ae`（既有主会话，并行包只向此协调登记）                                                                                                                                         |
| 协调检出     | 本仓库 Git 主工作树 `main`，T06 实现起点 `a2dda16`                                                                                                                                               |
| 已有占用     | T02 与 T03 已结项。本地 5173／3001 与 poc Native 启动状态按领取时点复核                                                                                                                          |
| 新工作包占用 | T07 已确认可写会话与首批工具规则，待实施和联合验收。T11 已交付，T14 待运营制品及用户侧验收，T16 持久锚点与自动截止已交付，待正式部署与用户侧验收                                                 |
| 运行资源     | 运行根为用户主目录 .rdws（仓库外绝对路径，指纹见 T00 私有证据）；rdws_dev/rdws_app 与 rdws_test/rdws_test_app；PG 55432、Compose rdws-local；测试 5317／3303 未监听但仍须排队；实例锁详 T00 证据 |

当前 Playwright 配置固定使用 5317／3303，真实套件继承该配置；数据库脚本固定 Compose project 为 rdws-local。独立工作树或单改 RDWS_HOME 不足以证明这些资源已隔离。仅在配置和命令已验证支持独立资源、且无现有占用时并行运行对应检查；其余测试或服务启动由协调者排队串行执行。未经协调，不初始化、迁移、重建或抢占共享数据库、容器、端口或原生实例。

状态变更由唯一协调者串行维护；不能完成协调时退回串行领取。集成工作包时仅合并经过核对的规范变更，保留协调清单中的最新占用、状态和证据，不用旧工作树的整份清单覆盖。失联或记录过期不能自行当作任务已释放，应核实执行、进程与已有改动后完成交接。

实现评审分支已在协调窗口合入本地 `main`（`1760bb5`）。修订、复审、分片验收和剩余发现见[评审报告 §10.5](06-implementation-review-report.html#s10-delivery)。T13 的正式出口接线和 T19 的交付包按各自判据推进。

## 已有基础与当前工作

以下是已有文档记录的验收基础，不代表本清单各项已完成，也不声称本次文档落地重新运行了这些测试：

- 工程骨架、Docker PostgreSQL、增量迁移和预置登录，见[工程实施记录](02-directory-and-engineering-design.html#execution-log)。
- 需求参与、子任务分派、负责人阶段操作、动态上下文及原生流，见[业务切片执行证据](02-directory-and-engineering-design.html#business-live-20261118)和[台账入库复核](00-decision-ledger.html#repository-review-20261118)。
- T02 已有批准方案并在 `4ecf870` 提交实现、测试和交付文档。最新用户侧验收见 T02 条目。

## 主计划任务

编号用于追踪，不表示必须按数字串行执行；实际顺序见各任务前置与后面的并行队列。

- [x] **T00 · 总基线与任务追溯**
  - 说明：核对全部有效设计、当前实现、未完成项和后续项；明确共享接口、schema、迁移的协调归属；提前检查 DSH 公开接口、GitLab 和 Linux 条件。
  - 可验收目标：每个有效设计点对应唯一任务或明确后续项；16 视图映射完整；既有已批准切片继续有效；关键技术与外部环境缺口可追溯，阻塞关系明确。
  - 前置：现有台账、工程与设计基线、当前实现。T02 不因 T00 尚未完成而重新等待批准。
  - 来源：台账当前基线、设计基线、本文件已确认范围。
  - 执行归属：协调者 `codex-t00-2c7273ae`，本仓库 Git 主工作树 `main`，基线 `4ecf870`；仅修改基线／清单／文档导航及离线追溯校验，不改业务运行实现。
  - 当前证据：61 个来源条款、62 个原子追溯命题、16 视图、17 个接口域、5 类原生能力、11 个缺口已归口；离线 CLI 和 13 项聚焦测试通过，类型／lint／格式／构建／Node 语法及文档浏览检查通过；双面第二轮复审均 APPROVE，首轮 2 Major／1 Minor 全部关闭。详见[T00 最终证据](02-directory-and-engineering-design.html#t00-verification-20261118)。
  - 交付修订：对应本轮 `chore: complete T00 baseline traceability` 本地提交，实际 commit ID 由 Git 记录和交付回复给出。业务实现及其既有验证基线仍为 `4ecf870`。
  - 验收边界：T00 的基线／追溯内部交付已完成；GitLab、Linux、执行工具和后续业务取舍仍按 11 个缺口及主责任务处理，不代表这些环境或功能已就绪。T01／T02／T22 的用户侧验收保持各自状态。

- [x] **T01 · 核心页面与 Demo 对齐**
  - 说明：对照工作台外壳、需求列表／新建、需求档案／子任务、对话和上下文页，完成真实可达页面的视觉与交互对齐。
  - 可验收目标：布局、密度、字阶、组件、图标和信息层级与 Demo 对齐；1440／1024／820／390px 明暗主题、键盘操作、焦点、正文对比度及页面溢出检查通过；完成用户首次视觉验收。T02 新增操作随 T02 接入并验证。
  - 交付修订：基础切片 `907dffa`；样板正式应用随 `feat: ship approved workbench layouts` 本地提交，实际 ID 由 Git 记录，不推送。
  - 前置：T00；复用现有业务基础。与 T02 协调对话页和主题文件的写入归属。
  - 来源：I4-UI；[工程设计界面门槛](02-directory-and-engineering-design.html#business-slice-plan-20261118)；设计基线与 Demo。
  - 执行归属：既有协调者 `codex-t00-2c7273ae`，同一主工作树串行接续；本轮唯一写入 console 对话／主题／导航／表单及对应浏览器测试，服务检查串行。
  - 当前证据：方案与交付复审均 APPROVE。pnpm check（104 项测试及静态检查／构建）、18 项浏览器 E2E、13 项真实 Native、基线追溯通过；包含五入口四宽两主题矩阵和 5173 实机明暗走查。详见[本轮交付证据](02-directory-and-engineering-design.html#t01-rollout-delivery-20261118)。
  - 桌面样板已获用户确认。需求档案、需求列表／新建、对话和上下文均已接入样板，入口与验证范围见[样板正式应用](02-directory-and-engineering-design.html#t01-rollout-20261118)。
  - 补充交付：已确认的登录页 v2 固定深色，桌面与手机均接入正式认证。[实现、审阅与验证](02-directory-and-engineering-design.html#login-v2-20261118)与代码同批本地提交。

- [x] **T02 · 多会话生命周期**
  - 说明：完成创建防重、本人派生、固定边界被动回放、恢复、未知结果与撤权故障处理。
  - 执行归属：Codex 当前多会话研发会话，当前主工作树 `main`；改动范围为 console 会话页、server 会话操作、DSH 适配、contracts、db 增量迁移及对应测试。实现、文档、进度及交付规则已在 `4ecf870` 同批本地提交，后续修改这些路径前先核对功能提交与当前工作区。
  - 当前证据：双面交付复审均 APPROVE；`pnpm check` 通过（74 测试／11 文件及静态检查、构建），`pnpm test:e2e` 8 项、`pnpm test:web-live` 12 项通过；真实五会话恢复、本人派生、固定回放和日常 5173 验证完成。详见[工程设计最终证据](02-directory-and-engineering-design.html#session-lifecycle-live-20261118)。
  - 用户侧验收：2026-11-20 用户走查多会话恢复、本人派生与固定切点只读回放后确认通过。[台账确认](00-decision-ledger.html#t02-user-acceptance-20261120)
  - 交付修订：`4ecf87013e17ef1dc9128ac134f976ab32e2cfa1`（`feat: complete T02 read-only session lifecycle`）。
  - 评审续办：更新和回退按 [README 会话说明](../README.md#web-需求与会话)先切换 BFF，再更新浏览器制品并重载已打开的工作台。
  - 可验收目标：同需求至少五个会话可恢复；派生只接受当前有权操作的本人源，保存实际逻辑切点；重试不重复创建；未知结果不盲目重发；回放不调用模型或执行工具；冷读补齐与原始持久前缀分别核对；真实 Native、浏览器、越权和重启反例通过。
  - 前置：[已有批准方案](02-directory-and-engineering-design.html#session-lifecycle-plan-20261118)。T00 只同步任务归属与接口衔接。
  - 来源：I2-AUTH、I3-CONTEXT、I4-UI；[台账多会话切片](00-decision-ledger.html#session-lifecycle-20261118)。
  - 已交付修复：[回放权限失效与固定切点](02-directory-and-engineering-design.html#t02-replay-read-guard-20261119)。续页权限拒绝后清除已加载正文和切点，重新读取首页。错切点、停滞或越界页不会拼入历史；合法空页仍可向前分页。独立复审、整仓 187 项、浏览器 36 项及基线通过。
  - 已交付修复：[目录与历史的观察登录](02-directory-and-engineering-design.html#t02-passive-session-login-plan-20261119)。工作台对话和轨迹保持原观察登录，换 Cookie 时清理受影响读状态，允许从新页面重新读取。兼容按 Cookie 鉴权的无头客户端。独立复审、整仓 188 项、浏览器 38 项及基线通过。
  - 已交付修复：[新建与派生的观察登录](02-directory-and-engineering-design.html#t02-session-write-login-20261119)。旧页换 Cookie 后不能借新登录创建或派生会话。原命令由浏览器保留，同一账号重新打开后可核对，已有回执可直接返回原会话。独立复审、整仓 189 项、浏览器 39 项及基线通过。

- [x] **T03 · 项目与成员管理**
  - 说明：补齐项目配置、多项目、成员维护、多角色和撤权入口；项目配置化同时覆盖项目级 DSH 实例的注册、路由与生命周期，解除仅预置 PoC 项目可用的运行时特例。
  - 可验收目标：管理权限矩阵明确；一个账号可按授权访问不同项目；至少两个项目使用各自的原生实例、运行目录和 workspace 映射完成会话读取／发送，跨项目通道被拒；旧 PoC 兼容；角色在当前作用域合并；管理身份不自动取得代码写权；停用、撤权及其与正在执行操作的竞争有明确结果。
  - 前置：T00、现有身份和角色模型。
  - 来源：I2-AUTH、D4；已确认多角色、多项目执行细则。
  - 当前证据：方案及交付双面复审 APPROVE；独立测试库和本地开发库应用增量迁移 0005。全量 104 测试、18 项 E2E、13 项真实 Native、静态检查、构建和基线追溯通过。已用同一账号验证两个项目的独立进程/数据/工作区、读取和发送会话消息、旧代次拒绝及项目局部撤权。[最终交付证据](02-directory-and-engineering-design.html#t03-delivery-20261118)。
  - 交付修订：本轮 `feat: add project administration and isolated native runtimes` 本地提交，实际 ID 由 Git 记录。T04 的真实仓库验收见对应条目。

- [x] **T04 · 仓库配置与镜像同步**
  - 说明：建立仓库、基线和目标环境配置及受控 sources 镜像同步，接入当前项目读取和管理权限。
  - 可验收目标：在具名授权 Gitee 仓库实测 HTTPS 只读镜像同步和 SSH 提交验签。核对基线、非生产目标分支及发布 SHA，只允许 syncer 更新本地 sources，失败保留原发布结果。两项真实验证均通过后解锁 T05。
  - 前置：T00、现有预置项目；与 T03 协调项目配置契约。
  - 来源：D23、D8；工程实施基线关于 syncer 的职责。
  - 当前证据：项目私有登记、当前项目角色、SSH 验签、仅发布指定基线 ref、状态与命令防重已落地。方案和交付 A/B 均复审 APPROVE，隔离集成 11 项、全量 98 测试、E2E 17 项与追溯检查通过。见[最终交付证据](02-directory-and-engineering-design.html#t04-delivery-20261118)。
  - 真实验收：[Gitee HTTPS 只读镜像与 SSH 提交验签](02-directory-and-engineering-design.html#t04-gitee-live-20261118)均通过。在授权仓库以 `main` 为基线、`test` 为非生产目标，已发布 `ca2b445ebf2f9d1ad598ee69f9b59f178c1b524f` 并读回签名。T05 前置已满足，T09 继续单独按 GitLab 验收。
  - 交付修订：初始本地功能为 `feat: add repository baseline synchronization`，显式匿名配置和真实验收证据随 `feat: allow explicit anonymous repository mirrors` 本地提交。

- [x] **T05 · 需求工作树**
  - 说明：从镜像创建需求私有 bare 仓库及工作树，冻结 baseCommit，保存真实路径、分支和 workspace 映射。
  - 可验收目标：同需求共享约定工作树；会话 header cwd 精确归属需求目录；创建失败可恢复；开发动作不改变 sources 的 refs 和 worktree 登记；不引入子任务物理隔离或二级并行工作树。
  - 前置：T04 已通过授权 Gitee HTTPS 只读镜像同步和 SSH 提交验签。
  - 来源：I3-WRITE、D22、D23；需求私有 bare 与 worktree 的已选方案。
  - 交付证据：[需求创建与真实工作树](02-directory-and-engineering-design.html#t05-worktree-delivery-20261118)。真实 Gitee 已验镜像离线准备与恢复、冻结基线和同需求的真实 Native 工作区验证通过。独立复审通过，整仓 124 项、浏览器 28 项及基线校验通过。迁移 0008 仅应用隔离测试库，T06 前置已满足。

- [x] **T06 · 实际文件／Shell／Git 执行边界**
  - 说明：在隔离验证环境实现所需执行工具、文件与进程限制、沙箱和子进程管理，落实代码区和运行配置之间的边界；产品会话继续保持零执行工具，直到 T07 联合启用门槛通过。
  - 可验收目标：macOS 隔离验证中允许范围内能真实读写和运行测试；sources、其他需求、配置及凭据区域的越权操作实际被拒；文件工具不能直接破坏 Git 管理数据；AI 不能绕过平台自行 push；不使用 danger-full-access 扩权；保留 R-A／R-B 边界。Linux 对应实证归入 T21，不作为 macOS 后续任务的前置；T00 仍提前核查 Linux 能力与环境缺口。
  - 前置：T05；已明确公开接口、路径和进程控制方案。
  - 来源：I3-WRITE、D5、D8；安全边界与工程设计。
  - 交付证据：[macOS 隔离执行](02-directory-and-engineering-design.html#t06-execution-delivery-20261118)。真实 Seatbelt 文件、进程、网络及 Git 验收和独立复审通过。聚焦 12 项通过，最新整仓 129 项通过、2 项超时，超时用例分组复跑通过，类型、lint、格式、构建和基线校验通过。T07 的 macOS 前置已满足。产品执行工具按 T07 联合验收启用。
  - 已补验：[macOS 系统 Git 启动器](02-directory-and-engineering-design.html#t06-apple-git-launcher-20261120)。查到当前系统工具链的实际 Git 后，继续通过原有 Seatbelt 只读查询和最终启动授权。Apple Git 两套聚焦 17 项及 Homebrew Git 执行套件 12 项通过。

- [x] **T07 · 单写与安全交接**（已验收：macOS 隔离装配下首批 Read／Edit／Write／Shell／本地 Git 与双人红到绿旅程经用户走查通过 2026-11-24；其他平台写入口准入归 T21）
  - 说明：工作台提供「设为可写会话」，按当前项目及需求开发角色、本人会话和需求独占写权，协调数据库授权、实际执行进程和停止确认。
  - 可验收目标：同需求同时只有一个实际写会话；先封旧写权，旧任务及子进程确认停稳后交接；异常留痕，状态未知等待系统核验，期间保持只读；租约过期不冒称已停止；恢复／派生重新鉴权，取得写权前刷新上下文；测试人员会话代码只读。首批 Read、Edit、Write、Shell 和本地 Git，验收实际隔离、回环模型正文和红灯到绿灯的双人工作台旅程。macOS 写入口完成全部边界检查后启用，其他平台各自验收。
  - 前置：T02、T06 的 macOS 隔离执行边界验收；无需等待 T21。
  - 前置核对：T02 用户侧验收及 T06 macOS 隔离验收均已满足。
  - 已确认规则：本项目及本需求开发成员可为本人会话接手。替代原开发负责人／未完成子任务的额外条件及原持有人须先释放的规则。[决定台账](00-decision-ledger.html#t07-writable-session-20261121) · [完整验收](02-directory-and-engineering-design.html#t07-writable-session-acceptance-20261121)
  - 已交付子项：[隔离单写与停稳交接](02-directory-and-engineering-design.html#t07-isolated-write-handoff-evidence-20261120)。一次性受管 PostgreSQL、真实 T05 工作树与 macOS Seatbelt 核对一个写代、旧进程停稳及下一会话实际写入。定点 19 项、整仓 273 项、静态检查和基线通过。产品工具接线、运行状态恢复及编队 UI 继续按 T07 验收。
  - 接线前核对：[Native 工具与受管模型请求](02-directory-and-engineering-design.html#t07-native-tool-wire-evidence-20261120)。从锁定 SDK 的三个实际回环请求核对文本、工具声明及历史。记录同库所有者复用、当步工具限定及后续联合验收。
  - 接线前核对：[Native 声明与执行的独立边界](02-directory-and-engineering-design.html#t07-native-tool-boundary-evidence-20261120)。正式 Host 实际模型回包在已声明和无声明场景中都受现有根守卫，执行体零入口。锁包对照复验声明后撤权、无声明及许可执行一次。14 项邻域和故障反例通过。
  - 已交付子项：[共享 BFF 所有者与写资格撤销](02-directory-and-engineering-design.html#t07-shared-bff-delivery-20261120)。真实 PostgreSQL 借用终止、独立后端回查及断开客户端后的关停均通过，A/B 交付复审批准。整仓 308 项、静态、构建及基线通过。本地提交，待 Native 写工具与编队联合验收。
  - 已本地交付联测：[锁版 Native 工具与父 Broker](02-directory-and-engineering-design.html#t07-native-parent-broker-evidence-20261120)。实际工具经测试 IPC 调用受管 BFF Broker，验证一次写入、原键复核、旧代拒绝、释放在途拒新及停稳换代。双面复审、邻域 22 项、整仓 309 项和基线通过。
  - 已本地交付联测：[正式 Native Host 单次工具授权](02-directory-and-engineering-design.html#t07-native-host-tool-permit-evidence-20261120)。经真实私有 IPC 验证原运行、当步、参数、时限与一次消费，拒绝错会话及取消后迟到许可，实际合成模型续步收到原关联结果。双面复审、整仓 320 项和基线通过。真实工作树写入与物理取消继续接线。
  - 已本地交付子项：[父 Broker 逐调用取消](02-directory-and-engineering-design.html#t07-broker-call-cancel-evidence-20261120)。真实 PostgreSQL 和 macOS 用例覆盖起跑前零写入、实际进程组退出、原键回读、写代续用、主动释放交错和停稳不明时保留占位。双面复审、邻域 33 项、整仓 320 项和基线通过。正式 Native 与父 Broker 的执行控制继续接线。
  - 已本地交付联测：[正式 Native 与父 Broker 执行控制](02-directory-and-engineering-design.html#t07-native-broker-control-evidence-20261120)。真实短 IPC、隔离 PG 和 T06 验证一次写入、失答按原键回查、原生取消、主动关闭及断连后物理停稳。双面复审、邻域 46 项、整仓 321 项和基线通过。
  - 已本地交付联测：[Workbench Prompt、父 Broker 与工具出站](02-directory-and-engineering-design.html#t07-workbench-tool-wire-evidence-20261120)。同一受管 macOS 测试 BFF 验证真实登录、固定工具单次写入、实际 TLS 续步、两种释放顺序与步骤过期时的零首写。双面复审、整仓 323 项、浏览器 48 项和基线通过。
  - 已本地交付子项：[编队会话目录与固定切点回放](02-directory-and-engineering-design.html#t07-fleet-directory-delivery-20261120)。真实会话目录、派生源信息与已选会话的独立回放位置可在需求级页面读取，失权后卸载旧状态。独立复审、整仓 323 项、浏览器 50 项和基线通过。
  - 已本地交付子项：[受管写权状态](02-directory-and-engineering-design.html#t07-write-status-evidence-20261120)。隔离 BFF 使用真实 PostgreSQL 与 Broker 确认投影持有、停止中、空闲和待确认，按原观察登录限制详情，出站重新采样。双面终审、整仓 324 项、浏览器 51 项及基线通过。
  - 已本地交付子项：[写权命令准入与原回执核对](02-directory-and-engineering-design.html#t07-write-command-admission-evidence-20261120)。释放在合格预检后仅封闭本需求原代，原回执独立只读核对，旧键回放及无权请求期间实测合法写代继续运行。真实提交失答、回滚、到期、兄弟需求实写及回环 TLS 零首写通过。
  - 已本地交付子项：[受管编队申请、核对与释放](02-directory-and-engineering-design.html#t07-fleet-write-commands-evidence-20261120)。真实浏览器双登录使用同一受管 BFF，覆盖丢答、原键、新登录、停稳前拒绝、换代实写及关停。实际文件执行沿隔离 Broker 夹具。
  - 已本地交付联测：[浏览器换代与锁版 Native 写入](02-directory-and-engineering-design.html#t07-browser-native-handoff-evidence-20261120)。新写会话通过真实浏览器 Prompt、Native、FD3、Broker 和实际回环 TLS 后写入固定工作树，回执与持久原生日志对应，镜像指纹保持。
  - 已本地交付联测：[本人派生和新写代](02-directory-and-engineering-design.html#t07-fork-write-reauthorization-evidence-20261120)。在受管 Chromium、隔离 PostgreSQL 和工作树中证实子会话无法复用源写代，实际分派失效时拒绝申请，恢复分派后以最新版本取得新代并写入，随后确认进程组停稳。整仓 340 项、浏览器 51 项、受管 Chromium 1 项及基线通过。
  - 已本地交付联测：[独立 BFF 异常退出与冷启动](02-directory-and-engineering-design.html#t07-owner-crash-evidence-20261120)。受限进程在原 BFF 收到 SIGKILL 后继续运行，原票被拒。实查进程组停稳并换票后，冷启动对原需求保留未结占位，拒绝旧键重放和新申请，空闲需求可循环申请与释放。整仓 341 项、隔离聚焦和基线通过。
  - 已本地交付联测：[原会话恢复与重新验权](02-directory-and-engineering-design.html#t07-recovered-session-evidence-20261120)。纯文本历史的同一本人会话在停稳换代后以新登录恢复，拒绝旧登录、原申请键重放及无分派的写申请。实际阶段和任务分派变化后，新代使用最新上下文完成一次 Native 固定工具写入。历史带工具记录的出站按当前闸门拒绝。整仓 341 项、普通浏览器 51 项、受管浏览器 1 项及基线通过。
  - 已本地交付子项：[受管主动接手与新资格](02-directory-and-engineering-design.html#t07-writable-takeover-evidence-20261121)。真实 PostgreSQL 0017、编队浏览器和受限工作树验证无任务开发成员可接手、排空后换代、双阶段失答、并发、异常退出、迟到原回执及旧会话拒写。双面独立复审，整仓 343 项与 1 条件跳过、受管 Chromium 1 项、静态及基线通过。遗留执行缺可信进程身份时持久保持只读。完整 T07 和 T08 仍按联合验收前置推进。
  - 已本地交付子项：[受管监督执行与停稳取证](02-directory-and-engineering-design.html#t07-supervised-stop-evidence-20261121)。真实受管 paused BFF、PG 原执行回执和同一 runId 绑定。两个真实崩溃停点分别证实零起跑与受信监督者独立停稳。保留非零退出和热回执缺确认时的原占位。双面复审、定点邻域 28 项、整仓 357 项与 1 条件跳过、静态和基线通过；正式工具与冷端消费继续推进。
  - 已本地交付子项：[接替实例精确补结算](02-directory-and-engineering-design.html#t07-cold-stop-recovery-evidence-20261121)。隔离 PostgreSQL、真实工作树和多个真实 BFF 进程证实浏览器之外的同键冷续作、已授未确认的空持有退休、原执行异常保留和新会话实写。缺可信证据的旧执行保持只读。双面复审、定点邻域 37 项、整仓 366 项与 1 条件跳过、静态和基线通过。正式工具和双人红到绿旅程仍待完成。
  - 已本地交付子项：[受管内部源码 Read 与分段](02-directory-and-engineering-design.html#t07-read-snapshot-evidence-20261121)。只读身份可在写执行活跃或旧占位未确认时读真实工作树。实际 UTF-8 分段、真实撤席与关停边界、双面独立复审、17 项定点和邻域、整仓 370 项与 1 条件跳过、静态及基线通过。锁版 Native 和回环出站仍待接入。
  - 已本地验证[配置指向的真实单测与写权接手](02-directory-and-engineering-design.html#t07-configured-test-handoff)。同一测试文件第一次真实退出 1（预期 6、实得 3），修改实现后退出 0。第二开发会话重读最新代码并接手，旧代的文件写入、Shell 和 Git 请求均拒绝。回环模型读取失败输出和完整工作台旅程继续单独验收。
  - [DSH Read 与受管工作树的隔离兼容性验证](02-directory-and-engineering-design.html#t07-native-read-provider-fixture)覆盖真实原生参数、行号、续页、修改后重读和跨字节页的 UTF-8。单行截断后的尾部不能用原生行 offset 补齐。正式调用及回环实际收取仍待验。
  - 已实现：[持锁授权与 TLS 首写的同一失效边界](02-directory-and-engineering-design.html#t07-t13-failure-boundary-plan-20261123)与[实施交付证据](02-directory-and-engineering-design.html#t07-t13-failure-boundary-evidence-20261123)。窗口机制四件套（末次确认往返、等待者守门、原连接提交证书、失证单发封存）以 opt-in 包装接入 T07 Read 出站路径；A1–A10 定点红绿通过（红跑退出 1、绿跑退出 0）；双面独立评审两轮已通过（round-2 pass，非阻塞项已落定），T13 双路第二消费者与正式 Read 工具开启待办。
  - 已实现（隔离装配、opt-in，随双人旅程用户侧走查通过 2026-11-24）：[锁版 Native Read 回环联合验收](02-directory-and-engineering-design.html#t07-native-read-loopback-plan-20261123)与[联合链路交付证据](02-directory-and-engineering-design.html#t07-native-read-loopback-evidence-20261123)（含 [A 段扩展点证据](02-directory-and-engineering-design.html#t07-native-read-loopback-a-evidence-20261123)）。七跳链路在一次性受管 PostgreSQL、真实登录的 Workbench Prompt、锁版 Native、T05 工作树与回环 TLS 供应商上端到端接通：页窗口授权扩锁（L15）、武装回调同轮复核、Read 专属单次许可、根守卫按名分派、stat 元数据操作、续段登记、FD3 读服务与 FD4 正文投影落地；L1、L3、L4、L6（页帧／页请求／证书一一对应）、L9–L11、L13（无写代与保护路径）、L14 在联合链路先红后绿（联合 2 项、扩展点 44 项；3 次实跑 18 情形、37 次 read 与许可、20 次续段登记、页＝帧＝证书 41），L2 六类在父端重证，L5／L7／L8／L12 的机制级注入与 L6 逐行联结、L13 并发写代情形沿 §11.20.25 与 §11.16.17 继承或未装配、未在 Native 页上重证；按表清点全部落入清单。双面评审与正式 Read 工具开启待办，本项状态不变。
  - 续段告知通道已由 §11.20.26／§11.20.27 的锁版截断标记携带续段标识与续段登记实现，随双人旅程走查通过；真实模型供应商下的正式启用仍需专项授权。[用户走查通过与 A-5 知情接受](00-decision-ledger.html#t07-user-acceptance-20261124)。
  - 已实现（隔离装配、opt-in，用户侧走查通过 2026-11-24）：[写工具启用与双人联合旅程方案](02-directory-and-engineering-design.html#t07-write-tools-joint-plan-20261124)已按 A、B 两段实施，交付证据见[A 段](02-directory-and-engineering-design.html#t07-write-tools-a-delivery-20261124)与[A、B 两段联合](02-directory-and-engineering-design.html#t07-write-tools-joint-evidence-20261124)；方案经双面独立评审通过，评审的非阻塞发现已作步骤 0 补遗落入本节；交付评审结论：A 面 round 1 通过、round 2 终字节确认通过，B 面 round 1 通过、round 2 终字节确认的 5 项低位发现（取消路径未释放、空转用例、拒绝文案、有界性取证、文档与截图）已在本提交前的修复轮落定，见修复轮证据。
  - 已实现（隔离装配、opt-in，用户侧走查通过 2026-11-24）：[写工具 A 段交付](02-directory-and-engineering-design.html#t07-write-tools-a-delivery-20261124)与[A、B 两段联合交付证据](02-directory-and-engineering-design.html#t07-write-tools-joint-evidence-20261124)。步骤 0 补遗、解除监督执行与 mediated 工具的合装禁令、Write／Edit 监督回环（许可→Broker→T06 回执通道→FD4 工具投影）、写权绑定与命令集随写代冻结；B 段补齐 Shell（封闭命令集、两层输出处置、1 MiB 预算与续读）与本地 Git 只读回环、同一 BFF 内多运行武装、受管 Chromium 双人红到绿旅程（A 设为可写会话→写首个单测→登记命令跑红→续读→修正→跑绿→Git，B 读最新文件后接手，A 旧会话三类调用被拒）。W1–W19 与 R1–R20 中本节两段列明的判据先红后绿：新测试 5 文件 22 项、T06 回执与保护位置 2 项、受管 Chromium 3 项通过，邻域 6 文件与探针邻域通过，窗口关闭红跑分布不变，静态检查返回 0，运行后无残留；诚实边界见证据段（浏览器旅程的长输出只在回环中证、R10 关停路径与 R18 三个点未分别驱动）。双面交付评审各 round 1 通过后，[提交前修复轮](02-directory-and-engineering-design.html#t07-write-tools-repair-evidence-20261124)落定证据不实两项（旅程按本轮等待、分块重组真实）、失败时放行一项（位置解析失败即拒绝输出）、兜底正对照、资源释放与未确认停稳处理及精度回写；受管 Chromium 3 项两次通过。本项状态不变：用户侧验收未翻转，T08 不解锁。
  - 来源：I2-AUTH、I3-WRITE、I3-CONTEXT。

- [ ] **T08 · 变更查看与交付快照**
  - 说明：提供真实 diff、受控提交和不可变候选快照，分别记录历史候选、当前候选和后续实际合入结果。
  - 可验收目标：差异与工作树一致；提交只包含选定范围；快照记录需求提交和冻结基线；后续修改不改写历史快照；没有执行证据时不显示“已提交”或“已交付”。
  - 方案已交付：[T08 变更查看与交付快照方案](02-directory-and-engineering-design.html#t08-delivery-snapshot-plan-20261124)。
  - 已实现（步骤 0 精度补遗 9 条、快照两表迁移与应用角色 revoke 守卫、受控提交链、快照写入与锚点校验、变更查看 D2–D5、证据投影 E1–E3、S5 与双人旅程）：[T08 A 段交付证据](02-directory-and-engineering-design.html#t08-delivery-snapshot-a-evidence-20261124)、[T08 B 段交付证据](02-directory-and-engineering-design.html#t08-delivery-snapshot-evidence-20261124)（双锚点：[方案 §11.23](02-directory-and-engineering-design.html#t08-delivery-snapshot-plan-20261124)）。A 段 C1–C5、S1–S4 与反例 N2/N4/N6–N9，B 段 D2–D5、E1–E3、S5 与反例 N1/N3/N5 各自先红后绿，邻域、受管 Chromium 旅程与静态检查通过；待验收状态不翻转。
  - 前置：T07。
  - 来源：I3-DELIVERY、D22、D23。

- [ ] **T09 · GitLab 首次交付闭环**
  - 说明：受控推送需求分支、创建 MR、观察人工合入并精确回写。
  - 可验收目标：真实完成一次交付；只推送允许的 rdws/*；原提交、集成 cherry-pick 提交及 merge／squash SHA 分开；回写指向实际合入快照；故障和重试不重复交付；不自动批准或合入 MR。
  - 前置：T08；具名授权 GitLab 测试仓库、服务账号权限、受保护分支规则及人工合入人就绪。T04 的 Gitee 只读证据不能代替 T09。
  - 来源：I3-DELIVERY、D8、D23、D24。

- [ ] **T10 · 增量交付、环境映射与回退**
  - 说明：支持显式同步基线、冲突处理、增量 MR、多仓库／环境映射以及按版本生成 revert MR。
  - 可验收目标：同步使用 fetch＋merge，不 rebase 或强推；未合入 MR 更新与合入后增量区分准确；多仓库部分失败可聚合展示；环境矩阵与映射可核对；回退经 MR 人工合入，拒绝时环境保持原状。
  - 前置：T09。
  - 来源：I3-DELIVERY、D22、D24。多环境映射不等同于 F05 自动编排。

- [x] **T11 · 完整需求维护**
  - 说明：补齐批量导入、需求编辑、参与者及负责人维护，处理人员变化与已有子任务的关系。
  - 可验收目标：同页上传、动态显示解析和校验进度、逐条预览和就地修正；全部通过后显式整批提交入库，同页逐条显示结果。预览与校验不写业务数据。按当前项目角色维护参与者和负责人，移除或更换时须为未完成子任务指定有资格的接手人并保留原分派，已有阶段及任务权限保持有效。
  - 已交付子项：[需求资料编辑](02-directory-and-engineering-design.html#t11-details-delivery-20261119)。项目管理员或本需求的有效需求经理可编辑标题、说明与验收标准，原命令可重试并保存事务历史。实际 Native 验证冻结请求及下一步读取新资料。独立复审、整仓 141 项、浏览器 30 项和基线校验通过。
  - 已交付子项：[参与者、负责人与任务承接](02-directory-and-engineering-design.html#t11-personnel-delivery-20261119)。原命令同事务记录人员变更与分派历史，已验证需求内多登录撤权、同项目其他需求继续使用，以及终态重开时的接手资格。独立复审、整仓 154 项、浏览器 31 项和基线校验通过，无新增迁移。
  - 已交付子项：[批量导入](02-directory-and-engineering-design.html#t11-import-delivery-20261119)。UTF-8 CSV 和 XLSX 支持同页预览、修正和整批入库。结果未知可按原命令核对。逐项回读需求链接与工作树状态。双面方案与独立交付复审、整仓 164 项、浏览器 32 项和基线校验通过。交付修订以本地 `feat: import requirements with atomic batch receipts` 为准。
  - 前置：T03。
  - 来源：I3-TASK、I2-STATE、I2-AUTH；有效的批量导入与指派目标。

- [ ] **T12 · 上下文管理**（待验收：会话模板读回和需求背景维护已本地验证，待用户侧验收）
  - 说明：支持允许范围内的需求背景维护、模板引用及生效状态展示。
  - 可验收目标：可编辑背景与数据库业务事实分开；阶段、分派和权限以数据库为准；新推理边界读取当前上下文；历史原样保留；无权或读取失败阻断新步骤并保留重试内容；不显示没有证据的“已消费”。
  - 已确认首版编辑权限：当前项目管理员或本需求有效需求经理。开发负责人按兼具的有效身份授权。[背景维护与推理快照方案](02-directory-and-engineering-design.html#t12-background-plan-20261120)
  - 前置：T11、T14。
  - 已本地交付子项：[会话模板版本](02-directory-and-engineering-design.html#t12-session-template-status-evidence-20261120)。复用 T14 已交付的模板绑定和 Native 冷恢复，按所选会话展示实际记录的版本。验证了绑定变更、派生、冷启、出站撤权和损坏定义。独立复核、整仓 283 项、浏览器 44 项和基线校验通过。只读模板状态与需求背景维护分别验收。
  - 已本地交付子项：[需求背景维护](02-directory-and-engineering-design.html#t12-background-evidence-20261120)。当前有权编辑者在上下文页单独保存，Native 下一步读取当前背景，旧冻结快照保持原样。双面复审、真实 PostgreSQL 旧行迁移和整仓 309 项通过；浏览器 46 项首轮通过，两项超时复跑通过，另有 Native 拒绝及超时用例 2 项通过。
  - 来源：I3-CONTEXT、D21；已有上下文同步契约。

- [ ] **T13 · 模型与供应商管理**（进行中：本人选模、明确改选和未知来源子会话手动发送已在隔离工作台验证，已验证可唯一归因的来源直接手发，待分层配置、附件和具名部署）
  - 说明：适配 DSH 原生配置界面和授权作用域，支持平台、项目和个人的分层选择。
  - 可验收目标：配置使用原生 Provider／Profile／Credentials；项目只使用允许集合；个人只在允许范围选择本次会话模型；平台锁定项不能被下级覆盖；普通 DTO、日志与页面不暴露凭据；不另建模型调用权威。
  - 已确认的选模验收：本人可在同一会话反复选择允许的模型，在下次本人有权发送时重验并应用。已选模型被停用或移出允许集合时，保留待发送输入，提示重新选择可用模型，由用户再次发送，无自动默认回退。验收分别核对保存、实际 Native 生效、撤权和其他会话隔离。详见[时点和验收](02-directory-and-engineering-design.html#t13-send-time-acceptance-20261118)。
  - 已确认的出口及派生验收：统一受信出口须让实际发出与撤权同序，逐次校验主请求、重试、上传和后台标题。遇到派生前缀中的未外发模型选择，子会话须由本人明确选模后才能首次发送。历史前缀及快捷新建规则继续适用。部署方须确认瞬时处理正文和认证头的边界。DSH 统计与计量后续对接。见[决定台账](00-decision-ledger.html#t13-egress-fork-decisions-20261119)和[验收判据](02-directory-and-engineering-design.html#t13-egress-fork-acceptance-20261119)。
  - 已确认的 D1、D2：A 保存失答可明确改选 B，服务端确认 B 后迟到的 A 不能覆盖，确认前保留草稿、确认后手动发送。父选择生效未知时允许派生和查看历史，子会话首次发送前由本人明确选择当前可用模型（可同值），再手动发送。[决策台账](00-decision-ledger.html#t13-choice-recovery-20261121) · [验收场景与 DSH 复用边界](02-directory-and-engineering-design.html#t13-choice-recovery-acceptance)
  - 已本地验证 D1 服务端：[明确替代未确认保存](02-directory-and-engineering-design.html#t13-superseded-save-plan)。同一事务保存新修订并登记原键终态，迟到请求无法覆盖。既有成功原键仍读回历史修订。草稿保留、手动发送与 D2 另验。
  - D2 已本地验证[正式接口派生和回放](02-directory-and-engineering-design.html#t13-pilot-native-fork-read)。同值修订生效未知时可派生、读取继承历史和重查原键。
  - D2 已本地验证[子会话明确选择后发送](02-directory-and-engineering-design.html#t13-explicit-child-model-plan)。子本人同值保存取得独立修订，保存零推理。冷启后显式发送在冻结后再改选时仍命中原子修订，本地步和 Note 均在继承历史之后。下文记录已生效来源的直接发送对照。
  - [隔离试点工作台的选模、改选与手动发送](02-directory-and-engineering-design.html#t13-model-workbench-choice)已接入本人操作区。真实浏览器覆盖迟到 A、丢回执后刷新与纯读核对、未入箱后显式按原键提交、目录缺项后重选、子会话同值选择。普通及旁观会话沿原显示。正式分层配置和产品走查继续单列。
  - 已实现：[项目级分层允许集合的试点方案](02-directory-and-engineering-design.html#t13-layered-allowset-plan-20261122)与[交付证据](02-directory-and-engineering-design.html#t13-layered-allowset-evidence-20261122)。0018 迁移新增 `project_model_allowlist` 及最小权限回收，项目管理员经既有项目配置授权面维护，`readPilotModelOptions` 投影改为「Native 目录 ∩ 冻结策略 ∩ 允许集合」并保留无集合回落与冻结生效边界。七条判据定点测试先红后绿全过；用户侧验收另行确认。
  - [二次派生切点取证](02-directory-and-engineering-design.html#t13-nested-fork-evidence)已覆盖真实父、子、孙。未明确选模的孙会话可读祖先消息，主动发送得到 409，派发和持久首写均零行。两代继承标记和完整前缀与各自来源、截止核对。
  - [已生效来源直接发送](02-directory-and-engineering-design.html#t13-proven-fork-send)在本机试点验证。父确切修订已有成功推理、固定前缀可完整核对时，子无需重新保存即可手动发送；同源兄弟遇父同值新修订时仍需显选。正式配置和具名部署按原判据。
  - 已确认的历史图片规则（T13-A2）：同一本人会话默认只发送文字。可一键「沿用上一张图」，输入框显示可移除缩略图，选择仅随本条消息生效。发送时重新核对当前登录、本人会话和适用模型外发权限。[产品决定](02-directory-and-engineering-design.html#t13-history-image-rule-20261120)。
  - [历史图文后的默认文字续聊](02-directory-and-engineering-design.html#t13-default-text-after-image)已在本人暖态根会话的受管附件装配验证。第二轮保留两条用户原文，回环未收到旧图，原生保留首轮图文。冷启缺证仍拒绝；显式沿用、缩略图与正式工作台附件接线另验。
  - [受信程序化选择与本条沿用](02-directory-and-engineering-design.html#t13-explicit-history-choice)使用真实 Native 来源、缩略图和一次选择原键。移除后发送零图，再选并手发时仅本条当前消息实收一张，后续纯文字零图。公开浏览器附件路由、缩略图交互与完整用户走查仍待正式首写门槛。
  - 前置：T03；已核实所需原生公开配置接口。
  - 来源：D2、D19；台账模型配置权威。
  - 当前证据：[原生授权核查](02-directory-and-engineering-design.html#t13-native-evidence-20261118)及[会话选模验证](02-directory-and-engineering-design.html#t13-session-model-evidence-20261118)。通过 Host 公共会话能力写入原生选择，目标会话冷启动后仍能读取，另一会话与实例默认值保持原值。普通浏览器授权继续拒绝配置读取和直接选模。分层配置与用户选模入口待接线。
  - 已交付子项：[模型目录响应脱敏](02-directory-and-engineering-design.html#t13-catalog-boundary-20261118)。BFF 保留正常目录及可用模型，供应商故障使用稳定提示，原生诊断保留在服务端边界内。
  - 已交付子项：[会话底部模型状态](02-directory-and-engineering-design.html#t13-model-status-20261118)。展示原生已记录模型或实例默认。选模写入方案经双面审阅进入修订，重点是撤权、并发准入、刷盘确认及派生后的实际路由。
  - 已交付子项：[浏览器推理故障响应](02-directory-and-engineering-design.html#t13-inference-failure-boundary-20261118)。HTTP／WS 区分正常消息、推理失败与重试诊断，原生数据保留。工作台继续支持上下文阻止提示和原消息恢复。选模写入方案继续走独立安全闸门。
  - 新验收证据：[刷盘与恢复后选路](02-directory-and-engineering-design.html#t13-model-dispatch-evidence-20261118)。强制退出后复用 Native 状态完成两次本机合成推理，目标模型与实例默认分别命中。新的保存与发送方案待复审和实现，原短事务等待 Native 方案继续未准出。
  - 已交付修复：[同键提示词提交竞争](02-directory-and-engineering-design.html#t13-prompt-overlap-evidence-20261119)。重叠发送只允许首个请求持有和清理运行，竞争返回 409，其余会话和串行原键沿用现有 Native 路径。独立复审、整仓 180 项、浏览器 32 项及追溯通过。
  - 已交付修复：[旧标签页的原登录绑定](02-directory-and-engineering-design.html#t13-native-login-binding-evidence-20261119)。Native HTTP 与 WebSocket 按页面原登录校验，Cookie 更换后旧页停发。同账号登录变化后的原草稿可在当前页复制，重新打开后以新登录读取。独立复审、整仓 183 项、浏览器 34 项、本机 Native 断连和追溯校验通过。逐次推理授权和本人选模入口仍待交付。
  - 实现前验证：[发出前的传输证据](02-directory-and-engineering-design.html#t13-provider-dispatch-probe-20261119)。已在锁定版本的 PiAi HTTP 路径核对首次推理、429 后重试及独立后台标题。夹具可阻断指定的实际请求，标题原生记录可追溯到原消息。产品授权方案继续按 §11.16.7 复审。
  - 已交付子项：[首消息标题的受管出口](02-directory-and-engineering-design.html#t13-title-wiring-evidence-20261120)。锁定 Native、隔离受管 PostgreSQL 和本机 HTTPS 核对原消息刷盘、主轮释放、登录撤权与实际标题写出。双面交付复审、定点 20 项、整仓 278 项及两组浏览器共 44 项通过。开关限定在回环集成夹具，正式环境、附件外发和会话选模继续按各自判据验收。
  - 实现前验证：[DeepSeek Messages 与 Files](02-directory-and-engineering-design.html#t13-deepseek-messages-dispatch-probe-20261119)。回环实证核对上传、内联回退、缓存文件引用及扩展准备失败，确认 Files 与 Messages 各有实际外发边界。工作台图片输入及产品逐次授权未在此探针启用。
  - 已本地交付验证子项：[附件正文证据](02-directory-and-engineering-design.html#t13-attachment-wire-evidence-20261120)。真实受限 Native 的上传、内联和缓存引用生成可供逐次授权比对的字节及位置摘要。聚焦 6 项、独立复审、整仓 293 项、静态及基线通过。
  - 已本地交付验证子项：[附件变体与原入箱证据](02-directory-and-engineering-design.html#t13-attachment-variant-evidence-20261120)。原会话的领取图片关联实际转换和两次出站尝试。另一会话虽产生相同变体，夹具因原入箱缺少该附件拒绝上传及内联回退。聚焦 7 项、整仓 294 项、独立复审、静态及基线通过。
  - 已本地交付隔离子项：[附件上传与回执的独立首写](02-directory-and-engineering-design.html#t13-attachment-loopback-egress-evidence-20261120)。回环 TLS 验证 Files 与 Messages 各自授权、回执定域和结果不明时的重传拒绝。聚焦 38 项、整仓 298 项、独立复审、静态及基线通过。
  - 已本地交付隔离子项：[签名 Native 与附件回环首写联查](02-directory-and-engineering-design.html#t13-native-attachment-relay-evidence-20261120)。真实锁版 Native 的原签名绑定分别完成上传与缓存 Messages 首写，归因报头不上送。另一签名会话发送相同缓存 ID，HTTPS 零新增且无回复。聚焦 43 项、整仓 300 项、独立复审、静态及基线通过。正式图片接纳、跨代持久回执和具名部署仍待验收。
  - 已本地验证隔离子项：[Native 附件缓存冷启核对](02-directory-and-engineering-design.html#t13-native-attachment-cold-evidence-20261120)。同一原会话换用新 Native 和新出口，SDK 用持久缓存引用同一文件 ID。两项受信清单齐备，缺当前回执时实际仅出现载体 Messages，本轮失败且无新增 TCP、首写、上传或内联。独立复审、聚焦 43 项、整仓 300 项、静态及基线通过。正式跨代持久回执与上传结果不明的核对继续验收。
  - 已本地验证隔离子项：[附件分路首写与数据库撤权定序](02-directory-and-engineering-design.html#t13-attachment-postgres-evidence-20261120)。真实受管隔离 PostgreSQL 中，Files 与引用已确认回执的 Messages 都以原登录进入锁等待。撤权提交后两路均无锁内首写、解密应用字节及 HTTP 请求。有效登录重新绑定后，两路正常完成。独立复审、聚焦 45 项、整仓 301 项、静态及基线通过。
  - 已本地交付隔离子项：[本轮可信附件清单](02-directory-and-engineering-design.html#t13-native-attachment-manifest-evidence-20261120)。RDWS Access 对齐签名原消息、领取和真实模型变体，ContextRuns 按调用冻结，经受管 PostgreSQL 验证首写。实测顺序重复图、429 回执复用、内联回退、丢 ACK 和撤权。双面方案与交付复审、邻域 59 项、整仓 306 项、静态及基线通过。工作台图片接纳仍待历史授权、其它原生上下文路径和持久回执等验收。
  - 已本地交付隔离子项：[SDK 图片说明清理](02-directory-and-engineering-design.html#t13-attachment-handle-evidence-20261120)。按签名摘要剥离 DeepSeek 生成的图片说明，独立 HTTPS 实收证明图片对象路径和显示名去除，用户原文、上传与回执保留。缺证明和实际 offload 失败闭合。双面复审、聚焦 66 项、整仓 310 项、静态及基线通过。
  - 已本地交付隔离子项：[原生工作目录提醒投影](02-directory-and-engineering-design.html#t13-working-directory-projection-evidence-20261120)。同一无图会话的两轮原快照保持，出站只替换可信提醒的绝对目录。HTTPS 实收确认用户手写的同一目录句和其它上下文保留，错承诺及锁内变更零应用写入。双面复审、邻域 69 项、整仓 313 项、静态及基线通过。
  - 已本地交付隔离子项：[新选图片的原登录准入](02-directory-and-engineering-design.html#t13-native-image-intake-evidence-20261120)。真实 Native 暂存的正规 ID 绑定原登录和单个原请求，经入箱、领取、真实 PG 首写和 HTTPS。并发、退休后复放、撤权、完整正文后的断开、Unicode 分块和丢确认均有实测。双面复审、邻域 73 项、整仓 317 项、静态及基线通过。
  - 实现前验证：[入箱领取选模与派生边界](02-directory-and-engineering-design.html#t13-claim-selection-probe-20261119)。实际排队发送确认本轮原模型及下轮目标模型，阻止后仍可能把未外发的选择带入派生。后续以已确认的出口及派生验收为准，现有证据用于实施方案。
  - 已交付修复：[冷恢复后首次新发送](02-directory-and-engineering-design.html#t13-queued-recovery-evidence-20261119)。已刷盘的旧输入保留在 Native 原始日志。新的有效入箱才取消缺少运行绑定的旧活动项，首次新发送完成，旧键在再次冷启后仍可核对。独立复审、整仓 187 项、浏览器 34 项、本机 Native 通知故障回归及基线通过。
  - 实现前验证：[Native 模型出口的本机隔离](02-directory-and-engineering-design.html#t13-native-egress-confinement-20261119)。锁定版 DSH 在 macOS IPv4 回环中可经出口完成 PiAi、DeepSeek Files 和 Messages，系统拒绝计划外直连，出口关闭后同进程发起新请求失败。同一 Native 进程的 Web 端点持续可访问。独立复审、整仓 190 项及基线通过。正式 Host 接线、端点身份与撤权定序按 §11.16.17 继续验证。
  - 已交付子项：[Native 上下文回调迁移](02-directory-and-engineering-design.html#t13-native-context-ipc-20261119)。上下文读和释放走正式 Host 继承的 IPC，移除了后续隔离对 BFF HTTP 回调端口的依赖。无 BFF 监听时的真实 Native、两种故障后原文重填及合成供应商零到达通过。独立复审、整仓 195 项、浏览器 39 项、故障浏览器 2 项及基线通过。模型外发与其授权定序继续按 §11.16.17 实施。
  - 已交付子项：[正式 Native 环回传输直连](02-directory-and-engineering-design.html#t13-native-loopback-direct-20261119)。BFF 的 HTTP 和 WebSocket 上游直达已选 Native 环回地址。代理开启时真实启动、历史和跟随可用，合成供应商收到当前上下文，代理无新增到达。独立复审、整仓 198 项、浏览器 39 项及基线通过。正式暂停与模型出口接线仍按 §11.16.17 推进。
  - 已交付子项：[正式 Native 暂停外发与恢复](02-directory-and-engineering-design.html#t13-native-model-egress-pause-20261119)。macOS 支持每次 BFF 启动确定暂停模式，进程禁止主动联网，在鉴权后、入箱前拒绝提交。真实同页暂停与恢复保留草稿、旧键和会话历史，暂停期供应商零新增。独立复审、整仓 201 项、浏览器 40 项、真实模式切换 1 项及基线通过。正式统一出口及其逐次授权与撤权定序仍按 §11.16.17 实施。
  - 已交付子项：[Native 继承模型通道](02-directory-and-engineering-design.html#t13-native-inherited-model-carrier-20261119)。内部受限 Host 经 FD 4 完成锁定适配器的 PiAi、DeepSeek Files 和 Messages，验证取消、各次尝试、共享上传与物理直连阻断。独立复审、定点 8 项、整仓 209 项、浏览器 40 项和基线通过。BFF 仍只接受 direct 和 paused，正式外发授权和撤权定序继续按 §11.16.17 实施。
  - 已交付子项：[主推理步骤绑定与逐次授权](02-directory-and-engineering-design.html#t13-native-model-attempt-authority-20261119)。锁定版 Native 与测试 PostgreSQL 验证 429 重试时复验原登录、会话和有效选模。标题及携带同 Note 的独立流被拒绝，项目错配及载体关闭时供应商零新增。独立复审、定点 35 项、整仓 224 项、浏览器 40 项和基线通过。实际外发与撤权定序、其他用途授权和 BFF 启用待交付。
  - 实现前验证：[TLS 供应商请求的实际传输定序](02-directory-and-engineering-design.html#t13-model-egress-transport-boundary-20261119)。本机 Node 24.20.0 以真实 TLS 和独立 TCP 观察点区分准备、零字节、受控密文前缀与完整交付。先撤权时零到达，先完整交付时供应商可在撤权后处理，握手前排队反例已复现。独立复审、定点 18 项、整仓 232 项、浏览器 40 项及基线通过。正式同库所有者、实际撤权入口、全部用途与部署验收继续推进。
  - 已交付修复：[退出登录的持久撤权确认](02-directory-and-engineering-design.html#t13-confirmed-logout-20261119)。以原会话行消失确认退出，数据库删除或核对失败时返回 503 并保留 Cookie。工作台必须核对原观察登录，旧标签页无法退出换入的另一登录。实测独立与冷启 BFF、Native 并发通知及浏览器重试。独立复审、定点 24 项、整仓 239 项、浏览器 44 项及基线通过。实际外发统一定序继续按 §11.16.17 交付。
  - 已交付子项：[同库授权所有者与持久栅栏](02-directory-and-engineering-design.html#t13-database-authority-owner-20261119)。隔离库实测同一启动凭据的两个 BFF 只准一个启动，其他普通连接不能写授权来源。数据库断开或 BFF 强制终止保持原代次，完整关停才可释放。独立复审、定点 26 项、整仓 246 项、浏览器两分片合计 44 项和基线通过。迁移 0011 已在一次性测试库验证。部署启用与实际供应商写入继续按 §11.16.17 验收。
  - 已交付子项：[TLS 1.3 主推理转发与首次写入](02-directory-and-engineering-design.html#t13-tls13-first-write-20261119)。真实 Native、PostgreSQL 与回环供应商串联验收。先撤权时零写入，先写入时本连接可完成，完整验证的 429 才开放下一次物理写入。诊断泄露、截断 429 和 TCP 首段计数复审通过。定点 37 项、整仓 260 项、浏览器两分片合计 44 项和基线通过。正式供应商和具名部署接线继续按 §11.16.17 验收。
  - 接线前置：[实施范围与路由拆分](02-directory-and-engineering-design.html#t13-egress-integration-plan)。协调检出 `main` 由既有协调者串行处理 BFF 工作台、Native 适配、相关测试和验收文档。R-01 已通过独立复审和整仓回归。
  - 评审续办：[Q1 合成供应商取证](06-implementation-review-report.html#s10-delivery)覆盖 `session/state`、`session/events` 与锁定版未注册的 `session/summary` 错误响应。其余读取与事件投影继续验证。R-08 的两次活动名单复核与取消补偿已通过[定点验收](02-directory-and-engineering-design.html#t13-egress-reconcile-evidence)。
  - 评审交付：[R-05 历史与模型目录投影](02-directory-and-engineering-design.html#t13-main-bff-egress-evidence)已通过受控响应和真实 Native 合成供应商验证。合法正文、附件、序列及位置保留。
  - 正式接线一阶段：[主推理验收](02-directory-and-engineering-design.html#t13-main-bff-egress-evidence)。隔离库及本机 HTTPS 合成供应商验证先撤权零外发、先首写可完成以及 429、关停和受管暂停回退。生产选模、派生首次选模、标题／附件和具名部署仍按 §11.16.17 验收。
  - 已补验：[正式 BFF 退避中撤权与诊断采样](02-directory-and-engineering-design.html#t13-main-bff-backoff-evidence)。原登录在 429 退避时退出后，供应商 HTTP 和完整正文均零新增；有权对照正常重试。父 BFF 与隔离库日志的双标记检查、独立复审均通过。
  - 已补验：[同一步跨登录](02-directory-and-engineering-design.html#t13-main-bff-login-batch-evidence)。真实 Native 第二步同时领取两个登录的输入。较早登录撤权后，第二步零应用写入及零 HTTP 到达，有权对照含两条正文并完成。独立复审及 28 项聚焦测试通过。动态选模方向和待核对行为见[交叉评审记录](02-directory-and-engineering-design.html#t13-dynamic-model-technical-review-20261120)。
  - 实现前补验：[Native 模型投影与实际外发](02-directory-and-engineering-design.html#t13-native-last-used-evidence-20261120)。在真实首写前撤权后，读取原生 `lastUsed` 可见模型，供应商仍零到达。派生验收以实际首写证据判断既有选择是否已经外发。
  - 已交付子项：[受管项目模型目录](02-directory-and-engineering-design.html#t13-mediated-model-catalog-20261120)。公开入口按当前项目的冻结策略和 Native 可路由记录公布精确模型。实例默认保留原生配置，受管 paused 沿用原生目录。方案和交付独立复审、整仓 268 项、浏览器 44 项、真实 Native 本机模式切换及基线校验通过。
  - 实现前核对：[Native 首消息标题的来源](02-directory-and-engineering-design.html#t13-title-origin-evidence-20261120)。独立技术裁决及安装包内存探针确认标题插件作用域内的实际调用可与原始消息序列关联。
  - 实现前核对：[完整领取后的原生选模时点](02-directory-and-engineering-design.html#t13-selection-boundary-evidence-20261120)。锁定 Native 在同一轮的下一步按完整同修订批次命中目标模型。不同修订同批终态为阻止，即使模型相同，供应商第二次 HTTP 仍为零。独立复审、反例和 5 项原生邻域通过。该探针为保存、发送授权和派生提供实现依据。
  - 实现前核对：[原提示词接纳的原生只读证据](02-directory-and-engineering-design.html#t13-prompt-observation-evidence-20261120)。活动会话显式刷盘后核对物理序号，冷启查证无 Agent 创建、零日志变动、供应商零新增，并排除继承的输入和换 Peer。两项故障反例和原生邻域 5 项通过。
  - 已复审方案：[保存本人会话选模并在发送时生效](02-directory-and-engineering-design.html#t13-saved-session-model-plan-20261120)。第三轮 A/B 均通过，明确持久原票据、只读原键查证、当步新增和同轮累计原登录，以及试点派生和回退。共享 PG 池已完成独立复审与同库验证。
  - 已本地交付隔离子项：[本人会话选模](02-directory-and-engineering-design.html#t13-session-model-pilot-evidence-20261120)。真实 BFF 保存与读回、0014 升级至 0015、锁版 Native 按原提示词选择修订发送至两个回环模型。已验证原键失答、实际退避、撤权和关停。定点两项、整仓 343 项（1 项既有条件跳过）、Chromium 51 项、双面复审及静态校验通过。固定切点派生仍需持久首写证据。
  - 已本地交付隔离子项：[模型实际首写的持久证据](02-directory-and-engineering-design.html#t13-first-write-receipt-evidence-20261120)。0015 升级至 0016，真实 Native、TLS 与 PostgreSQL 核对原步骤坐标、首写及失答。双面复审、54 项邻域、整仓 343 项（1 项既有条件跳过）、Chromium 51 项、静态和基线通过。固定切点派生继续按原判据接入。
  - 已本地交付隔离子项：[零写与事务确认](02-directory-and-engineering-design.html#t13-first-write-zero-write-plan-20261120)。确认零写允许新尝试，原授权失答继续占用。真实撤权与活动相邻会话错配均零写，已首写失答实收 16,384 字节密文及零完整请求。双面独立复审、终稿定点及 34 项邻域、整仓 343 项（1 项既有条件跳过）、Chromium 51 项、静态和基线通过。固定切点派生仍待验证。
  - 已本地验证隔离子项：[固定派生切点的只读取证](02-directory-and-engineering-design.html#t13-fixed-fork-evidence-delivery-20261121)。真实回环两模型、停稳后的锁版 Native v4 父子原始日志和最终数据库回执分别核对领取、原生选模事件、实际首写及精确继承。同值新修订无原生选模事件时保留未知。独立终审、终稿定点 4 项、邻域 9 项、整仓 374 项与 1 条件跳过、静态及基线通过。产品派生门禁继续待验收。两类保留情形（未知首写仅 prepared、选模接纳后未形成步骤）已在同一隔离夹具端到端实测为保守拒绝：子会话无继承来源、prompt 409 文案精确、供应商零新增，两处门禁变异分别定向红灯（退出码 1）、恢复后重跑 7 项通过。
  - 已本地验证隔离子项：[本人当前保存修订的首写回证](02-directory-and-engineering-design.html#t13-saved-model-first-write-readback-evidence-20261121)。试点本人 GET 核对原保存修订的准备状态或已确认首写，错 Host、账号、项目或会话均不构成证据。真实冷读零 Native 启动与供应商连接。独立终审、邻域 31 项、整仓 375 项与 1 条件跳过、静态及基线通过。正式界面和产品派生门禁待验收。
  - 已本地验证隔离子项：[锁版 Workbench SDK 被动跟随](02-directory-and-engineering-design.html#t13-pilot-passive-follow-evidence-20261121)。真实 Chromium 验证有未决消息的冷会话打开和重连无 Agent、领取或外发。另一个本人会话实际经 SDK 发文本并收到流式和最终回复，供应商实收已预设模型。普通同构帧及直接活化、越权、WS Prompt、旧登录反例通过。双面终审、邻域 17 项、整仓 377 项与 1 条件跳过、普通 Chromium 51 项、受管 2 项、静态及基线通过。完整选模操作和产品派生门禁待验收。
  - 已本地验证修复：[试点模型目录查询故障](02-directory-and-engineering-design.html#t13-pilot-catalog-failure-evidence-20261121)。现有本人保存和发送分别区分目标供应商查询失败与健康缺项。实际故障零业务派发与供方连接，恢复同键可用，已保存回执继续按原键读取。独立终审、邻域 31 项、整仓 377 项与 1 条件跳过、静态及基线通过。
  - 已整合工程子项：[附件清单与图片准入分支](02-directory-and-engineering-design.html#t13-local-branch-consolidation-20261120)。附件来源证明、SDK 图片说明投影、工作目录投影及新选图片原登录准入已合入 `main`。双面复审、88 项邻域及静态检查通过。正式图片入口、历史复用、选模和具名部署仍待继续验收。

- [ ] **T14 · 能力白名单与模板**（待验收：软件及隔离 Native 验证完成，待运营制品与用户侧验收）
  - 说明：维护已审核插件、技能、MCP 白名单，生成和调整需求 preset。
  - 可验收目标：白名单外能力不能使用；模板可配置和校验；生成 preset 的作用域与权限明确；preset 变更只影响之后创建的会话，不悄悄扩大旧会话权限。
  - 已确认的绑定验收：只允许当前项目管理员绑定或更换平台已发布的确切模板版本，变更只影响之后新建的会话。验证跨项目、撤权、其他角色、未发布版本及旧会话在线和冷恢复。详见[绑定和验收](02-directory-and-engineering-design.html#t14-binding-acceptance-20261118)。
  - 前置：T03。
  - 来源：D21、I4-UI；上游公开扩展边界。
  - 已交付子项：[平台白名单登记](02-directory-and-engineering-design.html#t14-allowlist-delivery-20261118)。平台管理员可登记和停用精确审核版本，并核对原命令和当前清单。新增迁移已在隔离测试库验证。
  - 已交付子项：[项目能力模板版本](02-directory-and-engineering-design.html#t14-template-delivery-20261118)。平台管理员发布只引用已审核精确版本的项目模板，项目成员读取本项目版本和停用状态。正式页面待用户侧视觉验收。
  - 已交付子项：[需求模板绑定配置](02-directory-and-engineering-design.html#t14-demand-binding-delivery-20261119)。项目管理员可绑定确切版本、重放原命令并读取当前配置。隔离测试库迁移 0009、独立复审、整仓 137 项、浏览器 29 项和基线校验通过。
  - 已交付修复：[模板绑定登录隔离](02-directory-and-engineering-design.html#t14-binding-login-20261119)。旧页面跟随原登录，换账号后写入拒绝并保留原命令，原账号重新登录可同键核对。独立复审、整仓 142 项、浏览器 30 项和基线校验通过，无新增迁移。
  - 实现前探针：[原生冷恢复](02-directory-and-engineering-design.html#t14-native-preset-evidence-20261118)与[原生在线装载](02-directory-and-engineering-design.html#t14-native-preset-live-20261118)验证固定版 DSH 对精确 ID、同 ID 覆盖和装载失败的实际行为。
  - 已交付子项：[Native 会话装载](02-directory-and-engineering-design.html#t14-preset-delivery-evidence-20261119)。新建冻结绑定与发布制品摘要，派生读取原生有效版本，已有会话按需恢复原定义。独立复审、整仓 166 项、浏览器 32 项及基线校验通过，无新增迁移。
  - 已确认[首批运营候选与隔离验收](02-directory-and-engineering-design.html#t14-first-operational-candidates-20261120)。在单一隔离项目的「需求验收准备」模板中验收插件「验收会话提示」、手动技能「需求验收清单」与 MCP「需求资料只读」。待平台审核制品来源、精确提交和 SHA-256。首轮 MCP 验证离线定义与会话内可见性，实际连接和调用等待 T07 准入与具名环境授权。
  - 已本地验证隔离子项：[首批运营候选源码及摘要](02-directory-and-engineering-design.html#t14-acceptance-candidate-evidence-20261121)。锁版 Native 证实同一合成模板作用域、手动技能、静态 MCP、错作用域及摘要错配拒绝、冷恢复和零供应商连接。独立终审、邻域 11 项、整仓 375 项和 1 条件跳过、静态及基线通过。候选待平台审核与正式登记。

- [ ] **T15 · 统计与配额**
  - 说明：先明确计量维度、配额规则与超限行为，再展示真实会话用量和项目配额。
  - 可验收目标：用量有可核对来源；未知数据明确显示未知；统计限定当前授权作用域；配额与超限行为按确认规则执行；不从流帧数推算或伪造 token、费用及性能承诺。
  - 前置：T02、T13。
  - 来源：D19；统计视图仅针对当前会话的边界。

- [ ] **T16 · 轨迹与独立哈希锚点**（待验收：持久锚点与自动截止已交付，待正式环境和用户侧验收）
  - 说明：提供轨迹读取、事件详情、摘要导出及原始持久前缀的独立哈希校验。
  - 可验收目标：原生日志保持轨迹权威；区分持久记录与逻辑回放补齐；校验者只读日志、仅追加锚点；锚点含稳定截止位置与 hash；篡改或截断能被检测，不复制第二份权威消息日志。
  - 前置：T02。
  - 来源：D7；台账 AuditEvent／SessionIndex／LogAnchor 模型；T02 的 P／C／B 边界。
  - 已交付子项：[会话轨迹页](02-directory-and-engineering-design.html#t16-trace-delivery-20261118)复用 T02 已验证的被动历史，提供固定切点分页、事件详情及已读摘要。用户侧视觉验收待完成。
  - 已交付子项：[原始日志前缀核对](02-directory-and-engineering-design.html#t16-raw-prefix-delivery-20261118)可对受信字节截止计算或校验 SHA-256，已用真实 Native 压缩原件核对。
  - 已交付子项：[独立持久锚点](02-directory-and-engineering-design.html#t16-anchor-delivery-20261119)。隔离 0010 迁移、独立 PostgreSQL 登录、真实只读挂载、原键核对和留卷重启通过。独立复审、整仓 168 项、浏览器 32 项与基线通过。
  - 已交付子项：[自动确定物理截止](02-directory-and-engineering-design.html#t16-automatic-cutoff-delivery-20261119)。可信静止快照可按完整 JSONL 行或 Zstandard 帧自动记录原始字节截止。实际只读挂载与留卷重启、独立复审、整仓 178 项、浏览器 32 项及基线通过。正式环境只读授权和轨迹页用户侧验收仍待完成。
  - 已确认[首轮正式验收](02-directory-and-engineering-design.html#t16-named-preproduction-acceptance-20261120)。用户指定本机 Docker 为具名隔离环境，当前检出预检 21 项通过。部署方与 DBA 提供停稳刷盘快照、独立非 root 只读身份和目标库专用账号，验收后回收凭据。真实锚点、权限反例、篡改与恢复、用户走查四项全部通过后结项。

- [ ] **T17 · 审计中心**（进行中：业务与权限审计、执行摘要及锚点联查已验证）
  - 说明：按授权范围查询业务、执行、权限和交付事件，提供详情与导出。
  - 可验收目标：事件可关联真人、需求、会话和结果；跨项目越权被拒；审计只追加；输出不含凭据；事件与原生轨迹可追溯但不混成第二份日志权威。
  - 前置：T03、T16。
  - 已本地交付子项：[需求业务审计](02-directory-and-engineering-design.html#t17-requirement-business-audit-evidence-20261120)。在有权需求的档案中读取统一版本上界下的业务事件、详情及当前页 CSV。采用现有需求和项目权限，复用 T16 已验的分页和导出边界。独立复核、整仓 284 项、浏览器 44 项及基线通过。
  - 已本地交付子项：[项目业务检索](02-directory-and-engineering-design.html#t17-project-business-audit-evidence-20261120)。审计中心按实际授权需求检索、分页和导出。覆盖 PG 微秒、同一时间戳 ID 排序、出站撤权和切项目。独立复核、整仓 285 项、浏览器 45 项及基线通过。
  - 已本地交付子项：[项目权限变更](02-directory-and-engineering-design.html#t17-project-access-audit-evidence-20261120)。当前项目管理员可查角色及管理员席位变更，查看前后角色并导出当前页。独立复审、整仓 286 项、浏览器 46 项及基线通过。
  - 已本地交付子项：[平台账号状态审计](02-directory-and-engineering-design.html#t17-platform-account-audit-evidence-20261120)。当前平台管理员在「账号状态」下查看真实停用与恢复记录并导出当前页。独立复审、整仓 287 项、浏览器 47 项及基线通过。
  - 已本地交付子项：[跨项目业务检索](02-directory-and-engineering-design.html#t17-cross-project-business-audit-evidence-20261120)。在「全部有权项目」检索已经授权的需求事件，查看来源和导出当前页。独立复审、整仓 288 项、浏览器 47 项及基线通过。
  - 已本地交付子项：[物理锚点只读投影](02-directory-and-engineering-design.html#t17-session-anchor-projection-evidence-20261120)。应用按真实项目、需求、会话及当前登录读取已提交摘要。隔离迁移、真实 Native 原件、独立复审、整仓 288 项及基线通过。
  - 已本地交付子项：[物理锚点工作台联查](02-directory-and-engineering-design.html#t17-session-anchor-readback-evidence-20261120)。可从业务事件进入锚点模式，按授权会话读取和导出当前页。独立复审、整仓 289 项、浏览器 48 项及基线通过。
  - 已本地交付子项：[会话执行事件摘要](02-directory-and-engineering-design.html#t17-session-execution-audit-evidence-20261120)。可查看调用请求、结构化拒绝、返回结果和未知状态，按固定逻辑切点分页并导出当前页。真实 Native 根守卫、独立复审、整仓 290 项、浏览器 48 项及基线通过。
  - 剩余验收包含 T07 联合验证时的实际执行及可归属执行人、真实交付事件，以及正式环境下的独立原件核验。
  - 来源：I2-AUTH、D7；服务账号拆权和逐次调用审计约定。

- [ ] **T18 · 运行维护、恢复与归档**
  - 说明：补齐实例状态、故障提示、doctor／worktree 修复、冷备恢复及受控归档清理。
  - 可验收目标：故障可定位；修复可重复执行，失败时明确不可用；恢复后工作树和映射一致；归档先停稳并导出；清理按明确确认与保留规则执行，不自动删除历史运行数据。
  - 前置：T05、T07、T09、T16。
  - 来源：D6、I3-WRITE；工程与安全边界。当前 PoC 的保留数据要求继续有效，归档细节在本任务中先确认。

- [ ] **T19 · 平台设置与可复现交付**
  - 说明：补齐平台策略、风险登记、供应链／许可核查、可运行交付包及安装说明。
  - 交付包前置证据：同步器、需求工作树编排与共享运行配置已纳入私有工作区包。包化见[评审报告 §10.5](06-implementation-review-report.html#s10-delivery)。
  - 可验收目标：设置有真实执行点；干净环境可按说明安装启动；许可及 NOTICE 材料齐全；已知依赖风险如实记录；不把功能验收或旧审计记录当作生产发布结论。
  - 前置：T03、T13、T14。
  - 来源：D2、D13–D16、D20、服务账号拆权／轮换、供应链约定、SECURITY.md 与 THIRD_PARTY_NOTICES.md。

- [x] **T20 · 设计系统页**
  - 说明：展示工程实际使用的令牌、字阶、主题、断点和组件状态。
  - 可验收目标：展示与实际样式一致；加载、空、忙碌、无权、失败和重试状态有真实示例；页面保持只读。
  - 前置：T01。
  - 来源：设计基线和 Demo 的 design 视图。
  - 执行归属：既有协调者 `codex-t00-2c7273ae` 在主工作树串行实施。[工程方案](02-directory-and-engineering-design.html#t20-plan-20261118)记录用户确认的已登录开放范围、只读示例与验收路径。
  - 当前证据：方案和交付独立复审均 APPROVE。`pnpm check` 通过（104 项测试及静态检查／构建），浏览器 23 项、基线追溯通过。覆盖三处入口、明暗主题五档宽度、访问和键盘约束，示例业务请求为 0。[交付证据](02-directory-and-engineering-design.html#t20-delivery-20261118)与功能随 `feat: add design system reference` 本地提交。
  - 已按首轮走查调整[组件状态布局](02-directory-and-engineering-design.html#t20-component-states-evidence-20261120)。卡片间距为 12px，重试和重置共用提示条内右侧位置，宽屏垂直居中，窄屏空间不足时在提示条内换行。浏览器 4 项、静态、构建及基线通过。用户于 2026-11-20 在更新至 `8b34740` 的本机预览中[复验通过](04-design-baseline.html#t20-component-states-review-20261120)。

- [ ] **T21 · Linux 真实闭环**
  - 说明：在干净 Linux 环境验证安装、实际执行权限、五会话、交付及重启恢复。
  - 可验收目标：同版本真实运行通过；补齐与 T06／T07 同等标准的 Linux 文件／Shell 拒写、sources 零写入、单写与进程停止实证；该平台写入口先通过联合启用检查，再进行受控真实交付与恢复；MR 回写及恢复均有实际证据；模拟和 macOS 通过不替代 Linux 验收。
  - 前置：T07、T09、T16；Linux 环境就绪。环境和关键能力在 T00 提前核查。
  - 来源：I5-RUN；台账阶段与验收要求。

- [ ] **T22 · 完整产品验收**
  - 说明：逐个核对 16 视图，贯通跨角色真实流程，完成故障回归、文档与用户最终验收。
  - 可验收目标：页面使用真实数据；纳入范围的入口有实际能力；明暗、响应式、键盘及错误状态通过；需求到合入回写可完整演示；用户确认 Demo 一致性；所有必需真实验收和未完成项均可追溯。
  - 前置：全部主线能力 T01–T21 完成对应验收；不要求 F01–F06 完成。
  - 来源：本文件确认范围、16 视图映射、当前有效业务和安全契约。

## 依赖与并行顺序

关键链路为：T04 → T05 → T06 的 macOS 隔离验证 → T07 → T08 → T09 → T10。T07 还依赖 T02；Linux 与运行维护分别满足各自依赖后接续。Linux 环境缺口阻塞 T21 及最终整体验收，不阻塞独立可验证的 macOS 单写和交付。

| 可启动条件                 | 可进入队列的任务            |
| -------------------------- | --------------------------- |
| 现有已批准切片             | T02 继续当前检查点          |
| T00 完成                   | 优先 T01、T04；有空位接 T03 |
| T01 完成                   | T20                         |
| T02 完成                   | T16                         |
| T03 完成                   | T11、T13、T14               |
| T04 两项真实验收通过       | T05                         |
| T05 完成                   | T06 的 macOS 隔离验证       |
| T11、T14 完成              | T12                         |
| T02、T13 完成              | T15                         |
| T03、T16 完成              | T17                         |
| T03、T13、T14 完成         | T19                         |
| T02、T06 的 macOS 验收完成 | T07，随后依次 T08、T09      |
| T09 及各自其他前置完成     | T10、T18、T21 可并行        |
| 主线能力完成               | T22                         |

最多同时 3 路独立工作包；任务只等待自己的前置，不等待同组所有任务。并行启动须满足前面的协调与资源登记：共享 schema、迁移序号、公共接口、同一文件当期写入者由唯一协调者确定，迁移和共享服务检查串行准入。T01 启动前与 T02 现有执行者明确对话页／主题的当期写入者；未验证可隔离的运行命令排队执行。各包集成验证后由协调者更新状态与证据，再领取依赖任务；当前会话或宿主对并行能力的限制仍然有效。

## 16 视图覆盖

视图按当前有效契约实现；Demo 中已被替代的阶段审批等行为不恢复。明确延后的入口说明边界，其余纳入范围的功能真实接线，不以假数据或假按钮充数。

| 视图 key     | 名称         | 功能主责 | 协作任务    | 当前正式实现                         |
| ------------ | ------------ | -------- | ----------- | ------------------------------------ |
| demands      | 需求管理     | T11      | T01 T18     | 部分：列表／新建／初始分派／批量导入 |
| overview     | 需求档案     | T11      | T01 T08     | 部分：资料／人员／子任务／阶段       |
| chat         | 对话         | T02      | T01 T07     | 部分：原生流／派生／回放已验收       |
| context      | 上下文       | T12      | T01 T14     | 部分：只读业务快照                   |
| fleet        | 编队         | T07      | T02 T06     | 部分：会话目录与固定切点只读回放     |
| changes      | 变更         | T08      | T09 T10     | 未建                                 |
| trace        | 轨迹         | T16      | T02         | 部分：逻辑轨迹、执行摘要、物理锚点   |
| audit        | 审计中心     | T17      | T16         | 部分：业务、权限、执行与锚点联查     |
| stats        | 统计         | T15      | T13         | 未建                                 |
| models       | 模型与供应商 | T13      | T03         | 未建；固定原生配置已可用             |
| members      | 成员与权限   | T03      | T17         | 部分：项目成员角色与撤权             |
| platform     | 平台设置     | T19      | T03         | 部分：项目、席位、账号状态及审计     |
| capabilities | 能力模板     | T14      | T03         | 部分：模板配置、Native 隔离验收      |
| space        | 运行空间     | T18      | T05 T06     | 未建                                 |
| repos        | 仓库与环境   | T04      | T05 T09 T10 | 部分：配置摘要与基线同步             |
| design       | 设计系统     | T20      | T01         | 部分：已通过 T20 用户视觉验收        |

## 单独保留的后续任务

这些任务属于后续阶段，不作为 T22 的前置。先明确各自规格与验收，再形成实施方案；列入清单不代表当前已授权实施。

- [ ] **F01 · 完整测试用例、执行与 Bug 管理**
  - 说明：定义用例 → 执行 → 缺陷 → 修复 → 回归 → 验收闭环，不等同于主计划已经要求的实际测试命令与结果验证。
  - 可验收目标：先确认状态、角色、数据关联和失败路径，再用真实任务贯通并验收。
  - 前置：T03、T07、T11、T16、T17。

- [ ] **F02 · 真实部署执行与部署批准**
  - 说明：定义环境、执行方式、权限、批准、结果及失败恢复。
  - 可验收目标：先明确环境和批准机制，再贯通授权部署、结果回写及失败恢复；不恢复已撤回的逐阶段人员审批。
  - 前置：T09、T10、T17、T18、T21。

- [ ] **F03 · Docker 强隔离档**
  - 说明：独立明确 DSH 容器化及生产强隔离目标；数据库 Docker 不等同于 DSH 隔离。
  - 可验收目标：挂载、进程、网络和拒绝路径实际通过，剩余风险与部署方职责明确；不改写既有 R-A／C1 决策。
  - 前置：T06、T07、T18、T21。

- [ ] **F04 · Tauri 薄壳**
  - 说明：复用已验收的浏览器产品能力，薄壳不内嵌 DSH runtime。
  - 可验收目标：先明确桌面特有能力与分发边界，再验证与浏览器模式一致的业务旅程。
  - 前置：T22。

- [ ] **F05 · 多环境自动编排**
  - 说明：在人工受控环境映射和实际部署机制上定义自动编排及故障处理。
  - 可验收目标：先确认权限、人工边界、部分失败与恢复语义，再完成真实环境验收。
  - 前置：T10、F02。

- [ ] **F06 · 多机／HA／日志在线迁移**
  - 说明：作为独立架构任务明确状态归属、故障恢复、日志和工作树迁移。
  - 可验收目标：先形成独立批准方案，再用多机故障及迁移证据验收；单机冷备恢复不能冒称 HA 完成。
  - 前置：T18、T19、T21。

## 证据记录方式

各任务在实施检查点追加或更新一份最新摘要，详细记录以链接指向已有设计、评审和执行证据，不在此复制长日志。摘要使用以下字段：

```text
任务编号与当前状态：
执行者、分支／工作树、实际改动路径：
已满足的前置与依据：
对应代码修订、验证环境、实际命令、退出码／关键结果、证据位置：
协调检出上的集成验证结果：
适用的独立评审与用户侧验收：
未关闭偏差、阻塞和下一检查点：
```

本文件最初落地时只核对了项目指令、设计文档及工作区状态，未重新执行业务测试、模型调用或迁移；当时 T02 为进行中。当前状态与后续执行证据以任务条目为准，其余新增工作包未提前勾选；运行数据、凭据和原始轨迹继续保存在仓库外。

## 独立评审与修订证据

本次原始请求为：“先对这份开发任务清单做一次独立评审，发现问题直接修订。后续研发按清单的依赖顺序推进，完成一项就更新状态和验收证据。”用户明确允许本次使用全新上下文只读评审者。文档任务编排判为 R2 受约束产物，按双面强度检查其指导的执行、权限、并行与恢复边界；各实施任务仍单独分级。

首轮输入 SHA-256 为 `091061386f4cf7355bde8b382a9311d61a207ed524f4fb9435ed304a4b6778fd`；评审期间既有研发会话更新 T02 的进展、归属和证据，形成 `2520e3d7f7f98c23106919c40487f529d191b84ec347db4f49bb5ebe36f59fce`。两面确认所报问题在两版均存在；本次修订保留 T02 更新，不接管其实现或共享服务。

| 评审面／编号 | 首轮结论与发现                                                          | 核实及处置                                                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A／A1        | APPROVE_WITH_CHANGES；Major：T06 把 Linux 实证作为 macOS 交付的过早前置 | 对照台账“缺环境仅阻塞相关集成”及工程验收顺序，T06 明确为 macOS 隔离验证，Linux 对应实证移入 T21；T07 及并行队列同步，最终 T22 仍须 Linux 验收                                              |
| B／B1        | APPROVE_WITH_CHANGES；Major：T06 未明确写工具联合启用门槛               | T06 保留产品零工具；T07 通过身份、分派、独占写权和进程停止检查后才启用对应平台写入口；Linux 同样逐平台执行门槛                                                                             |
| B／B2        | APPROVE_WITH_CHANGES；Major：假设各命令天然支持三路资源隔离             | 核对 Playwright 固定 5317／3303 及数据库脚本固定 rdws-local，增加实际资源登记和命令可隔离性验证；不满足时共享检查串行执行，不抢占资源                                                      |
| B／B3        | APPROVE_WITH_CHANGES；Major：独立工作树缺少统一领取与状态权威           | 指定唯一协调者与协调检出，串行登记领取、逐项回写证据；旧清单副本不得覆盖最新状态；无法协调时保持串行                                                                                       |
| 作者补充核查 | 多项目验收未明确原生运行时的 PoC 特例                                   | 当前 workbench 对非 poc 返回运行时未配置，Host 的实例与需求路径仍固定 project-poc／poc；依据已确认 D4 多项目目标，T03 明确项目实例注册、路由、生命周期及双项目原生会话隔离验收，交复审核对 |

第二轮全量独立复审：A 面 APPROVE，B 面 APPROVE；A1、B1、B2、B3 全部关闭，T03 补充归位通过核对，无未关闭发现。A 面复审规范输入为 `446ef5bc7efc4a52866da07277bfe4530ebf86039ec5ab9bd9b0499678f9dc02`；期间既有研发会话仅更新 T02 的状态、归属与最终证据三行，形成 `26f1ad5037e8923f285c1073e0f7bbbaa4484d1e5c6de12d33783bfee570931d`，两面均核对该状态更新，B 面直接审阅后一版本。结论只覆盖任务编排，不替代 T02 或其他业务任务的实现验收；评审者均只读，未执行业务测试、模型调用或迁移。

后续任务严格按前置与协调登记领取。完成一项时，由唯一协调者核对集成结果并即时更新该项状态及验收证据，再推进依赖任务。本次编排复核结束时，T00 的关键接口／环境核查和协调登记仍未完成；后续 T00 执行结果已更新到任务首行与工程证据。T02 状态及证据以既有执行者维护的任务首行为准。

本轮文档验证：`pnpm exec prettier --check AGENTS.md docs/05-development-backlog.md` 与对应文件的 `git diff --check` 均返回 0；一次性结构检查确认 23 项主任务、6 项后续任务字段齐全且依赖无环，全部 16 视图有映射，27 处本地链接／锚点有效，T07 不依赖 T21 而 T22 仍依赖 T21。依赖检查器的合法样本通过，未知节点、自环及双节点环样本均被拒绝。上述证据仅验证清单结构与文档，不替代业务任务验收。

## 本地功能交付规则确认

用户随后明确要求完整功能交付时更新文档与进度、完成审阅并提交，并说明“提交无需授权，但不推送”。执行规则见 [AGENTS.md](../AGENTS.md#交付与指南维护)。

本轮规则及进度更新按 R2 持久指令完成单面独立审阅，结论 APPROVE、无发现项；既有 T02 实现继续复用双面交付复审及 74／8／12 项验证。只更新交付规则、进度与历史时点说明，代码／测试未改变；格式、diff 及本地链接／锚点检查通过。T02 实现与这些文档同批本地交付，对应功能提交见 T02 条目及 Git 记录。
