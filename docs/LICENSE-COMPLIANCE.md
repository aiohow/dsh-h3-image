# LICENSE COMPLIANCE — dsh-h3-image

> 三层许可结构，边界必须清晰。本文件是开发定案；对外表述见 DISCLAIMER-DRAFT.md。
> 依据：本机权重包内 LICENSE 全文实读（2026-11-12），非二手转述。

## 层 1：插件代码（我们写的部分）— MIT

- 仓库 `LICENSE` = MIT，版权主体用 GitHub 账号对应身份（对外化名，与纪律一致）。
- 不含权重、不含引擎源码副本（引擎是 setup 时用户自行 clone，权重是用户自行下载）——**插件仓库零再分发**，这是许可边界成立的地基。

## 层 2：推理引擎 `minimax-h3-mlx` — Apache-2.0

- 钉 commit 使用，用户 clone 上游仓库（许可随上游仓库自带，含其 MODIFICATION_NOTICE：DiT 已 8bit 量化+AdaLN 表替换，满足许可"修改须显著声明"义务的主体是引擎作者，我们如实转引）。
- 义务：`THIRD_PARTY_NOTICES.md` 列引擎（Apache-2.0）+ 其依赖（mlx BSD、mlx-vlm MIT、transformers Apache、numpy BSD、pillow MIT-CMU、safetensors Apache/MIT、huggingface_hub Apache）；README 致谢并链接上游。
- 若上游 LICENSE 变更 → 维护流程触发再评估（见 RELEASE-AND-MAINTENANCE §2a）。

## 层 3：模型权重 MiniMax-H3-Image — MiniMax Community License（关键条款逐条落地）

| 条款 | 内容 | 插件落地 |
|---|---|---|
| 地域排除 | Applicable Territory = 全球 **除 EU/UK/KR/US**；域外使用不受授权 | ① 向导 license 步骤展示要点+排除清单，用户勾选"我确认我所在司法辖区不在排除列表"；② README 顶部显著声明；③ 确认记录落盘（时间戳，不记身份） |
| 接受方式 | "点击接受或使用即生效" | 插件强制显式勾选（`--accepted` 由用户确认位驱动，插件永不代点）；拒绝则 weights 步骤不启动 |
| 再分发（III） | 分发须附协议副本/NOTICE/修改声明 | 我们不分发权重；文档明确"权重由用户自上游直接获取，协议原件随权重落盘"（引擎 fetch 已把 LICENSE/NOTICE 写进模型目录——如实转述此行为） |
| 商用门槛（IV.1） | 年化营收 >100 万美元 或 提供 Hosted Service 须另行书面授权 | DISCLAIMER 声明：本插件为本地工具；若用户构建对外托管服务，须自行取得 MiniMax 授权 |
| 商用展示（IV.2） | 商用产品 UI 须显著展示 "MiniMax-H3-Image" | 铭牌天然满足（provider 标注）；文档提示商用用户 |
| 使用限制（V） | 合规 + AUP（Exhibit A）；**不得用输出训练其他模型**（V.3）；向第三方提供前须绑定同等条款（V.2） | README/DISCLAIMER 转述；AUP 链接随 license 步骤展示 |
| 商标（VI.2） | 无商标授权；描述性使用除外 | 包名/文档以描述性方式引用 "MiniMax-H3-Image"；显著声明"与 MiniMax 无关联、非官方插件"；不用 MiniMax logo |
| 输出归属（VI.4） | MiniMax 对输出不主张权利；用户全责 | DISCLAIMER 如实转述 |
| 专利诉讼终止（VI.3） | 起诉即许可终止 | 文档收录要点即可，不重复全文 |

**"对外发布"的合规定性（定案）**：发布的是 MIT 插件代码（全球可发布，无地域条款传染——代码不是 "MiniMax-H3-Image Works"，不含权重/导出物）；权重获取行为发生在用户与上游之间、受用户所在地域约束，插件的角色是"带许可展示与确认的下载器"。此定性写入 README 的 License 章节，并建议用户在排除地区者不要执行 weights 步骤。

## 落地清单（M3 门禁项）

- [ ] `LICENSE`（MIT）+ `THIRD_PARTY_NOTICES.md`（层 2 全量 + 层 3 引用性说明）
- [ ] 向导 license 步骤：协议要点 + 地域排除 + AUP 链接 + 双勾选（已读 / 不在排除地区）
- [ ] README 顶部 License & Territory 声明块（双语）
- [ ] "非官方、与 MiniMax 无关联" 声明（README 首屏 + DETAIL + 插件 meta.description 之外另置，防商标暗示）
- [ ] 本文件随仓库公开（展示合规诚意），发布前对照上表逐条自查一遍
