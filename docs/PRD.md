# PRD — dsh-h3-image

## 1. 目标用户与场景

- **主场景**：DSH 用户在 Apple Silicon Mac 上想要一个完全本地、零出网、零订阅的生图通道；装完插件跟着向导走就能用。
- **次场景**：已有本机 H3 资产的机器（如开发机），check 全绿即刻用，不重复下载。
- **明确不是目标用户**：Windows/Linux/Intel Mac 用户（check 阶段礼貌拒绝并说明原因）；需要参考图/图像编辑的用户（当前引擎能力面外，见 §4）。

## 2. 用户故事（验收即按此走查）

- U1 我在插件页安装 bundle、开启插件，对 agent 说"画一张 X"，若环境未就绪，agent 能列出缺什么并逐步带我把环境装好（每步有进度、可中断可续）。
- U2 环境就绪后，"画一张 X"直接出图，图出现在对话里，带来源铭牌（本地 H3-Image、尺寸、耗时、seed）。
- U3 我能选择画幅（aspect）与清晰度档（mp），默认 4MP；选 16MP 时插件提示耗时与内存账。
- U4 我中途退出 DSH，下次开启插件时 setup 进度不丢（断点续传）。
- U5 磁盘/内存不满足时，我得到的是明确红字清单（缺多少 GB、为什么），而不是崩溃或静默失败。
- U6 我在非 Apple Silicon 或 <32GB 机器上安装，插件明确告知不支持及原因，不开始任何下载。
- U7 我首次下载权重前，看到 MiniMax 许可要点（含地域排除）并需勾选同意；不同意则一切停止。

## 3. 工具面 schema 草案（v1）

### 3.1 `h3_status`（只读，零副作用）
```
输入: 无（或 { "verbose": bool }）
输出: {
  overall: "ready" | "setup_required" | "unsupported" | "blocked",
  checks: [ { id: "platform"|"python"|"engine"|"weights"|"text_encoder"|"disk"|"memory",
              state: "ok"|"missing"|"mismatch"|"too_low"|"refused",
              detail, fix_hint } ],
  config: { model_dir, engine_dir, venv_dir, mirror }   // 解析后的实际值
}
```

### 3.2 `h3_setup`（状态机，action 参数）
```
输入: { action: "check"|"venv"|"engine"|"license"|"weights"|"convert"|"smoke"|"status"|"reset",
        mirror?: "hf"|"hf-mirror",        // 默认 hf
        accepted?: true }                  // 仅 license 动作接受，落盘记录时间戳
输出: 短任务 → 即时结果；长任务（weights/convert/smoke）→ { job_id, next: "poll" }
      轮询返回 { state: running|done|failed, progress: {shard_done, shard_total, bytes_done}, log_tail }
纪律: 每步可重入；weights 复用引擎断点续传；failed 必带归因分类（网络/磁盘/许可/内存/校验失败）
```

### 3.3 `h3_image`（生图）
```
输入: { prompt, aspect?: "1:1"|"16:9"|"9:16"|"4:3"|"3:4", mp?: 1..16 (默认 4),
        seed?: int, width/height?: int (高级，32 对齐),
        output_dir?: 工作区内路径 (默认 generated-images/),
        timeout_seconds?: 内部 deadline (默认 240，上限 900) }
拒绝: reference_images / images / edit 类参数 → 显式报错"当前引擎能力面为纯文生图"（D7）
输出: 图块（attachments）+ { provider: "h3-local", size, seconds, seed, peak_gb, saved }
并发: 闸门=1；忙时返回 { state: "busy", queue_hint }，不排队挂死
```

## 4. 能力面边界（对外表述必须一致）

| 能力 | v1 | 依据 |
|---|---|---|
| 文生图（最高 16MP） | ✅ | 引擎 `generate_h3_image.py` 实测 |
| 参考图 / 图像编辑 | ❌ 显式拒绝 | 官方模型宣称具备，但 MLX 引擎入口未接（引擎能力不外推原则）；上游开放后走维护流程 M+ |
| 生视频 | ❌ 非本插件范围 | H3 视频是另一条已定案通道，不混装 |
| 批量/队列 | ❌ v1 单发 | 闸门=1；批量的排队语义留 v2 与用户反馈再定 |

## 5. 非目标（写进 README 防误解）

- 不做云端代理、不接任何 API 生图；本插件与 dsh-image-gen 是并列关系不是替代关系。
- 不捆绑权重/引擎源码分发；不代注册任何账号；不代点许可。
- 不做 Windows/Linux（引擎物理边界，见 DISCLAIMER）。
