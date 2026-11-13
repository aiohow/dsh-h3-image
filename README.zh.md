# dsh-h3-image

[English](README.md) | **简体中文**

> **名称已占位。** 当前版本（0.2.0）交付完整本地链路：只读环境体检、一键安装
> 向导（venv → 钉定引擎 clone → 许可确认 → sha256 校验的权重下载（支持断点
> 续传）→ 冒烟出图，每个长步骤都是重启不丢的后台任务），以及本地文生图。
> 全程不调用任何云服务。

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）
插件包，通过 [MLX](https://github.com/ml-explore/mlx) 引擎在你的 **Apple
Silicon Mac 上完全本地**运行开源的 **MiniMax H3-Image** 文生图模型。
零 API 密钥、零账号、零按图计费，生图过程零出网。

## 提供什么

| 工具 | 用途 |
| --- | --- |
| `h3_status` | 只读体检：平台、统一内存、venv、引擎 commit、权重、文本编码器、可用磁盘——每一项红灯都附修复提示。 |
| `h3_setup` | 一次性安装向导，可续跑的状态机：`check → venv → engine → license → weights → smoke`。长步骤（引擎安装、约 59 GB 下载 + 转换）以脱离进程组的后台任务运行——提交秒级返回 `job_id`，`action=poll` 从引擎自己的磁盘状态读进度，中断的下载重跑即从 `.part` 续传。进程已死的任务如实报 `interrupted`，绝不谎报"完成"。`action=license` 展示社区许可，只有你本人确认才会记录接受。`action=reset` 清除本机状态记录。 |
| `h3_image` | 文生图：每次调用一个引擎子进程，内置截止时间，同一时刻只跑一张（第二路立即收到 `busy`），PNG 结构校验通过才报成功，产物落在会话工作区。 |

## 环境要求

- Apple Silicon Mac（引擎仅支持 arm64；Intel/Windows/Linux 在 `h3_status`
  检查阶段即明确拒绝，而不是崩溃）。
- **推荐 48 GB 及以上统一内存**；32 GB 机器先警告再确认，低于 32 GB 拒绝。
- 安装期约 60 GB 可用磁盘（from-zero 安装的实测峰值；引擎删除源分片后的
  稳态约 53 GB——见下方资源账表）。
- DSH ≥ 0.2.2-rc.1，Node ≥ 22.19。

## 资源账（实测，裸机验收 2026-11-12/13）

下表每个数字都来自 275 GB Apple Silicon 机器上的一次 from-zero 验收运行
（无复用候选、全新 venv/引擎/权重）——不是估算。

| 项目 | 实测 |
| --- | --- |
| 磁盘峰值（增量，整个安装过程） | 58.6 GB（54.6 GiB）：DiT 打包 21.5 + 文本编码器 28.2 + 在途源分片 5.4 + venv 1.1 |
| 磁盘稳态（安装完成后） | 53.2 GB（源分片由引擎转换后自行删除） |
| venv 创建 | 约 18 秒（能发现合适的独立 CPython 就复用，探测不到如实报 miss） |
| 引擎 clone + pip 安装 | 约 72 秒 |
| 权重：每个 transformer 分片（下载 5.5 GB + Q8 转换 + 删除） | 约 4–5 分钟 |
| 权重：续传段（7 分片 + 28.2 GB 文本编码器） | 41 分钟 |
| 冒烟出图 | 墙钟 30 秒 / 引擎耗时 10.8 秒（1 MP，6 步） |
| 单图内存峰值（引擎 metrics） | 1 MP 每图 27.5 GB |
| 运行期间主机已用内存 | 274 GB——含常驻推理服务；插件自身占用即上行 27.5 GB |

中断可续：被杀的下载从 `.part` 继续（Range 请求），已完成分片绝不重下——
验收运行的续传对账为证（零重下已完成分片）。

## 许可——下载权重前必读

本插件的**代码**是 MIT。**不打包、不转载、不分发模型。** 安装向导从官方
Hugging Face 仓库按钉定 revision 下载权重，并且**在任何一个字节下载之前，
向你展示 MiniMax H3 Image 社区许可协议（含其地域排除条款）。由你本人接受；
插件永不代你接受。** 上游引擎为 Apache-2.0。见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 安装（DSH）

```
plugin_manager → install_bundle → <本仓库或 npm 包>
```

然后在 profile 中启用该 bundle，跑一次 `h3_status`——机器还缺什么它逐项
告诉你。

## 开发

```sh
npm test                                   # 单元测试（纯检查逻辑）
npm run release                            # 门禁 + 打包 + tarball 扫描
```

两道发布门禁在 CI 和 `prepack` 上运行：
`scripts/check-release-safety.mjs`（零机器指纹、零 AppleDouble、零密钥——
源码**和**构建出的 tarball 都扫）与
`scripts/check-version-consistency.mjs`（package.json ↔ CHANGELOG ↔ locale ↔
钉定 revision 一致性）。
