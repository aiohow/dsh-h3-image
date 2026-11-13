# dsh-h3-image

[简体中文](#简体中文) | [English](#english)

## 简体中文

> **非官方声明**：本插件是社区独立开发的第三方工具，与 MiniMax 无任何关联、未获其背书；"MiniMax-H3-Image" 仅用于指示所支持的模型。权重依 MiniMax 社区许可协议提供，**授权地域不含欧盟、英国、韩国、美国**——请自行确认你所在司法辖区可合法使用。完整免责与商用提示见 [docs/DISCLAIMER.md](docs/DISCLAIMER.md)。

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：把开源的 **MiniMax H3-Image** 文生图模型跑在**你自己的 Apple Silicon Mac** 上，走 [MLX](https://github.com/ml-explore/mlx) 引擎，全程本地。不用申请 API key，不用注册账号，不按张收费，生图时不联网。

用法就三步：先跑 `h3_status` 体检看机器行不行，再让 `h3_setup` 向导把引擎和权重装好（下载前要你自己确认 MiniMax 的许可协议），之后用 `h3_image` 生图。

### 工具一览

| 工具 | 干什么用 |
| --- | --- |
| `h3_status` | 只读体检：平台、内存、venv、引擎版本、权重、磁盘逐项检查，缺什么标红并告诉你怎么修。 |
| `h3_setup` | 安装向导：`check → venv → engine → license → weights → smoke` 一步步走，中断了重跑接着来。耗时长的步骤（装引擎、下 59 GB 权重）放后台跑，提交后马上返回 `job_id`，用 `action=poll` 看进度；下到一半断了，重跑从 `.part` 接着下，下完的分片不会重下；任务被杀会如实报 `interrupted`，不谎报"完成"。`action=license` 展示许可协议，只能由你自己确认接受；`action=reset` 清掉本地状态记录。 |
| `h3_image` | 文生图。同一时间只跑一张，第二张会立刻收到 `busy`；出图前先校验 PNG 结构，确认是完整图才报成功，图片存到你的会话工作区。 |

### 运行要求

- Apple Silicon Mac（M1 及以上；Intel Mac 和 Windows/Linux 跑不了，`h3_status` 会直接拦下告诉你，不会跑到一半崩掉）。
- **建议 48GB 及以上统一内存**；32GB 会先警告、你确认了才继续，低于 32GB 直接拒绝。
- 安装期留约 60GB 磁盘（从零安装实测峰值；装完引擎会自删源分片，稳态约 53GB——见下面资源占用）。
- DSH ≥ 0.2.2-rc.1，Node ≥ 22.19。

### 资源占用（实测，从零安装 2026-11-12/13）

下面每个数字都是在一台 275GB 内存的机器上从零装一遍实测出来的（没有任何可复用的旧文件），不是估算。

| 项目 | 实测 |
| --- | --- |
| 磁盘峰值（安装全程最多占） | 58.6 GB：DiT 分片 21.5 + 文本编码器 28.2 + 在途源分片 5.4 + venv 1.1 |
| 磁盘稳态（装完之后） | 53.2 GB（引擎转换完会自删源分片） |
| 建 venv | ~18 s（本机有合适的独立 Python 就直接用，没有就如实说没有） |
| 引擎 clone + pip install | ~72 s |
| 单个 transformer 分片（下载 5.5 GB + Q8 转换 + 删除） | ~4–5 分钟 |
| 续传段（7 个分片 + 28.2 GB 文本编码器） | 41 分钟 |
| 第一次出图 | 30 s（引擎实际耗时 10.8 s；1 MP，6 步） |
| 生图内存峰值（引擎 metrics） | 27.5 GB / 张 @ 1 MP |
| 运行期间宿主已用内存 | 274 GB——含常驻推理服务；插件自己占的就是上面那 27.5 GB |

中断的步骤可以接着来：被杀的下载从 `.part` 继续（Range 请求），下完的分片绝不重下——上面那次从零安装的续传过程全程有日志可对账。

### 许可——下载权重前必读

本插件的**代码**是 MIT。插件不打包、不托管、不再分发模型——模型和它的许可条款跟插件无关，插件只是个带许可确认环节的下载器和运行器。安装向导会从 Hugging Face 官方仓库按钉定版本下载权重，下载任何字节之前**先展示两份协议的要点和全文直链**（权重：MiniMax H3 Image 社区许可；量化文本编码器：MiniMax H3 社区许可，各来自自己的上游仓库），并**点名不支持的地区（欧盟、英国、韩国、美国）**；协议原件会随下载存到你的模型目录里。要你自己确认接受，插件绝不代你点。上游引擎是 Apache-2.0。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

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

两道发布门禁会在 CI 和 `prepack` 时自动跑：`scripts/check-release-safety.mjs` 扫源码**和**发布包（不含本机路径/用户名、不含 macOS 垃圾文件、不含密钥），`scripts/check-version-consistency.mjs` 核对 package.json、CHANGELOG、locale、钉定版本四处一致。

---

## English

> **Unofficial**: a third-party community tool, not affiliated with or endorsed by MiniMax; "MiniMax-H3-Image" is referenced descriptively only. Weights are provided under the MiniMax Community License, whose authorized territory **excludes the EU, UK, South Korea and the US** — verify you may lawfully use the model in your jurisdiction. Full disclaimer: [docs/DISCLAIMER.md](docs/DISCLAIMER.md).

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin bundle that runs the open-source **MiniMax H3-Image** text-to-image model **entirely on your own Apple Silicon Mac**, through the [MLX](https://github.com/ml-explore/mlx) engine. No API keys, no accounts, no per-image fees, no egress during generation.

The current version ships the full local pipeline: the read-only environment check, the one-time setup wizard (venv → pinned engine clone → license gate → sha256-verified weight download with resume → smoke test, each long step a background job that survives restarts), and text-to-image.

### Tools

| Tool | Purpose |
| --- | --- |
| `h3_status` | Read-only health check: platform, unified memory, venv, engine commit, weights, text encoder, free disk — each red item carries a fix hint. |
| `h3_setup` | The one-time setup wizard as a resumable state machine: `check → venv → engine → license → weights → smoke`. Long steps (engine install, ~59 GB of downloads + conversion) run as detached background jobs — submit returns a `job_id` in seconds, `action=poll` reads progress from the engine's own on-disk state, and an interrupted download resumes from `.part` on re-run. A dead job is reported `interrupted`, never "done". `action=license` shows the community license; acceptance is recorded only by you. `action=reset` clears the local state record. |
| `h3_image` | Text-to-image: one engine subprocess per call, internal deadline, one generation at a time (a second call gets an immediate `busy`), PNG verified before it is reported, output lands in your session workspace. |

### Requirements

- Apple Silicon Mac (M1 or later; Intel Macs and Windows/Linux are not supported — `h3_status` declines them up front instead of crashing halfway).
- **48 GB+ unified memory recommended**; 32 GB machines are warned-then-confirmed, below 32 GB is refused.
- ~60 GB free disk during setup (measured peak on a from-zero install; the steady state after the engine deletes source shards is ~53 GB — see the resource ledger below).
- DSH ≥ 0.2.2-rc.1, Node ≥ 22.19.

### Resource usage (measured, from-scratch install 2026-11-12/13)

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
