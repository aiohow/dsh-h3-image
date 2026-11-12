# ARCHITECTURE — dsh-h3-image

## 1. 包结构（bundle）

```
dsh-h3-image/
├── package.json              # dsh.bundle.patch + dsh.client(二期) + engines.dsh
├── cordis.patch.yml          # insert: id h3-image
├── lib/
│   ├── index.js              # apply(ctx, config)：注册 3 工具 + inject ["tools","attachments"]
│   ├── checks.js             # 体检五项（纯函数优先，可单测）
│   ├── setup.js              # 状态机 + 长任务 job 表（提交/轮询/恢复）
│   ├── runner.js             # 生图子进程驱动：spawn venv python → 解析 metrics JSON → 读图
│   ├── jobs.js               # 进程生命周期：pid 落盘、孤儿回收、日志 tail
│   ├── gate.js               # 并发闸门=1 + 负载探测提示
│   └── pinned.js             # 唯一版本常量文件：引擎 commit / 权重 revision / 期望 sha256 清单
├── locale/{en,zh}.json       # meta.title/description/detail + 全部 UI/错误文案
├── docs/DETAIL.md            # 插件详情页（能力/限制/免责摘要）
├── scripts/                  # 开发期门禁（不进 files）：check-release-safety 等
├── test/                     # node --test 单测 + 集成脚本
└── icon.svg  LICENSE(MIT)  THIRD_PARTY_NOTICES.md  SECURITY.md  CHANGELOG.md
```

## 2. 进程模型

```
DSH Host ──(spawn, 每任务)──> venv python generate_h3_image.py ──> PNG + metrics.json
                │
                └─ weights 走 mmap：冷启动 ~2s（实测 dit_load 0.53s），进程退出即归还 27GB
setup 长任务（engine/weights/smoke）由脱离进程组的 supervisor 承载，stdout 逐行解析进度 → 文件 job 表 → 轮询返回（详见 §3.1）
```

- **v1 不做热常驻**（serve_image.py keep_warm 收益仅 ~2s，27GB 常驻不值当；留 v2 评估）。
- setup 长任务的 supervisor 自成进程组、不挂 DSH 进程树：DSH 重启任务照跑；下次激活 reapOrphans 只把"pid 已死且无 result"的记为 `interrupted`（不假装完成），活着的一律不动（见 §3.1）。生图子进程则相反——插件卸载即 killActive（27GB 进程不留给禁用态插件）。
- 输出路径强制约束：默认 `<workspace>/generated-images/`；`output_dir` 参数解析后必须仍在工作区内，否则拒绝（防越权写）。

## 3. setup 状态机

```
check ──ok──> ready
  │
  ├─ python 缺 → venv（只建环境：解释器发现 config.python_bin→PATH→brew→python.org→uv→pyenv，≥3.13；无则指引+停）
  ├─ 引擎缺/commit 不符 → engine（clone --no-checkout + checkout pinned commit + pip install -r requirements.txt）
  ├─ 许可未接受 → license（展示要点+地域条款，用户确认后落盘 accepted@timestamp）
  ├─ 权重缺 → weights（复用候选 sha256 实证命中→符号链接复用；否则 fetch 逐片下载+转换+删源，断点续传；文本编码器由 assets/te_setup.py 按钉定 revision 拉取+校验）
  └─ 全绿 → smoke（一张 1MP 小图端到端，PNG 结构校验通过才算过）→ ready
```

工序顺序为实测定案（非推测）：引擎依赖清单在引擎仓库的 requirements.txt 里，所以 **venv 先建、pip 安装在 engine 步骤末尾**（clone → checkout → pip）。钉定 commit 不在 main 谱系上（实测：仅 `refs/heads/phosphene/v5.0-image5` 可达），clone 用 `--no-checkout` 直接落钉定 commit，避开"main 无图像脚本"已知坑。

