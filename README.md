# dsh-h3-image

[简体中文](#简体中文) | [English](#english)

## 简体中文

> **非官方声明**：本插件是社区独立开发的第三方工具，与 MiniMax 无任何关联、未获其背书；"MiniMax-H3-Image" 仅用于指示所支持的模型。权重依 MiniMax 社区许可协议提供，**授权地域不含欧盟、英国、韩国、美国**——请自行确认你所在司法辖区可合法使用。完整免责与商用提示见 [docs/DISCLAIMER.md](docs/DISCLAIMER.md)。

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件包：在**你自己的 Apple Silicon Mac** 上，通过 [MLX](https://github.com/ml-explore/mlx) 引擎运行开源的 **MiniMax H3-Image** 文生图模型，全程完全本地。零 API 密钥、零账号、零按张费用，生图过程零出网。

当前版本交付完整本地链路：只读环境体检、一键安装向导（venv → 钉定引擎 clone → 许可确认 → sha256 校验的权重下载（支持断点续传）→ 冒烟出图，每个长步骤都是宿主重启不丢的后台任务），以及本地文生图。

### 你能得到什么

| 工具 | 用途 |
| --- | --- |
| `h3_status` | 只读环境体检：平台、统一内存、venv、引擎 commit、权重、文本编码器、可用磁盘——每个红项附修复提示。 |
| `h3_setup` | 一键安装向导，可续传状态机：`check → venv → engine → license → weights → smoke`。长步骤（引擎安装、约 59 GB 下载+转换）以分离后台任务运行——提交秒级返回 `job_id`，`action=poll` 从引擎自身的磁盘状态读进度，中断的下载重跑时从 `.part` 续传。死掉的任务如实报 `interrupted`，绝不谎报"完成"。`action=license` 展示社区许可，接受记录只能由你本人产生；`action=reset` 清除本地状态记录。 |
| `h3_image` | 文生图：每次调用一个引擎子进程、内部 deadline、同一时刻只跑一路（第二路立即收到 `busy`）、PNG 结构校验通过才上报，产物落在你的会话工作区。 |

### 运行要求

- Apple Silicon Mac（引擎仅支持 arm64；Intel/Windows/Linux 由 `h3_status` 明确拒绝，而不是崩溃）。
- **建议 48GB 及以上统一内存**；32GB 机型先警告再确认，低于 32GB 拒绝。
- 安装期约 60GB 可用磁盘（从零安装实测峰值；引擎删除源分片后稳态约 53GB——见下方资源账）。
- DSH ≥ 0.2.2-rc.1，Node ≥ 22.19。

### 资源账（实测，裸机验收 2026-11-12/13）

以下每个数字都来自 275GB Apple Silicon 机器上的一次从零验收运行（无复用候选、全新 venv/引擎/权重）——不是估算。

| 项目 | 实测 |
| --- | --- |
| 磁盘峰值（增量，全程） | 58.6 GB (54.6 GiB)：DiT pack 21.5 + 文本编码器 28.2 + 在途源分片 5.4 + venv 1.1 |
| 磁盘稳态（安装完成后） | 53.2 GB（引擎转换后自删源分片） |
| venv 创建 | ~18 s（找到合适的独立 CPython 即复用，否则如实报 miss） |
| 引擎 clone + pip install | ~72 s |
| 权重：单个 transformer 分片（下载 5.5 GB + Q8 转换 + 删除） | ~4–5 分钟 |
| 权重：续传段（7 分片 + 28.2 GB 文本编码器） | 41 分钟 |
| 冒烟出图 | 30 s 墙钟 / 10.8 s 引擎时间（1 MP，6 步） |
| 生图内存峰值（引擎 metrics） | 27.5 GB / 张 @ 1 MP |
| 运行期间宿主已用内存 | 274 GB——含常驻推理服务；插件自身占用即上行的 27.5 GB |

中断的步骤可续传：被杀的下载从 `.part` 继续（Range 请求），已完成分片绝不重下——验收运行的续传审计实证（已完成分片零重下）。

### 许可——下载权重前必读

本插件的**代码**是 MIT，不打包、不托管、不再分发模型——模型与其许可条款与本插件无关，插件只是带许可门的下载器与运行器。安装向导从 Hugging Face 官方仓库按钉定 revision 下载权重，并在拉取任何字节之前**展示两份协议的要点与全文直链**（权重：MiniMax H3 Image 社区许可；量化文本编码器：MiniMax H3 社区许可，均来自各自上游仓库），**点名地域排除（EU/UK/KR/US）**；协议原件随下载落盘在你的模型目录里。由你本人确认接受；插件永不代你接受。上游引擎为 Apache-2.0。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

### 安装（DSH）

在 DSH 里用 `plugin_manager` 安装，两种来源任选：

```
install_bundle → dsh-h3-image            # 从 npm 装最新发布版
install_bundle → /path/to/dsh-h3-image   # 或本地仓库/解包目录
```

然后在 profile 中启用该 bundle，跑一次 `h3_status`——机器还缺什么它会逐项告诉你。

### 开发

```sh
npm test                                   # 单测（纯检查逻辑）
npm run release                            # 门禁 + pack + tarball 扫描
```

两道发布门禁在 CI 与 `prepack` 运行：`scripts/check-release-safety.mjs`（源码**与**产物 tarball 双扫：零机器指纹、零 AppleDouble、零密钥）与 `scripts/check-version-consistency.mjs`（package.json ↔ CHANGELOG ↔ locale ↔ 钉定 revision 四处一致）。

---

## English

> **Unofficial**: a third-party community tool, not affiliated with or endorsed by MiniMax; "MiniMax-H3-Image" is referenced descriptively only. Weights are provided under the MiniMax Community License, whose authorized territory **excludes the EU, UK, South Korea and the US** — verify you may lawfully use the model in your jurisdiction. Full disclaimer: [docs/DISCLAIMER.md](docs/DISCLAIMER.md).

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin bundle that runs the open-source **MiniMax H3-Image** text-to-image model **entirely on your own Apple Silicon Mac**, through the [MLX](https://github.com/ml-explore/mlx) engine. No API keys, no accounts, no per-image fees, no egress during generation.

The current version ships the full local pipeline: the read-only environment check, the one-time setup wizard (venv → pinned engine clone → license gate → sha256-verified weight download with resume → smoke test, each long step a background job that survives restarts), and text-to-image.

### What you get

| Tool | Purpose |
| --- | --- |
| `h3_status` | Read-only health check: platform, unified memory, venv, engine commit, weights, text encoder, free disk — each red item carries a fix hint. |
| `h3_setup` | The one-time setup wizard as a resumable state machine: `check → venv → engine → license → weights → smoke`. Long steps (engine install, ~59 GB of downloads + conversion) run as detached background jobs — submit returns a `job_id` in seconds, `action=poll` reads progress from the engine's own on-disk state, and an interrupted download resumes from `.part` on re-run. A dead job is reported `interrupted`, never "done". `action=license` shows the community license; acceptance is recorded only by you. `action=reset` clears the local state record. |
| `h3_image` | Text-to-image: one engine subprocess per call, internal deadline, one generation at a time (a second call gets an immediate `busy`), PNG verified before it is reported, output lands in your session workspace. |

### Requirements

- Apple Silicon Mac (the engine is arm64-only; Intel/Windows/Linux are declined by `h3_status`, not by a crash).
- **48 GB+ unified memory recommended**; 32 GB machines are warned-then-confirmed, below 32 GB is refused.
- ~60 GB free disk during setup (measured peak on a from-zero install; the steady state after the engine deletes source shards is ~53 GB — see the resource ledger below).
- DSH ≥ 0.2.2-rc.1, Node ≥ 22.19.

### Resource ledger (measured, bare-metal acceptance 2026-11-12/13)

Every number below comes from one from-zero acceptance run on a 275 GB Apple Silicon machine (no reuse candidates, fresh venv/engine/weights) — not from estimates.

| Item | Measured |
| --- | --- |
| Disk peak (incremental, whole setup) | 58.6 GB (54.6 GiB): DiT pack 21.5 + text encoder 28.2 + one in-flight source shard 5.4 + venv 1.1 |
| Disk steady state (post-setup) | 53.2 GB (source shards deleted by the engine after conversion) |
| venv creation | ~18 s (reuses a suitable standalone CPython when found; reports a miss otherwise) |
| Engine clone + pip install | ~72 s |
| Weights: per transformer shard (download 5.5 GB + Q8 convert + delete) | ~4–5 min |
| Weights: resume segment (7 shards + 28.2 GB text encoder) | 41 min |
| Smoke generation | 30 s wall / 10.8 s engine time (1 MP, 6 steps) |
| Generation peak memory (engine metrics) | 27.5 GB per image at 1 MP |
| Host memory in use during the run | 274 GB — includes a resident inference server; the plugin's own footprint is the 27.5 GB above |

Interrupted steps resume: a killed download continues from its `.part` (Range requests), and finished shards are never re-fetched — verified by the acceptance run's resume audit (zero re-downloads of completed shards).

### Licenses — read before downloading weights

This plugin's **code** is MIT. It does not ship, re-host or re-distribute the model — the model and its license terms have nothing to do with this plugin, which is only a downloader and runner with a license gate. Before any byte is fetched, the setup wizard **shows the key points of both agreements with direct links to their full texts** (weights: MiniMax H3 Image Community License; quantized text encoder: MiniMax H3 Community License, each from its own upstream repo) and **names the territorial exclusions (EU/UK/KR/US)**; the original agreement files land on your disk inside the model directory. You accept them yourself; the plugin never accepts on your behalf. The upstream engine is Apache-2.0. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

### Install (DSH)

Install with `plugin_manager`, from either source:

```
install_bundle → dsh-h3-image            # latest release from npm
install_bundle → /path/to/dsh-h3-image   # or a local checkout / unpacked dir
```

Then enable the bundle in your profile and run `h3_status` — it tells you exactly what the machine still needs.

### Development

```sh
npm test                                   # unit tests (pure check logic)
npm run release                            # gates + pack + tarball scan
```

Two release gates run in CI and on `prepack`:
`scripts/check-release-safety.mjs` (no machine fingerprints, no AppleDouble,
no secrets — in source **and** in the built tarball) and
`scripts/check-version-consistency.mjs` (package.json ↔ CHANGELOG ↔ locales ↔
pinned revisions).
