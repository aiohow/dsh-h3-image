# Disclaimer / 免责声明

> 本文件为对外定稿（中英双语，中文在前）。落点：README 顶部摘要块、插件详情页、向导 license 步骤内嵌勾选。
> 数字口径与 README 资源账一致（裸机验收实测，2026-11-12/13）。

## 中文

**免责声明**

1. **非官方**：本插件是社区独立开发的第三方工具，与 MiniMax 无任何关联、未获其背书。"MiniMax-H3-Image" 仅用于指示所支持的模型。
2. **模型许可与地域限制**：MiniMax-H3-Image 权重依 MiniMax 社区许可协议提供，**授权地域不含欧盟、英国、韩国、美国**。量化文本编码器来自第三方仓库 `ddalcu/MiniMax-H3-FL2VA-MLX-Serve-8bit`，另依 **MiniMax H3 社区许可协议**（同样排除上述四区）提供；两份协议原件均随下载落盘在你的模型目录。下载权重即视为你接受相应协议；请自行确认你所在司法辖区可合法使用。模型内容政策（AUP）同样适用。本插件与模型及其许可无关，只是带许可门的下载器与运行器。
3. **硬件与资源**：需要 Apple Silicon、≥48GB 统一内存（32GB 先警告再确认，低于 32GB 拒绝）、安装期约 60GB 磁盘峰值（实测 58.6GB）。生成期间 GPU/内存高负载，可能拖慢同机其他任务；请避免在关键工作期间运行。
4. **生成内容责任归你**：模型对输出的合法性、版权、肖像权、商标不担保；发布 AI 生成内容请遵守当地法规（多地要求显式标注 AI 生成）。你不得将输出用于训练其他模型（许可 §V.3）。
5. **不提供担保与责任上限**：软件按"现状"提供（MIT），不含任何明示或默示担保；作者对数据丢失、业务损失、许可违规后果不承担责任。
6. **供应链如实告知**：安装过程会从 huggingface.co（或你选择的镜像）、github.com、pypi.org 下载第三方内容，各自受其条款约束；插件本身运行期零出网、零遥测、零凭据。
7. **商用提示**：若你将本能力用于对外托管服务，或你的组织年化营收超 100 万美元，需按 MiniMax 许可另行取得书面授权——这不是本插件能替你完成的义务。商用产品 UI 须按许可 §IV.2 显著展示 "MiniMax-H3-Image"。

## English

**Disclaimer**

1. **Unofficial**: a third-party community tool, not affiliated with or endorsed by MiniMax. "MiniMax-H3-Image" is referenced descriptively only.
2. **Model license & territory**: weights are provided under the MiniMax Community License, whose authorized territory **excludes the EU, UK, South Korea and the US**. The quantized text encoder comes from the third-party repo `ddalcu/MiniMax-H3-FL2VA-MLX-Serve-8bit` under a second agreement, the **MiniMax H3 Community License (same four excluded territories)**; both original agreement files land on your disk with the downloads. Downloading weights means you accept the corresponding agreement; verify you may lawfully use the model in your jurisdiction. The model's Acceptable Use Policy applies. This plugin is unrelated to the model and its license terms — it is only a downloader and runner with a license gate.
3. **Hardware**: Apple Silicon, ≥48 GB unified memory (32 GB is warned-then-confirmed, below 32 GB is refused), ~60 GB peak disk during setup (measured 58.6 GB). Generation saturates GPU/memory and may slow other work on the same machine.
4. **You own your outputs and the responsibility for them**: no warranty on copyright, likeness or trademark of results; label AI-generated content where your local law requires; do not train other models on outputs (license §V.3).
5. **No warranty / liability**: MIT "as is", to the maximum extent permitted, including model-license violations and data loss.
6. **Supply chain, stated plainly**: setup downloads from huggingface.co (or your chosen mirror), github.com and pypi.org under their own terms; the plugin itself is zero-telemetry, zero-credentials, and makes no network calls at generation time.
7. **Commercial note**: offering this as a hosted service, or >US$1M annualized revenue, requires separate written authorization from MiniMax — an obligation this plugin cannot discharge for you. Commercial products must display "MiniMax-H3-Image" prominently per license §IV.2.

## 向导确认内容（license 步骤展示，接受前必须读懂的两条）

- 我已阅读插件展示的协议要点与全文直链，理解两份协议授权地域**均不含欧盟、英国、韩国、美国**，并确认我所在辖区不在排除列表内。
- 我理解生成内容的合法性与使用责任由我承担，且不得将输出用于训练其他模型。

（插件以一次 `accept=true` 记录你对**两份协议**的确认，时间戳落盘、不记录任何身份信息；两份确认齐备才允许 weights 下载与生成。）
