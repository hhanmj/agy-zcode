# agy-delegate（ZCode 插件）

在 ZCode 里把编程任务交给本机的 **Google Antigravity CLI（agy）** 去做。agy 是一个独立的 Gemini 编程智能体，用你自己的 Antigravity 登录态认证，不需要 API key。

本插件由 DSH 插件 dsh-subagent-agy 移植而来：核心逻辑（stream-json 解析、改动证据、执行轨迹、模型解析）与 DSH 版共用同一份源码，外层从 DSH 插件接口换成了 MCP 服务。

## 前置条件

- 已安装并登录 agy：在终端运行一次 agy 完成登录。插件会依次在 PATH、%LOCALAPPDATA%\agy\bin、~/.local/bin 里找 agy.exe。
- ZCode 能找到 node（Node.js 20 及以上）。插件的 MCP 服务用 node 启动。
- 所在地区访问不了 Antigravity 时需要代理：在插件配置里填 proxy，或者把代理地址写进 ~/.dsh/agy-proxy.txt（和 DSH 版共用）。

## 安装

图形界面：设置 → 插件 → 右上角「创建」→「添加插件市场」→ 选择构建出的 dist/market 目录 → 在「个人」分段里找到 agy-delegate → 安装。

命令行：

    zcode plugins marketplace add <仓库>/zcode/dist/market
    zcode plugins install agy-delegate@agy-local --scope user

装好后插件默认启用，会带来一个 MCP 服务（agy）、一个技能（agy-delegation）和一个原生子代理（agy，需要先注册模型 Provider，见下）。

## 升级与版本核对

版本号只有一个来源：plugin/.zcode-plugin/plugin.json。plugin/marketplace.json 和 zcode/package.json 必须与它一致，否则 npm run build 直接报错；构建会把同一个版本号写进 agy-mcp.mjs（MCP serverInfo）和 agy-gateway.mjs（/health）。

ZCode 实际运行的是 ~/.zcode/cli/plugins/cache/agy-local/agy-delegate/<版本>/ 下的副本，而不是 dist/market。重新构建后 ZCode 不会自动感知：它比对的是自己保存的市场快照（~/.zcode/cli/plugins/marketplaces/agy-local），这份快照只有执行 marketplace update 才会刷新。所以只升版本号再 `zcode plugins update` 会提示“已是最新”。

    npm run install:status      # 只读：源码 / dist / ZCode 市场快照 / 已安装缓存 / 正在运行的网关，各自的版本
    npm run install:local       # 演练：列出将执行的命令，不改任何东西
    node scripts/local-install.mjs install --apply

--apply 会先把 agy-delegate 的注册表条目、agy-local 市场条目和市场快照备份到 zcode/.install-backups/<时间戳>/，再执行 `zcode plugins marketplace update agy-local` 和 `zcode plugins update agy-delegate@agy-local`。ZCode 会把新版本装进新的 cache/<版本>/ 目录，旧目录保留。回滚：

    node scripts/local-install.mjs rollback zcode/.install-backups/<时间戳> --apply

回滚只恢复这几个条目（其他插件的注册信息不动），也不删除任何 cache/<版本>/ 目录。

安全护栏：如果已安装副本里的 agy-mcp.mjs 版本号与其 plugin.json 不一致（INSTALL_HOTPATCHED，说明有人直接改过缓存），脚本拒绝升级。先把那些改动移植回 zcode/src、重新构建，再加 --allow-hotpatch-replace。

升级后要重启 ZCode 会话，MCP 服务才会换成新版本。模型网关启动时会校验 /health 的版本和数据目录；发现不匹配时不会抢占或结束现有进程，待已有请求结束后手动停止旧网关，下一个会话再拉起新版本。

## 工具

| 工具 | 作用 |
|---|---|
| agy_run | 新建任务。默认前台等待结果；background: true 时立即返回任务键 |
| agy_followup | 用任务键在同一 agy 会话里继续（保留上下文、工作目录和模型） |
| agy_status | 查看任务状态和实时进度；wait_seconds 最多阻塞 300 秒；用 next_offset 增量读取 |
| agy_tasks | 列出运行中、本次会话已结束、以及已记录（可续聊）的任务 |
| agy_cancel | 停止运行中的任务（结束整个 agy 进程树） |
| agy_evidence | 本地独立采集的改动证据（任务前后的工作区快照对比），review 永远是 pending |
| agy_trace | agy 自己的执行记录：步骤、内部工具调用、结果、超时/取消 |
| agy_models | 列出 agy models 报告的模型和 effort |
| agy_login | 在本机弹出 agy 登录窗口 |
| agy_accounts | 账号库与额度轮替：capture / list / switch / remove / config（见下） |

