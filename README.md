# RDWS · AI-Native R&D Workstation

面向项目研发全过程的多租户工程工作站。

> **当前状态：PoC 分阶段实现。** Web / API、Docker PostgreSQL、迁移与预置登录，以及需求分派、按钮式推进、动态上下文、五个只读会话的恢复／本人派生／被动回放已落地。详见[决策台账](docs/00-decision-ledger.html#implementation-20261117)和[当前执行证据](docs/02-directory-and-engineering-design.html#session-lifecycle-live-20261118)。Native 运行时可按已登记项目分别启动；代码单写、GitLab 闭环和 Linux 最终验收仍待完成。`demo/` 是假数据原型。

仓库：<https://github.com/Mayne-Zeng/rdws> · 维护身份：`Mayne-Zeng <rdws@mayne.cn>`

## 本地工程开发

需要 Node.js 24、项目固定的 pnpm 11.28.5，以及可用的 Docker / Compose。使用 `packageManager` 自动选择项目 pnpm，不修改全局版本。

```sh
pnpm install --frozen-lockfile
pnpm local:init
pnpm db:up
pnpm db:bootstrap
pnpm db:migrate
pnpm db:seed
RDWS_MODE=test pnpm db:migrate
RDWS_MODE=test pnpm db:seed
pnpm dev
```

打开 <http://127.0.0.1:5173>。API 在 `127.0.0.1:3001`，数据库在 `127.0.0.1:55432`；端口已被占用时先调整配置，不能覆盖其他服务。`db:up` 优先沿用 Docker 配置；默认 context 不可用且本机 Unix socket 可用时显式选该端点，不更改全局 context。

运行根默认为用户目录下 `.rdws`；自定义 `RDWS_HOME` 时使用仓库外的固定绝对路径。`local:init` 为 `admin / pm / manager / lead / dev / tester` 生成各自随机密码，开发和测试分别保存在运行根 `secrets/development-accounts.json` 与 `secrets/test-accounts.json`（权限 600），不输出到控制台。平台管理员不自动成为项目开发者，项目角色仍需显式分配。重复初始化与 seed 保留已有密码。

PostgreSQL 使用 `rdws-local-postgres-1` 和 `rdws-local_postgres_data` 命名卷，开发 / 测试库独立、应用账号不持有 schema。`pnpm db:status` 查看状态；`pnpm db:recreate` 仅重建本项目数据库容器并保留卷。不要以删卷方式重置数据。

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
```

`test` 使用独立测试库验证认证、分派 / 状态事务、并发、防重、上下文绑定与数据库权限；E2E 自动启动测试配置服务，验证业务按钮、断网 / 损坏响应重试，以及明暗主题下的登录、刷新、退出与窄屏。浏览器测试使用 5317 / 3303，避开日常开发端口。`build` 做全工程类型检查并生成 Web 构建产物；当前 API 通过 `tsx` 在本地运行，尚未提供生产部署包。

完整浏览器验收可顺序运行 `pnpm test:e2e --shard=1/2` 和 `pnpm test:e2e --shard=2/2`。每组单独启动测试 BFF，避免一轮所有浏览器会话读取累积在同一限流窗口。

模型已选 `GLM-5.3-Flash`，协议为 OpenAI Chat Completions。供应商参数、模型目录和凭据使用 **DSH 原生 Profile / Credentials**，RDWS 只管理授权作用域与引用。当前 `pnpm dsh:model:import` 可将已有运行根 `secrets/model.env` 一次性转换为 `runtime/dsh/project-poc` 下的原生配置；它不覆盖已有原生设置，后续从 DSH 设置机制维护。此命令只初始化文件，不安装或启动 DSH，也不验证真实模型调用。临时输入与原生凭据都不进 Git。

## Web 需求与会话

以 `manager` 或 `pm` 登录创建需求，明确选择参与角色、开发负责人和初始子任务；任务负责人默认开发负责人，也可从已选开发成员中指定。创建后由开发负责人维护子任务和分派，普通开发只能更新本人任务状态，普通成员按需求参与关系读取。需求开发负责人通过“进入开发”等明确目标的快捷按钮或“调整阶段”菜单操作，允许跳转和回退，逐次留痕，无需手打指令或二次审批。

进入需求后可新建本人会话并发送文本；同需求其他参与者可以读取会话，但不能代替所有者发送。本人会话可从最近已结束轮次派生一个同需求只读会话，保留来源和切点；正在进行的轮次不带入。派生历史不继承旧登录或运行权限，子会话首次发送重新鉴权并取得当前上下文。每次新推理步骤按当前真人登录及需求权限取得数据库一致快照，注入当前阶段和分派；已发出的模型请求不会被改写。读取失败会阻止新推理、提示原因并保留未执行消息。所有会话仍为代码只读，执行工具不开放。

“回放历史”固定首次读取的位置并向前分页，只展示安全的事件摘要和对话文本，不重新调用模型或工具。原生冷读可能在内存补齐中断轮次的结束事件，回放明确保留中断含义；这个逻辑视图不等同于每条事件都已写入原始日志。正常打开会话会按原生机制恢复，可能把恢复补齐写入日志，与被动回放分别处理。

创建 / 派生由界面生成并保存原操作标识；响应丢失或坏 JSON 时先“核对原操作”，刷新后仍可继续核对，不能另发一次创建。明确未派发的拒绝会终结原操作并恢复操作按钮；原生调用结果未知时不会自动重发。已知原生 ID 的映射失败可在重新鉴权后补齐，无可证明 ID 时保留待核对状态。旧 API 调用可省略 body 或传空对象，但省略 commandId 的不同请求视为不同操作，不提供跨请求防重。

网络结果未知时使用“重试原操作”：保留同一请求和内容，确认前冻结编辑，不重复新建需求或任务。业务成功与模型暂时不可用分开处理，已保存的状态不会因 DSH 离线回滚。

工作台通过原生 modules runtime、Session binding 和 eventSource 处理历史、实时 Assistant frame、settlement 与重连；业务页面自绘。`dsh/client` 收敛浏览器适配，Native Store 使用的 Zustand / Immer 是上游依赖，不作为 RDWS 业务状态方案。

发布的 `0.2.2-rc.3` 没有参考源码中的认证注册服务，因此 Host 采用公开载体组合：私有 `/_rdws` 路由认证后，把 non-owner Peer 显式交给原生 HTTP handler 与原生 mux。默认 owner 管理入口仍存在于 loopback，BFF 不代理它、不向浏览器传递其凭据。`RemoteAccessPolicy` 在原生 Gateway 内再次检查需求 / 会话资源。

每个登录会话、需求及客户端 generation 使用最多 20 秒的不可变授权；到期后 Host 主动关闭 Peer，客户端重新鉴权并恢复原生流。退出首先禁止该登录会话的新准入，终止 BFF 在途请求，再通知 Host 撤销。通知失败时 BFF 已停止下行，native 最迟随租约失效；退出响应头 `x-rdws-native-revocation` 区分 `confirmed` 与 `lease-expiry`。

```sh
pnpm test:e2e
pnpm test:web-live
```

前者验证基础浏览器旅程和会话结果未知时的重试；后者需要已有 GLM 原生配置，会产生真实模型调用，验证页面流、上下文刷新和失败阻断、授权轮换、non-owner 拒绝与撤权故障，以及五会话的派生、被动回放和中断恢复。live 使用运行根 `testing-web` / `testing-fault` / `testing-context-denied` / `testing-context-timeout` / `testing-sessions/<run-id>` 的独立数据目录，通过原生 patch / 凭据路径引用同一模型配置，不复制密钥。中断用例仅终止其自身创建且 PID 已核对的原生子进程，保留日志与数据库记录。测试产物在 `test-results/`，Demo 对照截图在 `.impeccable/review/`；两者均不进 Git。

### 模型外发暂停（T13）

macOS 的正式 Web Host 支持启动时暂停。先停止旧 BFF、它启动的 Native 进程及独立 SDK 探针，然后使用原 `RDWS_HOME` 启动 `RDWS_NATIVE_MODEL_EGRESS=paused pnpm dev`。每个 Native Host 按需启动并通过签名就绪检查。暂停实例由 Seatbelt 拒绝主动联网，保留原生本机入站与上下文 IPC。配置无效、平台不支持或沙箱启动失败时，启动会失败。确认生效后，用户可按权限读取或跟随历史、取消及操作其他业务入口。提示词提交在入箱前返回 503，旧请求键在暂停期间也应等到恢复后再核对。已打开页面保留输入，由用户手动重试。维护窗口内保持独立 SDK 停止。

迁移 0011 为 PostgreSQL 增加同库所有者，默认未受管。切换由获准的 DBA 在离线窗口进行。先确认旧 BFF、Native、独立探针和模型出口停止，并阻断旧版重新启动或直连。DBA 在 `rdws_authority.owner` 空位设置 `managed` 并预登记一次性启动凭据的 SHA-256 摘要 `ticket_digest`，再使用 `RDWS_NATIVE_MODEL_EGRESS=paused` 与 `RDWS_AUTHORITY_TICKET_FILE` 启动一个受管 BFF。文件须是当前运行用户的私有普通文件，含 64 个小写十六进制字符及可选的一个换行。PG 参数日志上限 `log_parameter_max_length` 和 `log_parameter_max_length_on_error` 都须为 0，`debug_print_plan` 和 `auto_explain` 执行计划日志须关闭。受管数据库拒绝其他 BFF 启动和非所有者写入授权表。确认完整关停后会释放代次，新进程需要新的启动凭据。故障或结果未知时，由获准维护者先核对旧进程和出口停稳，然后按确切代次恢复空位。实际供应商外发与部署拓扑仍按 T13 验收。 [所有者设计与验证](docs/02-directory-and-engineering-design.html#t13-database-authority-owner-20261119)

未受管数据库恢复 direct 前，先停稳暂停的 BFF 与 Native，再在已授权的环境显式用 `RDWS_NATIVE_MODEL_EGRESS=direct` 重启。未设置变量的本地开发沿用 direct。回退时保留支持暂停的配套版本和显式设置。回到旧版本时，先保持 BFF 与 Native 关闭，或先验收独立的部署层外发阻断。`pnpm test:web-live tests/web-live/model-egress-pause.spec.ts` 使用合成供应商验证本机切换。 [实施与验收](docs/02-directory-and-engineering-design.html#t13-native-model-egress-pause-20261119)

### 需求维护（T11）

当前项目管理员及同时具备项目和需求身份的需求经理，可在「需求档案 → 基本信息」编辑标题、需求说明和验收标准。保存按原命令记录修改，活动区显示操作者与变更字段。若结果未确认，可回到原需求重试原保存。若原操作未提交，重试会应用原先改动的字段。保存和回读各自显示状态。 [需求资料编辑验收](docs/02-directory-and-engineering-design.html#t11-details-delivery-20261119)

同一区域可维护需求参与角色和开发负责人。移除开发角色或更换负责人时，为受影响的未完成任务明确指定接手人。可按原负责人分组选择，也可给个别任务指定不同的人。已结束任务保留原分派，原负责人失效后重开须同时选择合格接手人。保存响应丢失时，原账号可在原需求重试人员变更。 [人员维护验收](docs/02-directory-and-engineering-design.html#t11-personnel-delivery-20261119)

有需求创建权限的成员可从「需求管理 → 批量导入」下载模板，上传 UTF-8 CSV 或文本 `.xlsx`，每文件最多 2 MiB，每批最多 50 条需求。标题和开发负责人必填，人员填本项目有效登录名，初始子任务按行填写。上传后在同页查看进度和逐行错误，修正并重新校验，全部通过后显式提交，整批一次入库。结果未知时，回到原账号及项目重试原批次。入库结果提供详情链接及工作树状态，待准备的工作树从需求详情发起。 [批量导入验收](docs/02-directory-and-engineering-design.html#t11-import-delivery-20261119)

## 项目与成员管理（T03）

平台管理员从「平台设置」登记固定项目 ID、更新名称和维护项目管理员席位，也可停用或恢复现有账号。登记项目需指定一个活动账号作为初始项目管理员。平台设置不会自动赋予项目业务访问权。项目管理员从「成员与权限」按现有登录名维护本项目的需求经理、开发和测试角色；同一账号的角色在当前项目内叠加。撤回角色后，历史分派仍可追溯，失效负责人恢复对应账号和角色前无法维护阶段和任务。

非 `poc` 项目由运行维护者将已获准的 Native 配置放入 `$RDWS_HOME/config/projects/<id>/dsh/`。其中 `profiles/rdws/cordis.patch.yml` 登记模型。未指定默认模型时，实例选择本项目已登记的第一个 `rdws-glm` 模型。`.credentials.yaml` 是仅运行账户可读写的私有凭据文件。目录和文件须归运行账户所有，使用常规目录／普通文件，避免链接及别名。浏览器显示登记状态。首次访问会话时从需求归属选择独立实例，工作区位于 `projects/<id>/demands`，原生数据位于 `runtime/dsh/project-<id>`。既有 `poc` 保留原配置、工作区、回执和会话路径。T04 的 `repositories.json` 仍在同一项目配置目录，镜像按原来的验收边界推进。

停用或恢复账号都会使旧登录长期失效。项目角色变动只停止该账号在该项目中的旧访问。原生通知不可达时，BFF 立即断开，原生连接在短租约到期后关闭。已获得准入的外部模型请求可能结束，失效连接不回传输出。

已有本地库先执行 `pnpm db:migrate`。测试库执行 `RDWS_MODE=test pnpm db:migrate`。新增迁移给账号和登录加入内部代次，现有记录默认 0，保留项目数据和原生日志。已有代次变更的数据库不能直接运行 0005 之前的认证实现。旧服务不会核对代次，也不会为代次已变化的账号正确签发会话；回退需另行审批并制定兼容认证与会话处置方案。进程异常后，在确认 Host 和 Native 子进程均已停止后重启服务。锁状态无法确认时保留原锁，参照运行根 `runtime/instances/project-<id>.lock` 与同项目就绪记录核实。旧进程的短期票据不用于新进程。

聚焦命令为 `pnpm test tests/integration/project-administration.test.ts`、`pnpm test:e2e tests/e2e/project-administration.spec.ts` 和 `pnpm test:web-live -g 'one login sends and reads'`。最后一项用两个隔离实例和一个账号验证实际 GLM 请求，使用测试库与独立运行根。详见[工程实施与验收](docs/02-directory-and-engineering-design.html#t03-plan-20261118)。

## 平台能力白名单（T14）

平台管理员可在平台设置登记已审核的插件、技能和 MCP 版本。登记包含来源／标识和精确审核版本。停用保留历史记录，原命令核对后以当前清单显示的状态为准。

已有本地开发库通过 `pnpm db:migrate` 应用新增审核表，测试库使用 `RDWS_MODE=test pnpm db:migrate`。部署应用前先核验迁移和应用账号权限。代码回退保留审核表、原命令回执及新版迁移授权脚本，应用账号保持无审核表删除权限。回退前在支持白名单的版本核对待处理命令，必要时恢复该应用版本再核对。[工程方案与证据](docs/02-directory-and-engineering-design.html#t14-allowlist-plan-20261118)

平台管理员在平台设置选择项目后可创建和修改能力模板。每次变更追加新版本，选项来自当前已审核且可用的精确版本。项目成员通过项目侧栏读取本项目模板，含停用引用的模板标为需修订。迁移 0007 增加模板版本表与查询索引，应用角色只读取、追加；回退继续保留新版迁移授权脚本和模板历史。[项目能力模板](docs/02-directory-and-engineering-design.html#t14-template-plan-20261118)

迁移 0009 增加需求模板绑定。项目管理员可在需求「上下文」选择本项目已发布的精确版本。模板再发布不会移动已有绑定，审核引用停用后原版本仍可读。绑定面板关联打开时的登录。保存结果未确认时，原账号重新登录并刷新后可在同一需求核对原操作。旧库运行新版应用时，需求模板面板提示需要迁移。 [绑定配置验收](docs/02-directory-and-engineering-design.html#t14-demand-binding-delivery-20261119)

新建会话检查当前绑定和审核，Native 按冻结的项目、需求、模板版本及制品摘要装载。未绑定使用默认只读 preset。派生继承源会话的原生有效版本，已建会话重启后继续读取原版本。若审核停用或制品未随发布提供，相关新建或派生会明确拒绝。运营制品通过 `dsh/host/presets.ts` 的受审发布目录提供。当前发布目录未登记运营制品，MCP 的外部连接与工具调用仍遵循 T07 启用门槛。 [Native 装载方案](docs/02-directory-and-engineering-design.html#t14-preset-delivery-plan-20261119)

冷备须同时保留 Native 会话、`$RDWS_HOME/runtime/presets/project-<id>/` 和可重现的发布制品。维护期间可在 BFF 启动环境设置 `RDWS_PAUSE_PRESET_CREATION=1`，暂停使用受管 preset 的新建与派生，保留历史装载和已完成命令的回读。退出维护时移除此设置并重启 BFF。

## 仓库与环境（T04）

运行维护者先按[配置示例](config/repositories.example.json)在 `$RDWS_HOME/config/projects/<project-id>/repositories.json` 登记已授权的规范 HTTPS 仓库、完整基线分支和一个非生产目标分支。示例使用不可连接的占位地址。预置项目 ID 为 `poc`，支持每个项目独立登记。配置由运行账户管理，在下一次读取时生效。受管目录和文件应由运行账户所有，目录禁止组与其他用户写入，引用文件名不含目录。更换仓库地址或基线分支时使用新仓库 ID。

- 将可信 SSH 签名公钥登记为 Git `allowed_signers` 格式，文件放在同一个项目配置目录。T04 当前验证基线 tip 的 SSH commit 签名，Git 使用该名单判断信任。私有 CA 可通过同目录中的可选 `caFile` 引用，HTTPS 主机校验仍生效。
- 访问方式由必填的 `credentialFile` 指定。对已授权且支持匿名读取的仓库，显式填 JSON `null`。需认证时填 `$RDWS_HOME/secrets/` 下的只读凭据文件名，文件权限为 `0600`。私有 JSON 包含 `url`、`username`、`token`，其中 `url` 与登记的完整 HTTPS 地址一致。运行需要支持 SSH commit 验签的 Git 与 `ssh-keygen`。syncer 从固定的系统和常用包管理器 PATH 查找 Git，隔离测试另需支持 `req -addext` 的 OpenSSL。
- 登录后从侧栏进入“仓库与环境”。项目成员可观察基线、目标、最近结果和本地实际 SHA。项目管理员可点“同步基线”。如响应未确认，留在当前页使用“核对原同步”，同一个命令会查询原持久收据。收到待核对状态时可以继续核对，或明确选择“发起新同步”。故障状态会显示原因。
- 已验证的基线发布在 `$RDWS_HOME/projects/<project-id>/sources/<repo-id>.git`。同步只更新指定基线 ref，目标 SHA 记录为读取时点的观察。失败详情、发布前记录与锁位于同级隐藏目录 `.<repo-id>.state` 和 `.<repo-id>.lock`。若锁遗留，先停止对应服务同步入口，先核实 `owner.json` 记录的工作进程已停止。再按该次 `git-*.pids` 的完整路径核对尚处在引导阶段的进程，确认引导已结束后重读组记录。每组在启动 Git 前写入组 ID。根据操作时间和系统进程表确认所有关联组已退出，读回实际 ref 和收据中旧值、候选值。保留证据，确认后由运行维护者解除该次锁。后续使用新命令重新同步，原命令仍返回原记录。收据按操作保留，统一维护策略由运行维护阶段处理。

独立验证命令为 `pnpm test tests/integration/repository-mirror.test.ts tests/integration/repository-access.test.ts` 和 `pnpm test:e2e tests/e2e/repositories.spec.ts`。隔离 HTTPS Git 夹具生成临时签名身份及远端，并通过实际 Git 读、验签和更新。T04 已在具名授权 Gitee 仓库通过 HTTPS 只读镜像和 SSH 提交验签，T05 前置已满足。T09 继续使用 GitLab 验收交付闭环。 [T04 真实验收证据](docs/02-directory-and-engineering-design.html#t04-gitee-live-20261118)

## 需求工作树（T05）

运行本版前先为目标库应用增量迁移 0008。配置了仓库的项目在新建需求时，会核对每个镜像的已发布基线并冻结 SHA。需求档案展示冻结基线、分支、工作树相对路径和就绪状态。

平台从本地镜像读取冻结提交，在需求目录下创建 `.gitstore/<repo>.git` 和 `worktrees/<repo>`。两个 Git 路径都归该需求。Native 会话继续注册在需求根，并共享该需求已经准备好的工作树。

若需求已创建但工作树尚未就绪，有权限的操作者可在需求档案重试准备。核对原创建命令只读回同一需求与当前状态。遇到遗留锁或无法核对的目录，运行维护者先确认该次 owner 和 Git 进程组的停止情况，再按计划记录保留现场并核对。 [工程与恢复边界](docs/02-directory-and-engineering-design.html#t05-worktree-plan-20261118)

## macOS 隔离执行验证（T06）

在 macOS 上用 `pnpm test tests/integration/local-execution.test.ts tests/integration/dsh-adapter.test.ts` 运行隔离验证。本机 Seatbelt、系统 Bash 和 Perl、Node 24 及 Git 负责执行。夹具以回环 HTTPS 合成源准备 T05 工作树。验证覆盖工作树内文件读写、Bash 内建命令、指定文件的进程内 `node:test` 以及 Git 状态、差异和 HEAD 查询。产品会话仍关闭执行工具，启用条件见 T07。

执行结果分别记录命令状态、进程组停稳和标记释放情况。运行时限从启动执行进程起算。停止存疑或执行标记遗留时，保留隔离目录，由运行维护者核对现场。Linux 对应验收见 T21。 [T06 工程设计](docs/02-directory-and-engineering-design.html#t06-execution-plan-20261118)

## DSH 真实接入探针

```sh
pnpm dsh:probe
```

使用固定版本的官方 DSH / SDK 及项目实例的原生 `profiles/rdws/cordis.patch.yml`、`.credentials.yaml`。探针不读取 `model.env` 来覆盖原生设置。它只在缺失时补齐 Profile manifest，读取 `rdws-glm` 路由并调用 `GLM-5.3-Flash`。

一次运行创建两个独立会话，验证回复标记、有效工作目录和实时文本分段；关闭实例后重新启动，使用原生 API 恢复同一会话 ID。所有实例结束后保留原生会话日志，以及运行根 `state/exports/dsh-probe-<run-id>.json` 的脱敏报告。该命令会产生少量真实模型调用费用，不属于默认 `pnpm test`。SDK 探针通过独立 `rdws-probe` Profile 引用原生 `rdws` 模型 patch；与日常 Web 实例共用项目进程锁，已被占用时拒绝启动，不会抢占。

探针通过公开 `agent/assistant-stream` 钩子观察实时分段，只记录类型、长度和时间。SDK 持久事件和实时文本帧由探针验证；Web 展示与 BFF / Native 两道闸由 `pnpm test:web-live` 验证。探针只读，禁用执行工具、日志上传和遥测。项目进程锁阻止同实例并发；关闭未确认时保留锁。文件 / Shell 权限和 Linux 验收仍待完成。

DSH 保持 `0.2.2-rc.3`；`pnpm-workspace.yaml` 对原固定的 `undici@8.11.2` 定向使用 `8.12.2` 安全补丁，升级 DSH 时须复核并回归，不修改上游源码。

## 核对会话日志的原始前缀

`journal` 为运维选定的原生文件规范绝对路径。`through_byte` 为已确认刷盘且进程已停稳的原件或相应不可变快照中的物理字节截止。首次计算后，将 SHA-256 与会话、确切文件代际、编码和截止一同留存，核对时使用同一组信息。

```sh
pnpm --silent trace:prefix hash "$journal" "$through_byte"
pnpm --silent trace:prefix verify "$journal" "$through_byte" "$sha256"
```

命令按原编码读取 `[0, through_byte)` 并输出一条 JSON。退出码 0 表示成功计算或匹配，1 表示与既有摘要不符或文件已稳定截短，2 表示输入或读取证据不可用。读取期间观察到的文件变化返回 `source-changed`。截止位置之后已有的追加不影响核对。

### 独立哈希锚点（T16）

迁移 0010 增加独立的 `audit.session_log_anchor`。部署方在目标库配置专用直接登录，开发库使用 `rdws_anchor_writer`，测试库使用 `rdws_test_anchor_writer`。给该账号单独授予目标库 CONNECT，并通过私有渠道发放密码。按对应环境运行 `pnpm db:migrate` 后，专用账号可读取锚点并追加限定列。账号不存在时，迁移仍可安装锚点表，待账号就绪后重跑授权。

以独立 OS 身份只读挂载受信原件或快照，在私有运行环境设置 `RDWS_ANCHOR_SOURCE_DIR` 为该实例的规范 `project-<id>/sessions` 路径。用 `RDWS_ANCHOR_DATABASE_URL` 指定专用登录的用户名、密码、主机与数据库，端口缺省为 5432。连接可使用 `sslmode=verify-full` 或本地隔离验证所用的 `sslmode=disable`。从停稳并确认刷盘的原件或对应不可变快照取得规范绝对路径 `journal`。首次可自动记录，随后用回执的 `throughByte` 作为 `through_byte` 核对。

```sh
pnpm --silent trace:anchor record-auto "$journal"
pnpm --silent trace:anchor verify "$journal" "$through_byte"
```

自动记录核对文件头和坐标，扫描完整 JSONL 行或完整 Zstandard 帧，回执包含原始字节截止及忽略的尾部字节数 `ignoredTailBytes`。已确定截止时可直接用 `pnpm --silent trace:anchor record "$journal" "$through_byte"`。重复记录同一前缀返回原时间。退出码 1 表示同键异文、摘要不符或稳定截短，退出码 2 表示输入、权限、来源、锚点或结果暂不可用。保留原不可变快照，`unconfirmed` 后按原坐标核对，回执丢失时可用同一快照重跑。 `missing-anchor` 只表示本次读取暂不可见。需要停止追加时，部署方可撤销专用账号在锚点表上的列级 INSERT 并保留 SELECT。重跑迁移保留此只读授权。归档保留锚点引用的项目和会话身份行。

普通集成验证使用本机已有的项目固定 PostgreSQL 镜像。用本机已有的 `node:24.20.0-bookworm-slim` 镜像执行 `RDWS_TEST_ANCHOR_READONLY=1 pnpm test tests/integration/trace-anchor.test.ts`，可复验独立 Linux 非 root 进程的只读挂载、自动记录及旧坐标核对。正式环境只读部署仍按研发清单验收。[T16 自动截止方案](docs/02-directory-and-engineering-design.html#t16-automatic-cutoff-plan-20261119)

## 这个仓库现在有什么

| 路径                                            | 内容                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `docs/00-decision-ledger.html`                  | **决策台账 v4 · 唯一事实来源**，先读这份                         |
| `docs/01-feasibility-report.html`               | 基于 DSH 的开源使用风险与二次开发难度评估                        |
| `docs/02-directory-and-engineering-design.html` | `.rdws` 运行空间、分支/worktree 策略、工程骨架                   |
| `docs/03-design-crosscheck-report.html`         | 三面独立评审 + 运行时实测 + Q1–Q4 决策台账                       |
| `docs/04-design-baseline.html`                  | 设计基线与交接规格：令牌、组件规格、a11y 实测、16 视图一致性走查 |
| `docs/05-development-backlog.md`                | 开发任务清单：T00–T22、验收目标、依赖、并行顺序与后续任务        |
| `demo/rdws-workbench.html`                      | **当前设计稿**：16 视图可点击工作台，单文件、零外链、假数据      |
| `demo/rdws-overall-demo.html`                   | D17 第一版探索稿（管理看板范式），保留作对照                     |

所有 HTML 都是单文件、无外部依赖，直接双击或拖进浏览器即可打开；hash 路由形如 `#/overview/D-1042`。

建议阅读顺序：`00 决策台账` → `04 设计基线`（要接实现时）→ `03 交叉检查报告`（要了解口径怎么定的）→ 其余按需要。

## 设计口径（摘要，完整版以台账为准）

- 首版只做**浏览器模式**；Tauri 薄壳是后续演进路线，不进 PoC、不进这版原型。
- 项目级 DSH 实例 + 每需求 `agent preset`；一个需求下可有多个 AI 会话，同一时刻只有一个写会话。
- 本地 `sources/` 是只读 bare mirror。在 GitLab 交付路径中，GitLab 主仓是事实源，平台服务账号只 push 非保护的 `rdws/*`，环境分支走 MR 与人工审批。 [T04 Gitee 只读验收](docs/02-directory-and-engineering-design.html#t04-gitee-acceptance-20261118)
- 三级模型作用域（平台 / 项目 / 个人）与平台白名单内的能力模板；关闭会话日志上传与 OTel 遥测。
- 功能入口跟随作用域；表单与详情走页内一等面板，不使用右侧抽屉。

## 接下来的路线

修改设计追溯、任务依赖或视图映射后运行 `pnpm validate:baseline`。该离线检查读取仓库内的台账、清单、Demo、正式路由和[稳定标识索引](docs/baseline-trace-index.json)，检查原子命题与登记项的完整集合；语义及真实环境仍按对应任务验收。

后续任务选择、依赖和完成状态从[开发任务清单](docs/05-development-backlog.md)进入。有效设计到任务、共享接口归属与外部条件见[T00 总基线与任务追溯](docs/02-directory-and-engineering-design.html#t00-baseline-20261118)。总体目标覆盖完整浏览器产品与合入回写闭环；按任务顺序推进，不安排工期或日期。已批准 PoC 切片及具体业务契约继续以决策台账和工程设计为准。

当前以台账 v4 §8 的分阶段计划为准。需求、子任务、状态与原生上下文已贯通；macOS 已验证同需求至少五会话的 cwd 归属、恢复、本人派生和被动回放。后续按任务清单推进项目／仓库与工作树基础、真实执行及单写交接、`sources` 零写入、`rdws/*` push 与 MR 映射闭环，再做 Linux 验收。

PoC **不验证**：HA / 多机、Tauri 薄壳、多环境自动编排、中心化日志在线迁移，以及生产档（Docker 强隔离）验收——后者因 C1 不追认明确排除。

## 安全与残余风险

本仓库包含设计、原型与开发中的 PoC，**未经过安全审计，不是生产可用实现**。两条必须携带的残余风险见 `SECURITY.md`：R-A（无 Docker 档的隔离强度）与 R-B（模型主请求可能携带源码出企业边界）。上游合规与品牌口径见 `THIRD_PARTY_NOTICES.md`。

## 许可证

[MIT](LICENSE) · Copyright (c) 2026 Mayne-Zeng。

许可证沿用仓库既有 MIT 选择；第三方依赖保留各自许可。许可变更不在本轮范围内。
