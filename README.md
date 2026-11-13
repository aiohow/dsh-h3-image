# dsh-h3-image

[简体中文](#简体中文) | [English](#english)

## 简体中文

> **非官方声明**：本插件是社区独立开发的第三方工具，与 MiniMax 无任何关联、未获其背书；"MiniMax-H3-Image" 仅用于指示所支持的模型。权重依 MiniMax 社区许可协议提供，**授权地域不含欧盟、英国、韩国、美国**——请自行确认你所在司法辖区可合法使用。完整免责与商用提示见 [docs/DISCLAIMER.md](docs/DISCLAIMER.md)。

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：把开源的 **MiniMax H3-Image** 文生图模型跑在**你自己的 Apple Silicon Mac** 上，走 [MLX](https://github.com/ml-explore/mlx) 引擎，全程本地。不用申请 API key，不用注册账号，不按张收费，生图时不联网。

用法就三步：先跑 `h3_status` 体检看机器行不行，再让 `h3_setup` 向导把引擎和权重装好（下载前要你自己确认 MiniMax 的许可协议），之后用 `h3_image` 生图。

### 工具一览

| 工具 | 干什么用 |
| --- | --- |
| `h3_status` | 只读体检：平台、内存、venv、引擎版本、权重、文本编码器、磁盘逐项检查，缺什么标红并告诉你怎么修。 |
| `h3_setup` | 安装向导：`check → venv → engine → license → weights → smoke` 一步步走，中断了重跑接着来。耗时长的步骤（装引擎、下 59 GB 权重）放后台跑，提交后马上返回 `job_id`，用 `action=poll` 看进度；下到一半断了，重跑从 `.part` 接着下，下完的分片不会重下；任务被杀会如实报 `interrupted`，不谎报"完成"。`action=license` 展示许可协议，只能由你自己确认接受；`action=reset` 清掉本地状态记录。 |
| `h3_image` | 文生图。同一时间只跑一张，第二张会立刻收到 `busy`；出图前先校验 PNG 结构，确认是完整图才报成功，图片存到你的会话工作区。 |

### 运行要求

- Apple Silicon Mac（M1 及以上；Intel Mac 和 Windows/Linux 跑不了，`h3_status` 会直接拦下告诉你，不会跑到一半崩掉）。
- **建议 48GB 及以上统一内存**；32GB 会先警告、你确认了才继续，低于 32GB 直接拒绝。
- 安装期留约 60GB 磁盘（从零安装实测峰值；装完引擎会自删源分片，之后大约占 53GB——见下面资源占用）。
- DSH ≥ 0.2.2-rc.1，Node ≥ 22.19。

### 资源占用（实测）

数据由 M5 Ultra 256G 设备从零开始安装实测，所需时间因机器及网络情况而不同，仅做参考。

| 项目 | 实测 |
| --- | --- |
| 安装期间磁盘 | 峰值约 60 GB |
| 装完后磁盘 | 约 53 GB（源分片转换完会自动删掉） |
| 单张图内存（1 MP） | 约 27.5 GB |
| 每个权重分片（下载 + 转换） | 约 4–5 分钟，看你的网速 |
| 第一次出图 | 约 30 秒 |

中断的步骤可以接着来：下到一半断了从 `.part` 继续，下完的分片不会重下。内存那行是引擎自己报的单张图占用。

### 许可——下载权重前必读

本插件的**代码**是 MIT。插件不打包、不托管、不再分发模型——模型和它的许可条款跟插件无关，插件只是个带许可确认环节的下载器和运行器。安装向导会从 Hugging Face 官方仓库按固定版本下载权重，下载任何字节之前**先展示两份协议的要点和全文链接**（权重：MiniMax H3 Image 社区许可；量化文本编码器：MiniMax H3 社区许可，各来自自己的上游仓库），并**点名不支持的地区（欧盟、英国、韩国、美国）**；协议原件会随下载存到你的模型目录里。要你自己确认接受，插件绝不代你点。上游引擎是 Apache-2.0。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

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

两个发布检查在 CI 和 `prepack` 里自动跑，你不用记着手动跑：`check-release-safety` 保证源码和发出去的包里不含本机路径、用户名、macOS 垃圾文件和密钥；`check-version-consistency` 保证 package.json、CHANGELOG、两个 locale 里的版本号一致，`lib/pinned.js` 里钉的版本号格式合法。

---

## English

> **Unofficial**: a third-party community tool, not affiliated with or endorsed by MiniMax; "MiniMax-H3-Image" is referenced descriptively only. Weights are provided under the MiniMax Community License, whose authorized territory **excludes the EU, UK, South Korea and the US** — verify you may lawfully use the model in your jurisdiction. Full disclaimer: [docs/DISCLAIMER.md](docs/DISCLAIMER.md).

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin bundle that runs the open-source **MiniMax H3-Image** text-to-image model **entirely on your own Apple Silicon Mac**, through the [MLX](https://github.com/ml-explore/mlx) engine. No API keys, no accounts, no per-image fees, no network access during generation.

Usage is three steps: run `h3_status` to see whether your machine qualifies, let the `h3_setup` wizard install the engine and the weights (you confirm the MiniMax license yourself before anything downloads), then generate images with `h3_image`.

### Tools

| Tool | Purpose |
| --- | --- |
| `h3_status` | Read-only health check: platform, unified memory, venv, engine version, weights, text encoder, free disk — each red item carries a fix hint. |
| `h3_setup` | The one-time setup wizard as a resumable state machine: `check → venv → engine → license → weights → smoke`. Long steps (engine install, ~59 GB of downloads + conversion) run as detached background jobs — submit returns a `job_id` in seconds, `action=poll` reads progress from the engine's own on-disk state, and an interrupted download resumes from `.part` on re-run. A dead job is reported `interrupted`, never "done". `action=license` shows the community license; acceptance is recorded only by you. `action=reset` clears the local state record. |
| `h3_image` | Text-to-image: one engine subprocess per call, internal deadline, one generation at a time (a second call gets an immediate `busy`), PNG verified before it is reported, output lands in your session workspace. |

### Requirements

- Apple Silicon Mac (M1 or later; Intel Macs and Windows/Linux are not supported — `h3_status` declines them up front instead of crashing halfway).
- **48 GB+ unified memory recommended**; 32 GB machines are warned-then-confirmed, below 32 GB is refused.
- ~60 GB free disk during setup (measured peak on a from-zero install; the steady state after the engine deletes source shards is ~53 GB — see the resource usage below).
- DSH ≥ 0.2.2-rc.1, Node ≥ 22.19.

### Resource usage (measured)

Measured on an M5 Ultra with 256 GB of unified memory, from a from-scratch install. Times vary with your machine and your network, so treat them as a reference.

| Item | Measured |
| --- | --- |
| Disk during setup | ~60 GB at peak |
| Disk after setup | ~53 GB (source shards are deleted once converted) |
| Memory per image (1 MP) | ~27.5 GB |
| Per weight shard (download + convert) | ~4–5 min, depends on your connection |
| First image | ~30 s |

Interrupted steps resume: a killed download continues from its `.part`, and finished shards are never re-downloaded. The memory figure is the per-image footprint the engine reports itself.

### Licenses — read before downloading weights

This plugin's **code** is MIT. It does not ship, re-host or re-distribute the model — the model and its license terms have nothing to do with this plugin, which is only a downloader and runner with a license gate. The setup wizard downloads the weights from the official Hugging Face repositories at pinned versions, and before any byte is fetched it **shows the key points of both agreements with direct links to their full texts** (weights: MiniMax H3 Image Community License; quantized text encoder: MiniMax H3 Community License, each from its own upstream repo) and **names the territorial exclusions (EU/UK/KR/US)**; the original agreement files land on your disk inside the model directory. You accept them yourself; the plugin never accepts on your behalf. The upstream engine is Apache-2.0. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

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

The two release checks also run in CI and on `prepack`, so you don't have to remember
them: `check-release-safety` makes sure the source and the published package are free of
local paths, usernames, macOS junk files and secrets; `check-version-consistency` checks
that the version in package.json, CHANGELOG and both locale files agree, and that the
pinned revisions in `lib/pinned.js` are well-formed.
