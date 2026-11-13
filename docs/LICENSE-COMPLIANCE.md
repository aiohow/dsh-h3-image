# LICENSE COMPLIANCE — dsh-h3-image

> 三层许可结构，边界必须清晰。本文件是开发定案；对外表述见 DISCLAIMER.md（定稿）。
> 依据：本机权重包内 LICENSE 全文实读（2026-11-12），非二手转述。
> 对外表述见 DISCLAIMER.md（定稿）。

## 层 1：插件代码（我们写的部分）— MIT

- 仓库 `LICENSE` = MIT，版权主体用 GitHub 账号对应身份（对外化名，与纪律一致）。
- 不含权重、不含引擎源码副本（引擎是 setup 时用户自行 clone，权重是用户自行下载）——**插件仓库零再分发**，这是许可边界成立的地基。

## 层 2：推理引擎 `minimax-h3-mlx` — Apache-2.0

- 钉 commit 使用，用户 clone 上游仓库（许可随上游仓库自带，含其 MODIFICATION_NOTICE：DiT 已 8bit 量化+AdaLN 表替换，满足许可"修改须显著声明"义务的主体是引擎作者，我们如实转引）。
- 义务：`THIRD_PARTY_NOTICES.md` 列引擎（Apache-2.0）+ 其依赖（mlx MIT (Apple)、mlx-vlm MIT、transformers Apache、numpy BSD、pillow MIT-CMU、safetensors Apache/MIT、huggingface_hub Apache）；README 致谢并链接上游。
- 若上游 LICENSE 变更 → 维护流程触发再评估（见 RELEASE-AND-MAINTENANCE §2a）。

## 层 3a：模型权重 MiniMax-H3-Image — MiniMax H3 Image Community License（关键条款逐条落地）

| 条款 | 内容 | 插件落地 |
|---|---|---|
| 地域排除 | Applicable Territory = 全球 **除 EU/UK/KR/US**；域外使用不受授权 | ① 向导 license 步骤展示要点+点名排除清单+全文直链，用户以 accept=true 显式确认辖区不在排除列表；② README 顶部显著声明；③ 确认记录落盘（时间戳，不记身份） |
| 接受方式 | "点击接受或使用即生效" | 插件强制显式确认（`accept=true` 由用户驱动，`--accepted` 仅在确认记录存在后传给引擎，插件永不代点）；拒绝则 weights 步骤不启动 |
| 再分发（III） | 分发须附协议副本/NOTICE/修改声明 | 我们不分发权重；文档明确"权重由用户自上游直接获取，协议原件随权重落盘"（引擎 fetch 已把 LICENSE/NOTICE 写进模型目录——如实转述此行为） |
| 商用门槛（IV.1） | 年化营收 >100 万美元 或 提供 Hosted Service 须另行书面授权 | DISCLAIMER 声明：本插件为本地工具；若用户构建对外托管服务，须自行取得 MiniMax 授权 |
| 商用展示（IV.2） | 商用产品 UI 须显著展示 "MiniMax-H3-Image" | 铭牌天然满足（provider 标注）；文档提示商用用户 |
| 使用限制（V） | 合规 + AUP（Exhibit A）；**不得用输出训练其他模型**（V.3）；向第三方提供前须绑定同等条款（V.2） | README/DISCLAIMER 转述；AUP 链接随 license 步骤展示 |
| 商标（VI.2） | 无商标授权；描述性使用除外 | 包名/文档以描述性方式引用 "MiniMax-H3-Image"；显著声明"与 MiniMax 无关联、非官方插件"；不用 MiniMax logo |
| 输出归属（VI.4） | MiniMax 对输出不主张权利；用户全责 | DISCLAIMER 如实转述 |
| 专利诉讼终止+赔偿（VI.3） | 起诉即许可终止；用户须为 MiniMax 抗辩并赔偿（indemnify and hold harmless） | DISCLAIMER 第 5 条责任面覆盖；本文件收录义务存在性 |
| 准据法（IX） | 香港法 + 香港法院专属管辖 | 本文件收录；对外文案不重复全文，指向协议原件 |
| 终止后义务（VIII.2） | 停止使用 + 删除全部副本 + 通知下游 | 本文件收录 |
| PE 模型（Additional Note） | T2I prompt-enhancer 源自 Qwen3.8-27B（Apache-2.0），仍属 MiniMax-H3-Image Works 受本协议约束 | 当前版本不下载 PE 模型；若未来支持须带此条款 |

