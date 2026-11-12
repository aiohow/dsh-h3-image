# TEST PLAN — dsh-h3-image

> 总原则（团队红线）：完成判定只认运行态实测；产物必须实测解码（PNG 可解码，不看"文件已生成"）；单轨通过不出定案。

## 1. 分层

| 层 | 范围 | 工具/判据 | 跑在哪 |
|---|---|---|---|
| L0 单测 | checks 纯函数、argv 构造（注入负例：prompt 含 `"` `` ` `` `$()`）、错误信封分类、pinned manifest 解析、路径越界拒绝 | `node --test` | CI + 本地 |
| L1 契约 | 三工具 schema 合法性（`assertSupportedJsonSchema` 口径）、job 状态机迁移全覆盖、Config 校验 | `node --test` | CI |
| L2 集成（假引擎） | 用桩脚本冒充 venv python（吐固定 metrics JSON + 造合法 PNG），验证 runner 解析/超时/busy 闸门/孤儿回收 | `node --test` + fixture | CI（无 GPU 依赖） |
| L3 真机 | 真 venv + 真引擎 + 真权重：check 全绿 → 4MP 出图 → **PNG 实测解码 + 尺寸/seed 对账 metrics** | 脚本，人工触发 | 本机 |
| L4 裸机模拟 | 见 §3 | 脚本 + 清单 | 本机隔离目录 |
| L5 发布门禁 | release-safety 双扫、version-consistency、零 URL 白名单扫描、pack 清单一致 | `npm run test:checks` | CI + 发版前本地 |

## 2. 关键负例（必须显式覆盖，防"看起来能用"）

- 磁盘不足：预扣模拟 → `error_type:"disk"` + 缺多少 GB 的 fix_hint，零绝对路径泄露。
- 内存不足/非 Apple Silicon：check 直接 `unsupported`，且**不产生任何下载**。
- 许可未接受：weights 动作拒绝且退出码非零；`accepted` 记录不存在时重启后仍拒（持久性）。
- 镜像下载哈希不符：`error_type:"verify"`，删除坏件、状态回退可重跑。
- prompt 注入串：`'; curl evil; '` 类输入原样进 argv（断言 spawn argv 数组，非 shell 字符串）。
- 生图中途 kill DSH：重启后 job 表标记 orphan，孤儿进程被回收，无"假装完成"。
- 并发第二发：立即 `busy`，不排队挂死。
- 16MP 超内部 deadline：返回可恢复句柄而非工具超时错误。

## 3. 裸机模拟规程（M2 硬验收，"适配别的机器"的唯一证据）

1. 新建空目录 `<tmp>/bare-{venv,engine,models}`，插件 Config 指过去（不碰 phosphene/、不碰 mlx-serve 资产——复用探测此时必须报 miss 而非误命中）。
2. 依次驱动 `h3_setup`：venv（真实 pip 安装）→ engine（真实 clone+checkout，断言 HEAD==pinned）→ license（勾选流）→ weights（真实下载+转换；中途 kill 一次验证断点续传不重下已完成分片）→ smoke。
3. 判据：smoke 出图 PNG 实测可解码；`h3_status` overall=ready；全程日志零本机指纹。
4. 记录耗时/磁盘峰值/内存峰值，回填 README 的"资源账"表（数字必须来自本规程实测，不抄官方宣称）。

## 4. 回归基线（每次发版必跑）

L0/L1/L2/L5 全绿 + L3 一张固定 seed 的 4MP 图（像素级不做等值断言——MLX 数值容差，做"可解码+尺寸+metrics 一致"三判据）。

## 5. 已知不可自动化项（人工，发布检查单内）

README 可复现性走查（干净上下文/他人）、截图脱敏目视、免责声明文案确认（用户拍板）。