ZCode 会给工具名加命名空间前缀，模型实际看到的名字可能形如 mcp__…__agy_run。

## 任务面板（MCP App）

插件声明了一个会话面板 **agy tasks & accounts**（`ui://agy-delegate/panel.html`），在 ZCode 里手动打开；agy_tasks 的工具结果也带这个资源链接。UI 用官方 @modelcontextprotocol/ext-apps 打包成单个离线 HTML 资源，无外部字体/脚本。

- **Tasks**：运行中 / 本会话已结束 / 已记录任务；点选后看实时输出、最终答复、改动证据和轨迹摘要；可以直接取消、续聊、新建后台任务。
- **Accounts**：当前 agy 登录、账号库、轮替开关和顺序；两步添加账号（打开登录窗口 → Capture current login）。
- 面板专用工具（agy_panel_data / agy_panel_task / agy_panel_action / agy_panel_account）标了 `visibility: ["app"]`，模型看不到。
- 状态推送走 `resources/subscribe`（zcode/resourceSubscribe）；不支持时退化为运行中任务每 5 秒轮询。标签页和选中任务存在会话 widget state 里。

## 账号库与额度轮替

agy 本身只保存一个登录（~/.gemini/oauth_creds.json + google_accounts.json），/logout 会丢弃旧凭证。账号库把每次登录各存一份快照（插件数据目录 accounts/profiles/），从而保留多个账号。

1. 面板 Accounts 或 agy_login 打开登录窗口，完成登录。
2. `agy_accounts { action: "capture" }` 把当前登录存进账号库（同邮箱会刷新令牌，旧账号不受影响）。重复以上两步添加更多账号。
3. `agy_accounts { action: "config", enabled: true, strategy: "priority" | "round-robin" }` 开启轮替（默认关闭）。

行为与限制：

- 某个 run 因额度失败（429 / RESOURCE_EXHAUSTED / quota / rate limit）时，当前账号被标记为耗尽并跳过一个额度窗口（默认 5 小时），随后切到下一个可用账号，并在 run 的错误文本里说明。
- 每次 run 开始前，若当前账号仍在耗尽窗口内，也会自动换号。两次切换之间至少有 120 秒冷却，避免抖动。
- **正在运行的 agy 进程不会被迁移**：轮替只决定下一个进程用哪个账号。额度失败的会话需要用 agy_followup 在新账号上继续。这与 Antigravity-Manager / agy-switch 文档的限制一致（本实现参考了它们的账号存储与切换策略，未复用其 Rust 代码）。
- 切换有 journal 和跨进程文件锁；发现中断的切换时面板会提示先核对当前登录。
- 令牌只写入本机文件，工具输出和日志只有邮箱和路径。


## 配置（设置 → 插件 → agy-delegate → 高级信息 → 配置）

| 配置项 | 默认 | 说明 |
|---|---|---|
| agyPath | 空 | agy 的命令名或绝对路径；空表示自动查找 |
| proxy | 空 | 给 agy 用的代理；空则依次用 AGY_PROXY 环境变量、插件数据目录的 agy-proxy.txt、~/.dsh/agy-proxy.txt |
| model / effort | 空 | 默认模型和 effort；空表示用 agy 自己的默认值 |
| printTimeoutMs | 300000 | 前台任务上限，最大 780000（一次 MCP 调用的超时是 15 分钟） |
| backgroundTimeoutMs | 3600000 | 后台任务上限 |
| skipPermissions | true | 传 --dangerously-skip-permissions；无头 agy 无法弹确认，改文件和跑命令需要它 |
| avoidBrowser | true | 提示 agy 不要用无头浏览器工具（会卡死） |
| addDirs | 空 | 每次运行都加入的额外目录（--add-dir），分号分隔 |
| gatewayAutostart | true | 保持本地模型网关常驻（见下节） |
| gatewayPort | 8378 | 模型网关端口；改了要同步改 Provider 的 baseUrl |
| supervision | false | 可选：每次运行给 agy 装一个命令钩子（server/supervisor-hook.mjs），拦截工作区和 addDirs 之外的写入、凭据/agy 状态路径的读取和被禁命令；钩子出错一律拒绝。是防误操作的护栏，不是安全边界 |
| supervisionBuiltinRules | true | 开启监督时，额外拒绝 git push、git reset --hard / git clean -f、发布包或 release、把下载内容直接管道给 shell |
| supervisionDenyCommands | 空 | 开启监督时额外禁止的命令正则（不区分大小写），分号分隔 |
| supervisionStopCheck | 空 | 开启监督时，agy 想结束前在工作区跑的检查命令（如 npm test）；失败就让 agy 回去修 |
| supervisionStopCheckTimeoutMs / supervisionMaxReworks | 120000 / 2 | 检查命令的超时；失败最多打回几次 |
| persistentSessions | false | 可选：同一任务的续聊复用一个常驻的流式 agy 进程，而不是每轮新起进程；一次性运行仍是兜底 |
| persistentIdleMs | 600000 | 常驻进程空闲多久后关闭（0 表示不关） |