**"对外发布"的合规定性（定案）**：发布的是 MIT 插件代码（全球可发布，无地域条款传染——代码不是 "MiniMax-H3-Image Works"，不含权重/导出物）；权重获取行为发生在用户与上游之间、受用户所在地域约束，插件的角色是"带许可展示与确认的下载器"。此定性写入 README 的 License 章节，并建议用户在排除地区者不要执行 weights 步骤。

## 落地清单（发布门禁项，2026-11-13 按实现形态定案）

- [x] `LICENSE`（MIT）+ `THIRD_PARTY_NOTICES.md`（层 2 全量 + 层 3/3b 引用性说明）
- [x] 向导 license 步骤：两份协议要点 + **点名地域排除（EU/UK/KR/US）** + 两份协议全文直链（AUP 为协议 Exhibit A，随全文直链覆盖）；接受记录写 `agreements:[两份协议名]`，`licenseGate` 两份齐备才放行。定案为**摘要制**：插件不内嵌全文、不承诺"展示全文"，全文义务由直链 + 随下载落盘的协议原件履行（可机检对账：`TEXT_ENCODER_PACKAGE.licenseSha256`）
- [x] README 顶部 License & Territory 声明块（双语，点名四区）
- [x] "非官方、与 MiniMax 无关联" 声明（README 首屏 + 插件 meta.description 中英双语前缀）
- [x] 本文件随仓库公开（展示合规诚意）；发布前 `check-release-safety.mjs --all-files` 全仓扫描 PASS
- [ ] 引擎 fork 备选源 + `ddalcu` TE 仓备选源（上游消失兜底，转公开后补，见 RELEASE-AND-MAINTENANCE §2a）

## 层 3b：量化文本编码器 `ddalcu/MiniMax-H3-FL2VA-MLX-Serve-8bit` — 第二份协议（2026-11-13 审计补入）

- 事实：钉定引擎的文本路径实际加载的是这个**第三方量化仓**（`lib/pinned.js` `TEXT_ENCODER_PACKAGE`），上游 `MiniMaxAI/MiniMax-H3` 只被取两个 meta json。该仓自带 LICENSE = **MiniMax H3 Community License Agreement**（2026-08-02 版，视频模型协议），同样排除 EU/UK/KR/US；其 `MODIFICATIONS.md` 自述为量化修改的 Model Derivative。
- 定性：该仓的再分发行为由其自身合规承担（LICENSE/NOTICE/MODIFICATIONS 三件齐）；本插件仍是"带许可展示的下载器"，不托管、不再分发。**该仓由独立第三方运营，与本插件作者无关联**（用户 2026-11-13 确认）。
- 插件落地：① 许可门同时列明两份协议名 + 全文直链 + 点名排除地区（`lib/state.js` `licenseSummary()`）；② 接受记录写 `agreements: [两份协议名]`，`licenseGate` 要求两份齐备才放行（0.2.0 期的单协议记录须重新确认）；③ `TEXT_ENCODER_PACKAGE.licenseSha256` 钉定协议文件 sha256 供对账；④ THIRD_PARTY_NOTICES 单列该仓条目。
- 单点风险：该仓若消失，文本编码器无备选源——登记待办（与引擎 fork 同批处理，见 RELEASE-AND-MAINTENANCE §2a）。
