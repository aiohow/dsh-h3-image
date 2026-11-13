# RELEASE & MAINTENANCE — dsh-h3-image

## 1. 版本策略

- **SemVer**：`MAJOR`（工具 schema 破坏性变更/许可结构变化）· `MINOR`（能力新增，如参考图）· `PATCH`（修复/钉版本更新）。
- 单一真值：`package.json` version ↔ CHANGELOG ↔ `pinned.js` 的 `PLUGIN_VERSION`，CI `check-version-consistency` 核对。
- `engines.dsh` 下限 = 实测通过的最低 DSH 版本，禁写"可能兼容"。
- 钉版本三件套集中 `pinned.js`：引擎 commit / 权重 revision / sha256 manifest。升钉版本 = `PATCH`（含 smoke 全跑）。

## 2. 三条维护流

### 2a. 上游变化（引擎仓库 / 权重 / 许可）

| 触发 | 检测 | 动作 |
|---|---|---|
| 引擎出新功能（如**参考图/编辑**开放） | 季度巡检 + issue 提醒；diff 上游 CHANGELOG | ① 升 pinned commit ② smoke 回归 ③ 能力开关进 `h3_status`（`capabilities: [t2i, ref2i...]`）④ 工具 schema 加参数 = `MINOR` ⑤ README 能力表同步改写（"显式拒绝"改"支持"须过 PRD U-走查） |
| 引擎破坏性改动（API 变了） | 钉 commit 天然免疫；升级时才暴露 | 适配层改 runner，smoke 过才发 `PATCH/MINOR` |
| 权重仓更新 revision | 不追 latest（定案）；仅当质量/修复需要 | 新 manifest + 全量 hash 重验 + 文档记录两版差异；老用户不强制迁移（model_dir 布局不变则共存） |
| **许可变更**（含地域条款变化） | 每次权重 revision 巡检顺带 diff LICENSE 头部与条款摘要 | **停发新装引导**：向导 license 步骤文案更新 + DISCLAIMER 同步 + 若传染插件代码发布语义 → `MAJOR` 并评估下架 |
| 上游仓库消失/删 commit | check 的 engine 步骤失败即暴露 | 文档预登记 fork 兜底（发布前建好 fork 并写入 pinned 备选源）；issue 公告 |

### 2b. 用户 bug 反馈

- 渠道：GitHub Issues（模板三件：bug / 安装失败 / 功能请求；模板要求附 `h3_status` 输出——**模板明确提示删除本机路径与用户名后再贴**，附一键脱敏说明）。
- 分诊 SLA（练手项目现实值）：48h 内打标（`bug`/`setup`/`docs`/`enhancement`/`wontfix+理由`）；安装失败类优先（新用户流失点）。
- 修复流：repro（优先在裸机模拟环境复现）→ fix → 回归（含原 issue 场景）→ `PATCH` tag → 在 issue 里 @反馈者确认后才关单。
- **不可复现不假关单**：标 `needs-repro` 并给出诊断采集指引（`h3_status` verbose + job 日志 tail，同样脱敏后贴）。
- 安全类不走 public issue：GitHub Security Advisory。

### 2c. DSH 宿主升级

- DSH 升级后跑一次"插件面回归"：install/enable/disable/工具注册/attachments 五查（借 dsh-post-upgrade 检查口径）。
- 宿主 API 变更以 `engines.dsh` 下限 + CHANGELOG 声明适配窗口。

## 3. GitHub 流程（aiohow 账号首发练手）

- 仓库：`aiohow/dsh-h3-image`，私有开发 → M3 门禁全绿 + 双人走查（用户过 README/DISCLAIMER 文案）→ 转公开。
- 纪律沿用 AGENTS.md：首 commit 含 `.gitignore`；里程碑即提交（中文 `<类型>: <一句话>`）；提交前密钥扫描；仓库级 git identity = `aiohow`；凭据走 `GH_CONFIG_DIR` 隔离（既有 `~/.config/gh-dev` 定案）。
- 分支：`main` 常驻可发布 + `release/vX.Y` 短分支仅用于发版修文案；tag `vX.Y.Z` 即发布。
- CI（GitHub Actions，最小集）：`node --test` + 门禁脚本（release-safety / version-consistency / 零 URL 扫描）+ npm pack 干跑。CI 日志同样过脱敏（禁 echo 秘密变量）。
- Release 资产：门禁通过的 tarball（uname 归零版）+ SHA256SUMS.txt；README 安装段给"下载 tgz → DSH 插件页安装"路径；npm 发布与否 = 用户 M4 前拍板（PLAN §6.2）。
- README 结构（对外门面，中英双语）：一句话价值 → 三行安装 → 效果图（**铭牌声明本机生成**）→ 支持矩阵 → License & Territory 块 → Disclaimer → 故障排查表 → 维护承诺。