监督和常驻会话默认关闭；skipPermissions 默认保持开启（无头 agy 没有它就不能改文件、跑命令）。监督钩子在 skipPermissions 开启时仍然生效。

工作目录：调用时传了 cwd 就用 cwd；否则用 ZCode 当前会话的工作区。

## 原生子代理（模型网关）

插件会在本机 127.0.0.1:8378 维持一个 **Anthropic Messages 兼容的模型网关**（MCP 服务启动时自动拉起，独立于会话常驻）。把它注册为 ZCode 自定义模型 Provider 后，agy 的模型会出现在 /model 选择器里，也可以用原生子代理直接派活，不再经过 MCP 工具调用：

1. 设置 → 模型管理 → 添加 Provider：类型 anthropic-messages，baseUrl `http://127.0.0.1:8378`，apiKey 填插件数据目录下 gateway-token.txt 的内容（一行随机十六进制）。
2. 模型填 agy models 里的 id（如 `gemini-3.8-flash`；上下文窗口按模型卡填，例如 1000000）。
3. 插件自带的 `agy` 原生子代理默认使用 `agy/gemini-3.8-flash`。

注意事项（与 DSH 原生桥接相同的取舍）：

- agy 是完整智能体而不是裸模型：网关会丢弃 ZCode 的系统提示词和工具声明，也永不返回 tool_use；agy 用自己的工具在网关工作目录里干活，只有真实文本增量会流回来（工具进度走 SSE 注释，不进对话历史）。
- 网关从请求的 system 环境块中提取有效的 `Working directory:` 并以它作为 agy 工作目录；路径无效或未提供时退回启动网关时的工作目录（/health 可查）。工作目录与模型不匹配时不会复用旧会话。
- 多轮对话按「历史哈希 → agy 会话」恢复；历史分叉或无法续接时自动降级为整段转录重发。
- MCP 工具和模型网关都支持可选的 evidence/trace/supervision、取消与常驻会话；MCP 工具另外提供后台任务及状态查询，重活继续用 agy_run / agy_followup。

## 数据位置

任务记录、改动证据和执行轨迹都放在插件数据目录（~/.zcode/cli/plugins/data/agy-delegate@agy-local/）：tasks.json、evidence/、traces/。不会写进你的项目仓库。

## 和 DSH 版的差别

- 原生子代理走「自定义模型 Provider + 本地网关」实现（见上节），不是 DSH 的插件内 LLM 适配器；协议有损（ZCode 工具/系统提示词到不了 agy），重任务仍建议走 MCP 工具。
- 后台任务没有 DSH 的 job_output / job_kill，改用 agy_status 轮询、agy_cancel 停止。
- 后台任务的进程归 MCP 服务所有：ZCode 关闭这个 MCP 服务（例如关掉工作区或退出应用）时，正在运行的 agy 会被一起结束；已有的会话仍然可以用 agy_followup 续上。
- 监督（supervision）和常驻 agy 进程是可选项，默认关闭（见配置表）；未移植：共享 DSH 技能给 agy。

## 开发

源码在仓库的 zcode/ 目录：

    cd zcode
    npm install
    npm run typecheck
    npm test          # 构建 + 用假 agy 跑端到端测试，另含打包契约（配置项 ↔ .mcp.json、默认值、监督钩子）和安装脚本（演练 / 拒绝 / 回滚）测试
    npm run install:status   # 核对已安装版本是否与源码一致
