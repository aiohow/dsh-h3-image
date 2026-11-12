# DISCLAIMER 草案（对外文案，中英双语，三处落点）

> 落点：① README 顶部摘要块 ② 插件详情页 DETAIL.md ③ 向导 license 步骤内嵌。
> 原则：短、诚实、可执行——每条都对应一个真实存在的风险面，不写空话。

## 中文草案

**免责声明**

1. **非官方**：本插件是社区独立开发的第三方工具，与 MiniMax 无任何关联、未获其背书。"MiniMax-H3-Image" 仅用于指示所支持的模型。
2. **模型许可与地域限制**：MiniMax-H3-Image 权重依 MiniMax 社区许可协议提供，**授权地域不含欧盟、英国、韩国、美国**。下载权重即视为你接受该协议；请自行确认你所在司法辖区可合法使用。模型内容政策（AUP）同样适用。
3. **硬件与资源**：需要 Apple Silicon、≥48GB 统一内存、约 90GB 磁盘峰值。生成期间 GPU/内存高负载，可能拖慢同机其他任务；请避免在关键工作期间运行。
4. **生成内容责任归你**：模型对输出的合法性、版权、肖像权、商标不担保；发布 AI 生成内容请遵守当地法规（多地要求显式标注 AI 生成）。你不得将输出用于训练其他模型（许可 V.3）。
5. **不提供担保与责任上限**：软件按"现状"提供（MIT），不含任何明示或默示担保；作者对数据丢失、业务损失、许可违规后果不承担责任。
6. **供应链如实告知**：安装过程会从 huggingface.co（或你选择的镜像）、github.com、pypi.org 下载第三方内容，各自受其条款约束；插件本身运行期零出网、零遥测、零凭据。
7. **商用提示**：若你将本能力用于对外托管服务或你的组织年化营收超 100 万美元，需按 MiniMax 许可另行取得书面授权——这不是本插件能替你完成的义务。

## English draft

**Disclaimer**

1. **Unofficial**: third-party community tool; not affiliated with or endorsed by MiniMax. "MiniMax-H3-Image" is referenced descriptively only.
2. **Model license & territory**: weights are provided under the MiniMax Community License, whose authorized territory **excludes the EU, UK, South Korea and the US**. Downloading weights means you accept that agreement; verify you may lawfully use it in your jurisdiction. The model's Acceptable Use Policy applies.
3. **Hardware**: Apple Silicon, ≥48 GB unified memory, ~90 GB peak disk. Generation saturates GPU/memory and may slow other work on the same machine.
4. **You own your outputs and the responsibility for them**: no warranty on copyright/likeness/trademark of results; label AI-generated content where your local law requires; do not train other models on outputs (license §V.3).
5. **No warranty / liability**: MIT "as is", to the maximum extent permitted, including model-license violations and data loss.
6. **Supply chain, stated plainly**: setup downloads from huggingface.co (or your chosen mirror), github.com and pypi.org under their own terms; the plugin itself is zero-telemetry, zero-credentials, and makes no network calls at generation time.
7. **Commercial note**: offering this as a hosted service, or >US$1M annualized revenue, requires separate written authorization from MiniMax — an obligation this plugin cannot discharge for you.

## 向导内嵌版（license 步骤，必须勾选的两条）

- [ ] 我已阅读 MiniMax-H3-Image 社区许可协议要点，理解授权地域**不含欧盟、英国、韩国、美国**，并确认我所在辖区不在排除列表内。
- [ ] 我理解生成内容的合法性与使用责任由我承担，且不得将输出用于训练其他模型。

（两条齐备才允许 weights 下载；确认时间戳落盘，不记录任何身份信息。）