每状态持久化到插件 storage 的 state.json（原子写 tmp+rename，与引擎 metrics 同风格）；`reset` 仅清状态文件不动资产。**重入判据是磁盘实探，不是状态文件**——状态文件只是记录，重跑永远重新探测（HEAD、manifest、PNG），证伪即改判。

### 3.1 长任务 job 架构（D4 三段式，M2 落地）

engine/weights/smoke 三步是长任务（分钟~小时级），执行模型：

```
h3_setup action=<step>  ──submit──>  记录 <id>.json + spec，spawn 脱离进程组的
                                      supervisor（lib/job-supervisor.mjs，无 shell，
                                      顺序执行 argv 链，日志追加 <id>.log，
                                      原子写 <id>.result.json）
                             返回 { job_id, next: "poll" }   ← 工具调用秒级返回
h3_setup action=poll     ──读文件 + pid 探活──> { state, progress, log_tail }
h3_setup action=kill     ──kill(-pgid)──> 已完成的分片留在原地（续传不重下）
```

- **supervisor 独立于 DSH 进程树**：DSH 重启/插件热重载不杀任务；插件侧只读文件 + `kill(pid,0)` 探活，从不持有子进程句柄。
- **`interrupted` 语义**：记录 running 但 pid 已消失且无 result 文件 → 标 `interrupted`，永不报成完成。激活时 `reapOrphans` 只标死任务，**running 且 pid 活着的任务不动**（多小时下载跨插件重载存活）。
- **done 不作数，磁盘说了算**：poll 在 result.ok 之后做完成校验——engine 回读 HEAD==钉定 commit；weights 查 DiT manifest + text encoder + 上游 config 三件齐；smoke 读 PNG 做结构校验。任一缺失即改判 `failed`（error_type=verify）。
- **失败归因**：classifySetupFailure 按日志尾部正则映射到共享错误分类（disk/verify/license/network/memory/engine），零本机绝对路径出现在用户可见文案（displayPath → `~`）。
- **镜像诚实口径**：`mirror:"hf-mirror"` 只作用于文本编码器下载（`HF_ENDPOINT` 环境变量，hf_hub_download 遵守）；主权重走引擎自带 fetch 脚本，其 URL 硬编码官方站——不改动钉定引擎（D1），README 如实声明镜像不覆盖主权重。

## 4. Config schema（configEditor 持久化，双 profile 同步纪律）

```
model_dir    默认 ~/dsh-h3-image/models      （探测到可复用资产时提示改指）
engine_dir   默认 ~/dsh-h3-image/engine
venv_dir     默认 ~/dsh-h3-image/venv
mirror       "hf" | "hf-mirror"，默认 hf
default_mp   默认 4
```
不写死任何本机路径（D6）；本机 `phosphene/`、`~/.mlx-serve/...FL2VA...` 仅出现在"复用探测候选表"。

## 5. 与 harness 的契约点

| 契约 | 处置 |
|---|---|
| 工具超时策略 | 一切 >60s 的动作走 job 三段式（D4），工具调用本身秒级返回 |
| attachments | 出图走与 dsh-image-gen 相同的图块形态，铭牌逐后端标注（复用其铭牌纪律） |
| 插件禁用即卸载 | 工具随 fiber 卸载消失；job 表里 running 任务在下次激活时回收（孤儿 kill） |
| engines.dsh | 下限按开发基线填写；升级兼容走维护流程，不装"可能兼容" |
| 版本一致性 | pinned.js 与 README/CHANGELOG 版本由 check-version-consistency 门禁核对（借 dsh-image-gen 工具思路重写，不 import 它） |

## 6. 失败归因分类（所有工具共用错误信封）

`{ ok:false, error_type: "network"|"disk"|"license"|"memory"|"verify"|"engine"|"timeout"|"busy"|"unsupported_platform", message, fix_hint }`
—— 对外文案零本机绝对路径（用 `~` 或占位符），零用户名，与脱敏门禁联动（见 SECURITY-PRIVACY §3）。
