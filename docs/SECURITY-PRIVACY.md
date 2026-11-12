# SECURITY & PRIVACY — dsh-h3-image

## 1. 隐私设计（这是产品卖点，必须写进 README）

| 面 | 承诺 | 实现 |
|---|---|---|
| 运行期出网 | **零** | 推理全本地；代码内除 setup 下载外零网络调用；CI 加"运行路径零 URL 常量"扫描（setup 模块白名单除外） |
| setup 出网 | 仅 `huggingface.co` / `hf-mirror.com` / `github.com`（引擎 clone）/ `pypi.org`（pip） | 域名白名单写进文档；镜像由用户显式选择 |
| 提示词 | 永不出本机 | 无云端调用即无泄露面；metrics JSON 含 prompt 原文，落插件 storage——在文档中如实披露 |
| 生成图 | 只写用户指定目录（默认工作区 `generated-images/`） | `output_dir` 解析后强制工作区内校验，越界拒绝 |
| 凭据 | **零凭据面** | 无 API key、无登录、无 token（权重公开仓匿名可下；若上游改 gated，报结构化红项而非索要凭据） |
| 遥测 | 零 | 插件自身零上报；DSH 产品遥测与插件无关，不代声明 |

## 2. 执行安全（子进程是最大攻击面）

1. **禁 shell 字符串拼接**：一律 `execFile`/`spawn` + argv 数组传 prompt 与路径（开发机上的 shell 内联脚本写法**不得**进插件——prompt 含引号反引号即注入）。
2. **解释器钉死**：只 spawn `venv_dir/bin/python`（venv 由向导创建）；不读 PATH 找 python 执行。
3. **引擎代码完整性**：clone 后 `git checkout <pinned commit>` 并校验 `git rev-parse HEAD` 一致；引擎脚本执行前核对已知文件的 sha256（防仓库被强推后静默换码）。
4. **权重完整性**：逐件 sha256 对 pinned manifest（引擎 fetch 自带 + 插件侧复核双保险）；镜像下载同样必须过哈希——镜像只影响速度，不影响信任。
5. **pip 供应链**：requirements 钉版本；文档披露 pip/PyPI 信任边界；（v2 评估 `--require-hashes`）。
6. **写域最小化**：插件只写 模型目录/引擎目录/venv/插件 storage/工作区输出目录；沙箱拒绝=上报，不绕行（AGENTS.md 红线）。
7. **进程卫生**：job 表落盘 pid；激活时孤儿认领或回收（kill+标记 failed）；禁 kill 非本插件进程。

## 3. 发布脱敏门禁（对外发布硬门禁，借 dsh-image-gen 事故教训自建）

**"源码干净"与"包干净"是两个命题，都扫。** 门禁脚本 `scripts/check-release-safety.mjs`（开发期，不进 files）：

- 源码树扫描：本机绝对路径（`/Users/<name>`）、真实用户名、内网 IP/网段、密钥特征（`sk-`、`ghp_`、PEM 头）、三家云端域名（本插件不该有任何云端调用）、内部项目名（phosphene 等仅作"复用探测候选"出现时须去路径化）。
- **tarball 扫描**（历史事故三条全覆盖）：tar 头 `uname/gname/uid`（须 `--uid=0 --gid=0 --uname= --gname=` 归零）、AppleDouble `._*` 条目（`COPYFILE_DISABLE=1`）、解包文件清单与 `files` 字段一致、文档内零内部工作区引用。
- 错误文案审计：所有用户可见 message/fix_hint 零绝对路径零用户名（用 `~`/占位符）。
- 结果非零 = 禁止发布，无"人工提醒"豁免。

## 4. SECURITY.md（对外）

- 漏洞报告渠道：GitHub Security Advisory（private reporting）。
- 支持版本策略：仅最新 minor 线。
- 明确非威胁模型：本机已有恶意软件、多用户共享机器场景不在防护范围。

## 5. 生成内容安全（与许可 AUP 对齐）

- 插件不内置内容过滤（引擎无此能力，不假称）；DETAIL/README 显著提示用户自持内容责任 + 许可 Exhibit A（AUP）适用。
- 铭牌如实：provider 标 `h3-local`，不冒充任何云端服务；不实现任何"去除 AI 标识"功能（许可 III.3.b 鼓励加 AI 生成标识，插件顺从：铭牌与 metrics 含生成来源）。