## 4. 发布前最终检查单（M3→M4 之间，全勾才转公开）

- [ ] 裸机模拟全链路出图通过（TEST-PLAN §3）
- [ ] release-safety 源码+tarball 双扫零发现；tar 头/AppleDouble 复核
- [ ] LICENSE-COMPLIANCE 落地清单逐条勾完；"非官方"声明三处齐
- [ ] README 双语由**未参与开发的人**（或干净上下文窗口）按文复现成功
- [ ] 效果图铭牌与"本机生成"声明齐；截图零路径零用户名
- [ ] issue 模板 + SECURITY.md + 反馈渠道可用
- [ ] CHANGELOG v1.0.0 定稿；tag 与 release 实测可下载、哈希对账

## 5. 标准发布链（每次发版逐条执行，纯文案版不豁免）

1. **bump**：`package.json` version + 两个 locale `meta.description` 里的版本串 + CHANGELOG 条目（平实措辞；README 是否动按用户当次拍板）。
   - **用户预审门禁（2026-11-13 用户指令，任何版本不豁免，纯文案版同样适用）**：发布前把 CHANGELOG 条目 + README 改动（若有）贴给用户过目，用户说"发"才继续走第 2 步之后的链。教训：0.2.14 按"纯文案直接走链"的旧习惯发出去后才被用户要求先看——"发出去前都给我看一下"是硬指令，不是建议。
2. **三门禁**：`check-version-consistency` / `check-release-safety --all-files` / `npm test`，全绿才许提交。
3. **commit + push**：英文 Conventional 短句（发布提交用 `chore(release): x.y.z`），推 `origin main`。
4. **tag（链内步骤，不是收尾动作）**：`git tag vX.Y.Z`——打之前先核验落点提交的 `package.json` version 等于发布版本；`git push origin vX.Y.Z`。（教训：0.2.8 发布漏打 tag 事后补，0.2.9 又漏一次被用户抓出——凡"发版即打 tag"未固化成编号步骤就会漏。）
5. **pack**：`npm pack --cache <工作区临时缓存>`；`tar tzf | wc -l` 核对文件数与预期一致，抽看包内中文无转义。
6. **发布**：tarball scp 到美国vps `/root/npm-publish/` → `NODE_OPTIONS=--dns-result-order=ipv4first npm publish <tgz> --userconfig /root/npm-publish/.npmrc` → 删上一版 tarball（留底 0.2.0 + 当前版）。
7. **轮询 + 装机 e2e**：官方 registry 每 20s 轮（tarball=200 且 latest=新版本，历史 ~5 分钟）；生效后 VPS 干净目录实装，判据 = installed 版本号 + 文件数 + locale 标题 grep 实测读出。
8. **镜像**：`PUT https://registry.npmmirror.com/dsh-h3-image/sync` 踢同步；轮询镜像 latest 追平后，镜像包与官方包 `shasum` 互证一致才算国内面闭环。
9. **GitHub Release**：`gh release create vX.Y.Z <tgz> SHA256SUMS --title "vX.Y.Z — <一句话>" --notes-file <草稿>`——正文从 CHANGELOG 对应节摘录改写（面向用户，不是给维护者的全量）；普通 PATCH 版可 `--notes-file` 用 CHANGELOG 节原文。**正文发出前先给用户过目**（用户 2026-11-13 指令）。历史 tag 不补 Release 页，只补用户点名的里程碑。
10. **台账**：`box-probe/CHANGES-<日期>.md` 追加 CH 条目（发布链各步证据、镜像状态、用户侧待办）。
