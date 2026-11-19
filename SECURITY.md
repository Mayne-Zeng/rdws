# 安全政策与残余风险

## 支持范围

本仓库已进入 **PoC 分阶段实现**，包含 Web / API、Docker PostgreSQL 初始化与预置账号认证；`demo/` 仍为 D18 假数据探索稿。已接入原生配置的 GLM 模型、Web 会话与实时流，并实现子任务分派、按钮式状态推进和带真人运行绑定的上下文同步；已实测 BFF、non-owner Native Policy，以及至少五个只读会话的恢复、本人派生和被动回放。派生通过 BFF 专用能力绑定本人源、切点和实际 workspace / cwd，原始参数在 Native codec 前校验；历史身份不继承运行权。代码写执行、单写交接、真实 GitLab 与 Linux 验收仍属后续阶段，当前不处理生产数据。因此不存在可按版本划分的安全更新支持矩阵；下文列的是设计口径里必须如实携带的残余风险，不是已修复的缺陷。

## 两条必须携带的残余风险

### R-A · 无 Docker 档的隔离强度（C1 不追认）

无 Docker 档下，AI 子进程与 `sources/` 位于同一主机。PoC 的 Agent 会话保持零执行工具。T06 提供独立的 macOS Seatbelt 验证入口，工作树外拒写，受管运行根和账户主目录读取受限，其余宿主路径沿用操作系统既有读权限。Git 管理数据由只读查询按需读取。网络、派生进程和链接创建受限。Docker PostgreSQL 不隔离 DSH。上游 `SAFETY.zh.md` 明确「沙箱、审批与权限控制不保证隔离」「不得作为不可信工作负载唯一的安全控制」。 [T06 隔离范围](docs/02-directory-and-engineering-design.html#t06-execution-plan-20261118)

用户未追认「生产 / 不可信负载必须启用 Docker 强隔离档、PoC 验收含该档」这一修订。因此：**本地基础档仅作为开发与功能验证档，不作为生产或不可信工作负载的安全边界**；面向真实项目组或生产数据时的隔离强度由部署方自行评估并承担风险，PoC 不覆盖生产档验收。

### R-B · 模型请求外发（D2 口径）

关闭 `dsh-session-log-deepseek` 与 OTel 遥测不会阻止模型请求外发。当前请求会发送对话文本与需求上下文；用户粘贴的源码也可能随文本发出。以后开放文件或 Shell 工具时，文件内容和命令输出也可能进入请求。若使用企业边界外的供应商，应在部署清单登记并确认数据合规；抓包验收由部署方执行。

## 项目隔离与登录撤权

BFF 从已鉴权需求的 PostgreSQL 归属选取 Native 实例。项目具有独立的签名密钥、代次、回调、工作区和短期票据。新的项目 Profile 由受信运行维护者私有配置。账户、项目角色和需求参与共同决定允许的操作，且发送只允许本人会话。管理入口不提供代码写入。宿主仍处于 R-A 所述的本地开发档。

Native 上下文读和释放沿正式 Host 启动时继承的子进程 IPC，按本代 ChildProcess 匹配请求和响应。BFF 保留原登录、需求和会话的权限复核，在回复成功快照前再次检查批次撤权及最早截止。超时、通道断开和无效回调均阻止该次上下文读。该通道当前仅承载上下文 JSON。 [验收证据](docs/02-directory-and-engineering-design.html#t13-native-context-ipc-20261119)

BFF 到本代 Native Web 的 HTTP 和 WebSocket 使用进程就绪时选定的环回地址直连。HTTP 校验完整 origin 后才写出签票，上游 WebSocket 禁用重定向。签名就绪、读取和跟随可在 BFF 启用全局代理时通过本机通道完成。 [验收证据](docs/02-directory-and-engineering-design.html#t13-native-loopback-direct-20261119)

BFF 按获准的 Native 流端点投影浏览器会话状态、列表、选模、队列、历史与通知。连接内的流 ID 不复用，取消和终态后的迟到帧不转发。公开错误保留已知代码并统一消息与详情。未公开的历史扩展以保留序号的空记录投影，已公开的需求快照保留正文与必要版本字段。模型目录递归核验公开字段。原始历史和派生位置继续由 Native 管理。 [范围与证据](docs/02-directory-and-engineering-design.html#t13-main-bff-egress)

在 macOS 启动 BFF 时可显式将正式 Web Host 设为 `paused`。新 Native 子进程的主动网络连接由 Seatbelt 拒绝，保留本机 Web 入站与继承 IPC。BFF 在核对真实登录、本人会话、请求身份和租约后，于认领前拒绝发送。沙箱失败会阻止启动。切换或回退前要求停止旧 BFF、Native 及独立 SDK；后续统一模型出口与逐次授权按 T13 的独立验收交付。 [暂停与恢复](docs/02-directory-and-engineering-design.html#t13-native-model-egress-pause-20261119)

受限 Host 可经继承 FD 4 将实际模型请求与读取取消交给父进程。受管 BFF 按一代冻结的文本主推理策略接线，启动拒绝可观察原始载体的诊断配置。运行账户只加载受信进程代码，运行期间不得动态附加载体诊断订阅。Native 继续管理供应商凭据。 [通道和接线范围](docs/02-directory-and-engineering-design.html#t13-main-bff-egress)

正式 BFF 的受管主推理对原登录批次、权限与本人会话采取持锁复核，并在同一同步段提交 TLS 首段。已提交的原连接允许完成。关停须先排空载体、在途事务与供应商 TCP，再释放数据库所有者。运行中维持同库受管位，DBA 确认停稳后方可变更。独立标题、附件接线及具名部署验收继续跟踪。 [逐次授权与定序](docs/02-directory-and-engineering-design.html#t13-main-bff-egress)

T13 附件正文验证按锁定的 Native 序列化核对实际 Files 与 Messages 字节，生成短时摘要、长度和线上图片位置。已提交上传回执、认证域、实际图片变体及每次请求的原授权共同决定缓存引用是否可用。生产传输仍由受管出口按各用途首写条件准入。[附件正文证据](docs/02-directory-and-engineering-design.html#t13-attachment-wire-evidence-20261120)

主推理 TLS 1.3 转发在锁定的 macOS Node 24.20.0 环境完成回环验收。受信回调在同一同步段复核授权与最早期限，提交加密首段。步骤中只有明确零写入或完整验证的供应商 429 可开放下一次写入。转发先检查 HTTP 诊断与 TLS keylog，回归用合成标记检查性能记录、输出和运行产物。正式供应商接线及部署诊断仍待验收。 [TLS 转发验证](docs/02-directory-and-engineering-design.html#t13-tls13-first-write-20261119)

停用与恢复写入账号代次，登录会话保存发行时的代次。数据库在插入时定序，业务读取和执行检查当前代次。旧登录不会在恢复后重新有效。单项目成员变动对该账号的同项目会话和连接生效。通知失败保留 BFF 截止与 Native 短租约两层不同的证据，已获准的外部请求可能完成。

退出登录通过签名 Cookie 定位原会话。工作台请求另带页面观察的登录 ID。查得会话与观察 ID 匹配后，才关闭本进程的工作台和运行准入。BFF 在 PostgreSQL 确认原会话行消失后才返回成功并清 Cookie。未确认时返回 503，保留原 Cookie 供重试。本实例 Native 通知结果单独反映在响应头，同账号其他登录仍按各自会话鉴权。 [退出验收](docs/02-directory-and-engineering-design.html#t13-confirmed-logout-20261119)

同库受管所有权通过 PostgreSQL 持久保存。领取时消费 DBA 预登记的单次启动凭据，并登记成功进程独立生成的运行证明摘要。DB 触发器要求本代证明才能写授权来源，普通应用角色无法登记凭据、修改私有状态或关闭触发器。进程退场或连接断开保留所有权。正常释放须等 HTTP、workbench 与 Native 完整关停。旧版和已有出口的离线隔离、实际供应商传输仍是正式启用前的独立验收条件。 [所有者设计与验证](docs/02-directory-and-engineering-design.html#t13-database-authority-owner-20261119)

Native 浏览器传输随页面打开时的登录固定。BFF 在准备工作区前核对 bootstrap 的观察登录，随后对 HTTP 和 WebSocket 核对 Cookie、实际需求归属及原绑定。WebSocket 升级前的授权代次贯穿上游 Peer 建立和后续流量。重连轮换短租约代次时沿用原绑定。原 Cookie 仍有效的连接按其原登录鉴权，撤权时关闭。旧页面发现换登录后释放连接，原草稿仅在当前文档内存保留，当前账号相同且需求授权读回后可复制。 [验收证据](docs/02-directory-and-engineering-design.html#t13-native-login-binding-evidence-20261119)

工作台的会话目录与被动历史也携带原观察登录。BFF 以 Cookie 认证并比对，在返回前复核需求读取权及撤权代次。两条 GET 使用 no-store，无头调用仍按当前 Cookie 及既有访问权限处理。工作台收到授权拒绝后清理相应的目录或历史，观察到登录更换时提示重新打开。 [验收证据](docs/02-directory-and-engineering-design.html#t02-passive-session-login-plan-20261119)

工作台新建和派生会话时也发送原观察登录。BFF 对这两条 POST 使用 no-store，以 Cookie 认证，并在查找需求、准备 Native 或处理回执前拒绝错绑请求。旧页收到 401 后保留待核对命令，同一账号重新打开需求会话后可用新登录核对。未发送观察头的接口调用继续按当前 Cookie 和既有写入权限处理。 [验收证据](docs/02-directory-and-engineering-design.html#t02-session-write-login-20261119)

## 仓库只读访问与基线发布

仓库地址、可信签名人和访问方式由运行维护者私有登记。显式 `credentialFile: null` 走匿名读取，Git 子进程无认证头。文件凭据绑定完整 HTTPS 地址，仅传入本次读取用的子进程环境，读取或认证失败时保留失败。两种方式均保留 TLS 校验，并禁用重定向、凭据助手和继承的用户 Git 配置。浏览器仅取得状态、提交 SHA 与签名指纹。

项目管理员通过项目作用域发起同步。syncer 在发布前核验可信 SSH 签名、配置快照及快进关系，短授权事务与停用、注销及撤权定序。T04 在具名授权 Gitee 仓库通过 HTTPS 读取与 SSH 提交验签。T09 的 GitLab 出站交付另行授权和验证。日常会话的物理执行隔离由 T06 验证，部署在受信运行账户及受管目录中。 [T04 真实验收证据](docs/02-directory-and-engineering-design.html#t04-gitee-live-20261118)

## 需求工作树准备

平台编排层从有同源成功回执的本地镜像读取冻结 SHA。Git 使用固定参数、私有 GitStore 与独立对象。目录领取、准备与就绪检查受平台路径和持久锁约束。计划需求通过就绪检查后才进入 Native。T06 的隔离适配沿用该就绪检查。产品代码写权限与写者交接由 T07 验收。 [T05 工程设计](docs/02-directory-and-engineering-design.html#t05-worktree-plan-20261118)

## 会话日志锚点

锚点取自独立运维方提供的可信只读来源与已确认的物理截止。校验命令只读原生日志，数据库仅保存坐标、摘要及记录时间。工作目录桶仅以摘要保存。专用直接登录不得拥有业务对象或继承角色权限，数据库在追加时核验项目与会话的对应关系。应用账号无法访问锚点表。可信挂载、截止与 DSN 的发放由部署方控制，校验账号是受信的摘要声明主体。 [T16 工程方案](docs/02-directory-and-engineering-design.html#t16-anchor-plan-20261119)

T17 的应用角色仅获准执行指定的只读函数，按有效登录、真实项目、需求和会话关联读取已提交的锚点摘要。函数仅返回不透明标识、物理截止、SHA-256 和记录时间。原项目及会话是持久记录标识，需求权限以当前会话绑定为准。独立校验仍由专用身份读取可信原件完成。[T17 工程方案](docs/02-directory-and-engineering-design.html#t17-session-anchor-projection-plan-20261120)

浏览器按原观察登录读取会话锚点。BFF 根据实际 Cookie 绑定身份，出站前再次校验有效期、项目和需求读权、会话归属及撤权代次。工作台的锚点模式读取已提交摘要，当前原件的核验与文件访问归独立校验流程。[锚点联查权限](docs/02-directory-and-engineering-design.html#t17-session-anchor-readback-plan-20261120)

会话执行事件沿用原观察登录及确切会话关联。BFF 仅为指定会话发出 Native 读取委托，出站复核当前授权。页面和 CSV 只读取脱敏逻辑摘要，原工具名、参数、错误正文及结果内容留在原始记录的受控读取范围。执行准入继续使用既有根守卫。[执行事件权限与状态](docs/02-directory-and-engineering-design.html#t17-session-execution-audit-plan-20261120)

自动截止只处理独立运维方提供的停稳原件或可信不可变快照。它在同一只读文件描述符上核对 Native 文件头、物理边界、摘要和可观察的文件变化。格式损坏、读失败或超出处理预算时停止记录。恢复核对保留原快照和原字节截止。 [T16 自动截止方案](docs/02-directory-and-engineering-design.html#t16-automatic-cutoff-plan-20261119)

## 需求模板绑定

绑定写入仅允许当前项目管理员，服务端锁定登录、账号、角色和需求，校验本项目的确切模板版本及当前审核引用。绑定与原命令回执同一事务持久化，成功、无变化与同键异文响应都重新检查授权。两条复合外键约束项目归属，应用角色只能更新模板 ID 和版本列。 [绑定配置验收](docs/02-directory-and-engineering-design.html#t14-demand-binding-delivery-20261119)

绑定面板的读写均携带页面打开时的登录标识。BFF 以 Cookie 认证，在查询需求前比对会话。登录变化时返回 401 并保留原账号的待核对命令。读接口仍支持使用当前 Cookie 的无头请求，写接口必须携带会话标识。 [登录隔离验收](docs/02-directory-and-engineering-design.html#t14-binding-login-20261119)

会话装载只接受随 RDWS 发布并通过当前审核的精确制品。Native 独立核验发布摘要、活动装载清单和需求工作区。浏览器只提交原命令标识，不能指定原生 preset 或模块路径。BFF 在会话分发事务使用原登录的绝对截止签发固定票据。历史按保留的定义适配原组合，停用版本拒绝新建和派生。执行权限继续由已生效的根工具限制和 T07 准入管理。 [Native 装载方案](docs/02-directory-and-engineering-design.html#t14-preset-delivery-plan-20261119)

## 需求资料编辑

当前项目管理员或在该需求保有项目需求经理身份的参与者才能编辑。浏览器发送页面已读取的登录标识，服务器以 Cookie 认证，核对两者一致后受理。原登录、原项目、需求和当前角色贯穿写入及结果返回。活动响应提供操作者和字段名，完整前后值留在业务事件。Native 按既有边界读取当前资料和事件摘要，浏览器编辑能力与原命令收据留在 BFF。 [资料编辑验收](docs/02-directory-and-engineering-design.html#t11-details-delivery-20261119)

## 需求人员维护与撤权

人员维护由当前项目管理员或兼具该需求参与关系的需求经理发起，按本次登录鉴权。事务校验有效角色和任务接手资格，人员、任务、历史与回执同事务写入。移除参与角色时，仅阻断所涉账号在当前需求的发出中 HTTP、转发、双向连接及新上下文。原提交未知时，服务器取回原需求行锁后核对原命令，不向触发核对的其他账号返回回执。提交确认后撤回该需求内所有相关登录，Native 通知失败时使用短 Peer 租约结束旧授权。同项目其他需求继续按其当前权限运行。 [人员维护验收](docs/02-directory-and-engineering-design.html#t11-personnel-delivery-20261119)

## 需求批量导入

CSV 和 XLSX 原文件在浏览器内解析。XLSX 解压受单项及总量限制，拒绝公式单元格、外部包关系与自定义 XML 实体。BFF 接收文本行，读取请求体前核对来源、Cookie、页面观察登录和项目创建权。预览事务只读。提交在事务内复查当前项目角色，需求、人员、初始任务、历史、冻结计划及成功回执一起入库。查询原回执须通过当前创建权限及对应需求读权限，响应禁止缓存。 [批量导入验收](docs/02-directory-and-engineering-design.html#t11-import-delivery-20261119)

## 当前依赖审计（2026-11-18，未修复）

本轮 `pnpm audit --prod --audit-level high` 返回 1：1 项 high、3 项 moderate。新增识别的高危为 `picomatch@4.0.7` 的重复 extglob ReDoS，[官方公告 GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) 当前列出受影响版本 ≤4.0.7、无修复版本。没有隐藏通告、修改上游源码或以未经验证的版本覆盖依赖。

对已安装 DSH 的静态核对未发现普通业务用户控制该 pattern 的入口：HMR 使用可信 Profile 的 `ignored`；Forge 使用构造配置，相关设置、插件和 Forge RPC 不在 BFF / Native 允许集合内，Agent 执行工具仍为零。Host 保留已有 Profile bundles，不能仅凭源码默认值断言任何私有实例绝未加载 Forge。此可达性判断不修复依赖，也不表示审计通过；以后开放配置、插件、Forge 或文件执行能力时须重评。当前交付仍限本地非生产功能验证，不构成发布授权。

## 漏洞报告

请通过 GitHub **Security Advisories**（仓库 Security → Report a vulnerability）或私信维护者提交，**不要**在公开 Issue 里贴未修复的漏洞细节。请附带：影响面、复现步骤、已确认的版本 / 文件、建议的缓解方式。

当前阶段没有 SLA 承诺；确认后会在决策台账或本文件登记处置结论。

## 不要做的事

- 不要把本仓库的原型当作生产可用的安全边界或验收依据。
- 不要在公开仓库提交真实凭据、模型网关地址、企业内部仓库地址或客户数据。
- 不要把 `.rdws/` 运行时数据、`$DSH_HOME` 会话轨迹、凭据文件提交进仓库（见 `.gitignore`）。
