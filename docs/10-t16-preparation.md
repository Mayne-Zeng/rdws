# T16 正式只读环境验收 · 具名物准备包

> 2026-11-23 由 captain 按用户访谈结论（D5）整理。两个具名物（不可变日志快照、DBA 专用账号）由部署方/DBA 角色产出——单人产品中即用户本人；captain 不代产出、不持有凭据明文。凭据只经本机环境变量交接，不入代码、日志、提交与报告。

## 依据

- 具名环境：本机 Docker（用户此前指定；预检 3 文件 21 项通过，main `7b24f6b`）。正式要求基线 `ce38275`。
- 四项验收判据：①真实日志记录锚点并独立核对摘要和物理截止；②只读、仅追加和跨范围拒绝；③测试副本篡改／截断能检出及同键重跑／重启恢复；④用户走查固定切点、详情、摘要导出及逻辑轨迹与物理锚点的区分（走查清单 docs/08 T16 项）。
- 锚点存储：`public.session_log_anchor` 表（[持久哈希锚点](02-directory-and-engineering-design.html#t16-anchor-plan-20261119)，schema 见 `packages/db/src/schema.ts`）。

## 准备物 A · 不可变日志快照

1. **选定真实运行**：在 RDWS_HOME 中选定一次真实运行的会话——判据：该运行的 Native 已完成刷盘（flush 确认）且停稳（Host 关闭、原生子进程退出；「刷盘确认且 Native 停稳」是验收对快照的硬要求）。
2. **复制原件**：把该会话的原始压缩日志目录（Zstandard 日志原件，含会话物理日志）整体复制到一个新快照目录；不做任何格式转换。
3. **记录指纹**：对快照目录内每个文件计算 `shasum -a 256`，生成清单（文件相对路径 + SHA-256 + 字节数）。
4. **冻结**：快照目录整体设只读（macOS：`chmod -R a-w <快照目录>`，验收时将以 Docker 只读挂载方式交给独立非 root 身份，挂载配置由 captain 在验收夹具中提供）。
5. **回填**：把快照目录绝对路径与哈希清单文件路径告知 captain。

## 准备物 B · DBA 专用锚点账号

在目标库（锚点表所在库）以 DBA 身份执行（密码用强随机值，`<占位符>` 按实际替换）：

```sql
CREATE ROLE rdws_t16_anchor LOGIN PASSWORD '<强随机密码>';
GRANT CONNECT ON DATABASE <目标库名> TO rdws_t16_anchor;
GRANT USAGE ON SCHEMA public TO rdws_t16_anchor;
GRANT SELECT ON public.session_log_anchor TO rdws_t16_anchor;
```

- 先按最小化只发 `session_log_anchor` 的 SELECT；验收夹具若需补充其他只读授权，由 captain 给出确切清单后再增量发放，不做宽授权。
- 回收（验收完成后）：`REVOKE ... ; DROP ROLE rdws_t16_anchor;`

## 凭据交接

- 本机 shell 环境变量（建议名：`RDWS_T16_ANCHOR_URL`，形如 `postgresql://rdws_t16_anchor:<密码>@127.0.0.1:<端口>/<目标库>`），在启动验收的同一 shell 会话注入。
- 不写入任何文件、命令历史、提交说明或报告；验收结束后按上文回收账号。

## captain 接手后的流程

1. 你告知「快照与账号就绪」后，captain 在隔离验收环境执行验收项一~三（锚点记录与独立摘要/物理截止核对；只读、仅追加、跨范围拒绝；测试副本篡改／截断检出与同键重跑／重启恢复），实跑证据随切片提交。
2. 验收项四（轨迹页走查）按 [docs/08-user-acceptance-checklist.md](08-user-acceptance-checklist.md) T16 项与你约时间执行。
3. 四项全部通过后 T16 结项，captain 同步清单与台账。
