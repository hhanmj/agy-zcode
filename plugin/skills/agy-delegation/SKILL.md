---
name: agy-delegation
description: 把真实的编码任务（尤其是 UI/UX 实现和改版）委派给 Google Antigravity CLI（agy），复用同一 agy 会话返工，并由 ZCode 主模型独立验收改动。用户要求让 agy/Antigravity/Gemini 实际改代码时使用；纯建议或问答不用。
when_to_use: 用户说“用 agy / Antigravity 做……”、要把一个独立的实现任务交给另一个智能体并行完成、或需要对 agy 之前的任务继续返工时。
---

# agy 委派与验收（ZCode）

本技能配合 agy-delegate 插件的 MCP 工具使用。ZCode 会给工具名加命名空间前缀（例如 mcp__…__agy_run），下面只写工具名的后半段。

## 职责与边界

- ZCode 主模型负责澄清目标、拆分任务、独立验收和决定返工；agy 负责在工作区里实际写代码。
- 只在用户要求实际改代码时委派。纯建议、问答不要擅自运行 agy。
- agy 的“已完成”、截图、自述的测试结果都不算验收。
- 权限限于用户授权的工程目录。默认 cwd 是当前 ZCode 工作区；目标在工作区外时才传绝对路径的 dirs。不要让 agy 读写其他项目、密钥或全局配置。
- 插件默认开启 --dangerously-skip-permissions，agy 改文件、跑命令不会再询问。尤其要避免破坏性操作、全盘扫描、安装来路不明的依赖、自动部署和无关改动；需要额外授权时先问用户。

## 选择会话

- 同一项目、同一功能、同一条修改/返工链：用 agy_followup { task, prompt }。task 用工具返回的任务键，不要自己拼；忘了就用 agy_tasks 查。
- 新功能、换工程、或旧会话已经混乱：用 agy_run { description, prompt, cwd?, background? } 新开任务。

## 派发任务

1. 先自己看一遍工程：入口、真实数据流、API、路由、事件、加载/错误/空状态和现有测试，并记下任务前就存在的未提交改动。
2. 给 agy 的 prompt 必须独立完整：目标、允许改的文件/模块、必须保留的功能、禁止的做法、验收命令、回报格式。禁止用 Mock 代替真实接口，禁止空事件处理、假按钮、擅改数据契约或只做表面布局。
3. 预计几分钟内完成的用前台（默认）。更长的任务用 background: true，然后循环调用 agy_status { task, wait_seconds: 60, offset }，把返回的 next_offset 作为下一次的 offset，并简短告诉用户 agy 正在做什么。agy_status 报告最终状态之前，不要说任务已完成。需要停止时用 agy_cancel。
4. 要求 agy 列出具体改动、文件路径、执行过的命令及结果、未完成事项。这些只是线索，不是证明。

## 独立验收（必须）

1. 任务结束后看返回里的 evidence 行，或调用 agy_evidence { task }。只有 execution_status 为 completed 才继续验收；review_status: pending 是正常值，不代表通过。
2. 自己看实际的 git diff 和 git status，区分任务前已有的改动。evidence_complete 为 false 时，不要下“其他文件都没改”的结论。git 行数是累计值，不等于本次改动量。
3. 运行适用的类型检查、构建、单元测试，并检查关键 UI 交互。没法自动测试的交互要明确告诉用户还需人工检查。
4. 需要知道 agy 具体做了什么时，用 agy_trace { id: task } 看它的步骤和工具调用记录。
5. 不通过就用同一个 task 调 agy_followup，说明哪里失败、要怎么改；每次返工后重新取证、重新验证。

## 登录与故障

- 报 authentication required：插件会自动在本机弹出登录窗口（最小化在任务栏）。请用户完成 Google 登录后重试；没弹出就调用 agy_login。
- 报 User location is not supported：需要代理，在插件配置里填 proxy，或写入 ~/.dsh/agy-proxy.txt。
- 前台超时：改用 background: true。

## 汇报

简洁说明：项目路径、agy 任务键、执行状态、实际改动、你自己跑的验证命令及结果、遗留风险、是否需要返工。明确区分“agy 声称的”和“已核实的”。
