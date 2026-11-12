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
setup 长任务（weights/convert）同样子进程化，stdout 逐行解析进度 → job 表 → 轮询返回
```

- **v1 不做热常驻**（serve_image.py keep_warm 收益仅 ~2s，27GB 常驻不值当；留 v2 评估）。
- 子进程一律 `run_in_background` 语义由 jobs.js 管理：pid+状态落盘到插件 storage，DSH 重启后可"认领或回收"孤儿（回收=kill+标记 failed，不假装完成）。
- 输出路径强制约束：默认 `<workspace>/generated-images/`；`output_dir` 参数解析后必须仍在工作区内，否则拒绝（防越权写）。

## 3. setup 状态机

```
check ──ok──> ready
  │
  ├─ python 缺 → venv（解释器发现：brew/python.org/pyenv/uv，≥3.13；无则指引+停）
  ├─ 引擎缺/commit 不符 → engine（clone + checkout pinned commit；main 无图像脚本=已知坑）
  ├─ 许可未接受 → license（展示要点+地域条款，用户确认后落盘 accepted@timestamp）
  ├─ 权重缺 → weights（复用探测 sha256 命中→跳过；否则 fetch 逐片下载+转换+删源，断点续传）
  └─ 全绿 → smoke（一张 1MP 小图端到端）→ ready
```

每状态持久化到插件 storage 的 state.json（原子写 tmp+rename，与引擎 metrics 同风格）；`reset` 仅清状态文件不动资产。

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
