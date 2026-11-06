/**
 * agy-delegate session panel (MCP App). One App per page; handlers are
 * registered before connect. Server state is the source of truth — the panel
 * only keeps presentation state (tab, selection) in the host's widget state.
 */
import { App } from '@modelcontextprotocol/ext-apps'
import { EmptyResultSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'

interface RunView {
  task: string
  runId: string
  label: string
  cwd: string
  status: string
  background: boolean
  startedAt: number
  finishedAt?: number
  lastActivity: string
  toolCalls: number
  toolErrors: number
  model?: string
  conversationId?: string
  error?: string
  response?: string
  evidence?: { complete: boolean; diff: { changed_files_total: number; added_lines: number | null; deleted_lines: number | null }; warnings: string[] }
}

interface Account {
  id: string
  email: string
  label: string
  disabled: boolean
  priority: number
  exhaustedUntil?: number
  lastError?: string
}

interface PanelData {
  version: string
  workspace: string
  runs: RunView[]
  recorded: { task: string; label: string; cwd: string; createdAt: number; model?: string }[]
  accounts: {
    accounts: Account[]
    activeId?: string
    currentEmail?: string
    rotation: { enabled: boolean; strategy: string; cooldownMs: number; exhaustedMs: number }
    geminiDir: string
  }
  pendingSwitch?: { targetId: string; reason: string; startedAt: number }
  defaults: { model: string; effort: string }
}

interface ViewState {
  tab?: string
  selected?: string
}

const app = new App({ name: 'agy-delegate-panel', version: '0.3.2' }, {})
let data: PanelData | undefined
let detail: Record<string, unknown> | undefined
let view: ViewState = {}
let busy = false
let notice = ''
let noticeKind: 'error' | 'info' = 'error'

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement

const ICONS = {
  tasks: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.9 12.1 8.6-8.6M18 5l3 3M15 8l2 2"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  trace: '<path d="M4 17l6-6-6-6M12 19h8"/>',
}

function icon(name: keyof typeof ICONS, cls = 'icon'): string {
  return '<svg class="' + cls + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>'
}

interface CallResult {
  text: string
  isError: boolean
}

async function callRaw(tool: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const result = await app.callServerTool({ name: tool, arguments: args })
  const text = (result.content ?? []).filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text).join('\n')
  return { text, isError: result.isError === true }
}

async function call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await callRaw(tool, args)
  if (result.isError) throw new Error(result.text || tool + ' 调用失败')
  return JSON.parse(result.text || '{}') as T
}

async function refresh(): Promise<void> {
  try {
    data = await call<PanelData>('agy_panel_data')
    if (view.selected !== undefined) {
      detail = await call<Record<string, unknown>>('agy_panel_task', { task: view.selected })
    }
    // Only clear a previous ERROR on a successful load; an action's success
    // notice (e.g. "captured login") must survive the refresh that follows it.
    if (noticeKind === 'error') notice = ''
  } catch (error) {
    noticeKind = 'error'
    notice = error instanceof Error ? error.message : String(error)
  }
  render()
}

async function action(tool: string, args: Record<string, unknown>): Promise<void> {
  if (busy) return
  busy = true
  notice = ''
  render()
  try {
    const result = await callRaw(tool, args)
    if (result.isError) throw new Error(result.text)
    // Account tools answer in prose (not JSON): show the outcome to the user.
    if (result.text.trim().length > 0) {
      notice = result.text
      noticeKind = 'info'
    }
    await refresh()
  } catch (error) {
    noticeKind = 'error'
    notice = error instanceof Error ? error.message : String(error)
  } finally {
    busy = false
    render()
  }
}

async function saveView(): Promise<void> {
  if (app.getHostCapabilities()?.experimental?.['zcode/widgetState']) {
    await app.request({ method: 'ui/set-widget-state', params: { widgetState: view } }, EmptyResultSchema).catch(() => {})
  }
}

// Handlers before connect so nothing is lost while the bundle loads.
app.ontoolresult = () => void refresh()
app.onhostcontextchanged = () => render()
// Resource update notification (zcode/resourceSubscribe) pushes state changes.
app.setNotificationHandler('notifications/resources/updated', { params: ResourceUpdatedNotificationSchema.shape.params }, () => void refresh())

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function time(ms?: number): string {
  return ms === undefined ? '' : new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const STATUS_TEXT: Record<string, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  timeout: '超时',
  recorded: '可续聊',
}

function statusBadge(status: string): string {
  return '<span class="badge ' + esc(status) + '"><span class="dot"></span>' + esc(STATUS_TEXT[status] ?? status) + '</span>'
}

function renderStats(): string {
  if (data === undefined) return ''
  const running = data.runs.filter((r) => r.status === 'running').length
  const done = data.runs.filter((r) => r.status === 'completed').length
  const failed = data.runs.filter((r) => ['failed', 'timeout'].includes(r.status)).length
  const stat = (num: number, cap: string, cls: string): string =>
    '<div class="card stat"><span class="num ' + cls + '">' + num + '</span><span class="cap">' + cap + '</span></div>'
  return '<div class="stats">' + stat(running, '运行中', 'running') + stat(done, '已完成', 'done') + stat(failed, '失败 / 超时', 'fail') + '</div>'
}

function renderTasks(): string {
  if (data === undefined) return '<div class="empty">' + icon('clock', 'icon-lg') + '加载中…</div>'
  const running = data.runs.filter((r) => r.status === 'running')
  const finished = data.runs.filter((r) => r.status !== 'running')
  const recorded = data.recorded.filter((r) => !data!.runs.some((run) => run.task === r.task))
  const row = (r: RunView | { task: string; label: string; cwd: string; createdAt?: number; startedAt?: number; status?: string; lastActivity?: string }): string => {
    const status = 'status' in r && r.status !== undefined ? r.status : 'recorded'
    const at = 'startedAt' in r ? r.startedAt : (r as { createdAt?: number }).createdAt
    const activity = 'lastActivity' in r && status === 'running' && r.lastActivity !== undefined ? r.lastActivity : undefined
    return '<div class="row' + (view.selected === r.task ? ' selected' : '') + '" data-task="' + esc(r.task) + '">' +
      '<div class="body"><div class="title">' + esc(r.label) + '</div>' +
      '<div class="meta">' + time(at) + '<span class="sep">·</span><span class="mono">' + esc(r.task) + '</span></div>' +
      (activity !== undefined ? '<div class="meta">' + esc(activity.slice(0, 60)) + '</div>' : '') +
      '</div>' + statusBadge(status) + '</div>'
  }
  let html = ''
  if (running.length > 0) html += '<div class="section-title">' + icon('clock') + '运行中（' + running.length + '）</div>' + running.map(row).join('')
  if (finished.length > 0) html += '<div class="section-title">' + icon('tasks') + '本次会话</div>' + finished.map(row).join('')
  if (recorded.length > 0) html += '<div class="section-title">' + icon('file') + '历史任务（可续聊）</div>' + recorded.map(row).join('')
  if (html === '') html = '<div class="card empty">' + icon('tasks', 'icon-lg') + '还没有任务<br><span class="small">在下方新建，或让 Agent 调用 agy_run</span></div>'
  return html
}

function renderDetail(): string {
  if (view.selected === undefined) {
    return '<div class="card empty">' + icon('file', 'icon-lg') + '选择左侧任务<br><span class="small">查看实时输出、改动证据与执行轨迹</span></div>'
  }
  const d = detail
  if (d === undefined) return '<div class="card empty">' + icon('clock', 'icon-lg') + '加载中…</div>'
  const run = d.run as RunView | undefined
  const recorded = d.recorded as { label?: string; cwd?: string; model?: string } | undefined
  let html = '<div class="card card-pad">'
  html += '<div class="detail-head"><strong>' + esc(run?.label ?? recorded?.label ?? view.selected) + '</strong>' +
    (run !== undefined ? statusBadge(run.status) : statusBadge('recorded')) + '</div>'
  html += '<div class="kv"><span class="mono">' + esc(view.selected) + '</span>' +
    (run?.model !== undefined ? '<span>' + esc(run.model) + '</span>' : '') +
    (run !== undefined ? '<span>' + time(run.startedAt) + '</span>' : '') +
    (run !== undefined && run.status === 'running' ? '<span>工具调用 ' + run.toolCalls + ' 次' + (run.toolErrors > 0 ? '（' + run.toolErrors + ' 失败）' : '') + '</span>' : '') + '</div>'
  if (run?.error !== undefined) html += '<pre class="err-text">' + esc(run.error) + '</pre>'
  const progress = d.progress as { text?: string; next?: number } | undefined
  if (progress?.text !== undefined && progress.text.length > 0) html += '<div class="section-title">' + icon('trace') + '实时输出</div><pre class="log">' + esc(progress.text.slice(-6000)) + '</pre>'
  if (run?.response !== undefined) html += '<div class="section-title">' + icon('send') + '最终答复</div><pre class="log">' + esc(run.response.slice(-8000)) + '</pre>'
  const evidence = d.evidence as { diff_summary?: { changed_files_total?: number; added_lines?: number | null; deleted_lines?: number | null }; changed_files?: { path: string; status: string }[]; warnings?: string[] } | undefined
  if (evidence !== undefined) {
    const diff = evidence.diff_summary ?? {}
    html += '<div class="section-title">' + icon('shield') + '改动证据<span class="tiny">（需自行复核）</span>' +
      (diff.added_lines !== null && diff.added_lines !== undefined ? '<span class="diff-nums"><span class="add">+' + diff.added_lines + '</span><span class="del">−' + (diff.deleted_lines ?? 0) + '</span></span>' : '') + '</div>'
    if (evidence.changed_files !== undefined && evidence.changed_files.length > 0) {
      html += evidence.changed_files.slice(0, 40).map((f) =>
        '<div class="file-line"><span class="file-status ' + esc(f.status) + '">' + esc(f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M') + '</span><span class="mono small">' + esc(f.path) + '</span></div>').join('')
    } else {
      html += '<div class="muted small">共 ' + (diff.changed_files_total ?? 0) + ' 个文件变动</div>'
    }
  }
  const trace = d.trace as { summary?: Record<string, unknown>; records?: { seq: number; kind: string }[] } | undefined
  if (trace?.summary !== undefined) {
    const summary = trace.summary as { runs?: number; tools_used?: Record<string, { calls: number; errors: number }> }
    html += '<div class="section-title">' + icon('trace') + '执行轨迹</div><div class="muted small">'
    const used = Object.entries(summary.tools_used ?? {})
    html += used.length > 0 ? esc(used.map(([name, count]) => name + ' ×' + count.calls).join('，')) : '暂无工具记录'
    html += ' · 最近 ' + (trace.records?.length ?? 0) + ' 条记录</div>'
  }
  html += '<div class="actions">'
  if (run?.status === 'running') html += '<button data-act="cancel" class="danger">' + icon('stop') + '停止任务</button>'
  html += '<button data-act="followup-open" class="primary">' + icon('send') + '续聊</button></div>'
  html += '<div id="followup-box" class="hidden"><label class="field-label" for="followup-prompt">续聊内容</label>' +
    '<textarea id="followup-prompt" rows="3" placeholder="agy 记得之前的上下文，只需说明要修改或继续什么。"></textarea>' +
    '<div class="actions"><button class="primary" data-act="followup-send">' + icon('send') + '发送（后台运行）</button></div></div>'
  return html + '</div>'
}

function renderAccounts(): string {
  if (data === undefined) return '<div class="empty">' + icon('clock', 'icon-lg') + '加载中…</div>'
  const { accounts, activeId, currentEmail, rotation } = data.accounts
  let html = ''
  if (data.pendingSwitch !== undefined) {
    html += '<div class="notice error">' + icon('alert') + '<div>检测到一次中断的账号切换（目标 ' + esc(data.pendingSwitch.targetId) + '）。请先核对当前登录账号，再开启轮替。</div></div>'
  }
  html += '<div class="card live-card"><div class="avatar">' + esc((currentEmail ?? '?').charAt(0)) + '</div>' +
    '<div class="who"><div class="email">' + esc(currentEmail ?? '未知') + '</div><div class="cap">agy 当前登录账号</div></div>' +
    '<span class="badge ' + (accounts.length > 1 ? 'active' : '') + '">库中 ' + accounts.length + ' 个账号</span></div>'

  html += '<div class="card rotation-bar"><label class="switch"><input type="checkbox" id="rotation-enabled" ' + (rotation.enabled ? 'checked' : '') + '><span class="slider"></span></label>' +
    '<span class="label">额度用尽时自动轮替</span>' +
    '<span class="spacer"></span>' +
    '<label class="muted small">顺序 <select id="rotation-strategy"><option value="priority"' + (rotation.strategy === 'priority' ? ' selected' : '') + '>按优先级</option>' +
    '<option value="round-robin"' + (rotation.strategy === 'round-robin' ? ' selected' : '') + '>轮流使用</option></select></label>' +
    '<span class="hint">轮替只决定「下一个」任务用哪个账号，正在运行的 agy 进程不会被迁移；额度失败后用「续聊」在新账号上继续。</span></div>'

  html += '<div class="section-title">' + icon('user') + '账号库</div><div class="card">'
  for (const a of accounts) {
    const exhausted = a.exhaustedUntil !== undefined && a.exhaustedUntil > Date.now()
    html += '<div class="acct"><div class="avatar">' + esc(a.email.charAt(0)) + '</div>' +
      '<div class="who"><div class="email">' + esc(a.email) +
      (a.id === activeId ? '<span class="badge active">' + icon('check') + '使用中</span>' : '') +
      (a.disabled ? '<span class="badge">已停用</span>' : '') +
      (exhausted ? '<span class="badge exhausted">' + icon('clock') + '额度恢复于 ' + time(a.exhaustedUntil) + '</span>' : '') + '</div>' +
      '<div class="sub mono">' + esc(a.id) + (a.label ? ' · ' + esc(a.label) : '') + '</div></div>' +
      '<div class="acct-actions"><button data-act="switch" data-id="' + esc(a.id) + '" title="切换到此账号">使用</button>' +
      '<button data-act="toggle" data-id="' + esc(a.id) + '">' + (a.disabled ? '启用' : '停用') + '</button>' +
      '<button class="icon-btn danger" data-act="remove" data-id="' + esc(a.id) + '" title="从库中移除">' + icon('trash') + '</button></div></div>'
  }
  if (accounts.length === 0) html += '<div class="empty">' + icon('user', 'icon-lg') + '账号库还是空的，先在下方添加</div>'
  html += '</div>'

  html += '<div class="section-title">' + icon('plus') + '添加账号</div><div class="card card-pad">' +
    '<div class="steps">' +
    '<div class="step"><span class="n">1</span><span>点击「打开登录窗口」，用要添加的账号完成登录。</span></div>' +
    '<div class="step"><span class="n">2</span><span>登录完成后点击「保存当前登录」。之前的账号会保留在库中，不会被覆盖。</span></div></div>' +
    '<div class="actions"><button data-act="login">' + icon('key') + '1. 打开登录窗口</button>' +
    '<button class="primary" data-act="capture">' + icon('check') + '2. 保存当前登录</button></div>' +
    '<div class="footnote">' + icon('shield') + '<span>凭证只保存在本机（' + esc(data.accounts.geminiDir) + ' 与插件数据目录），界面与日志都不会显示令牌内容。</span></div></div>'
  return html
}

function render(): void {
  document.documentElement.dataset.theme = app.getHostContext()?.theme ?? 'dark'
  const tab = view.tab ?? 'tasks'
  $('notice').className = notice.length > 0 ? 'notice ' + noticeKind : 'hidden'
  $('notice').innerHTML = notice.length > 0 ? icon(noticeKind === 'error' ? 'alert' : 'info') + '<div>' + esc(notice) + '</div>' : ''
  $('tab-tasks').classList.toggle('on', tab === 'tasks')
  $('tab-accounts').classList.toggle('on', tab === 'accounts')
  $('pane-tasks').classList.toggle('hidden', tab !== 'tasks')
  $('pane-accounts').classList.toggle('hidden', tab !== 'accounts')
  $('task-stats').innerHTML = renderStats()
  $('task-list').innerHTML = renderTasks()
  $('task-detail').innerHTML = renderDetail()
  $('accounts').innerHTML = renderAccounts()
  $('version').textContent = data === undefined ? '' : 'v' + data.version
  for (const button of document.querySelectorAll('button[data-act]')) (button as HTMLButtonElement).disabled = busy
}

async function onClick(event: MouseEvent): Promise<void> {
  const target = event.target as HTMLElement
  const tab = target.closest('[data-tab]')?.getAttribute('data-tab')
  if (tab !== null && tab !== undefined) {
    view.tab = tab
    void saveView()
    render()
    return
  }
  const row = target.closest('[data-task]')?.getAttribute('data-task')
  if (row !== null && row !== undefined) {
    view.selected = row
    view.tab = 'tasks'
    void saveView()
    await refresh()
    return
  }
  const button = target.closest('button[data-act]')
  if (button === null) return
  const act = button.getAttribute('data-act')
  const id = button.getAttribute('data-id') ?? undefined
  switch (act) {
    case 'new':
      await action('agy_panel_action', { action: 'run', description: ($('new-label') as HTMLInputElement).value, prompt: ($('new-prompt') as HTMLTextAreaElement).value })
      ;($('new-prompt') as HTMLTextAreaElement).value = ''
      break
    case 'cancel':
      await action('agy_panel_action', { action: 'cancel', task: view.selected })
      break
    case 'followup-open':
      $('followup-box').classList.toggle('hidden')
      break
    case 'followup-send':
      await action('agy_panel_action', { action: 'followup', task: view.selected, prompt: ($('followup-prompt') as HTMLTextAreaElement).value })
      break
    case 'switch':
      await action('agy_accounts', { action: 'switch', id })
      break
    case 'toggle':
      await action('agy_accounts', { action: 'config', toggle_account: id })
      break
    case 'remove':
      if (window.confirm('确定从账号库移除该账号？本机当前登录文件不受影响。')) await action('agy_accounts', { action: 'remove', id })
      break
    case 'login':
      noticeKind = 'info'
      await action('agy_login', {})
      notice = '登录窗口已打开。完成登录后，点击「2. 保存当前登录」。'
      noticeKind = 'info'
      break
    case 'capture':
      await action('agy_accounts', { action: 'capture' })
      break
    case 'refresh':
      await refresh()
      break
  }
}

document.addEventListener('click', (event) => void onClick(event as MouseEvent))
document.addEventListener('change', (event) => {
  const target = event.target as HTMLElement
  if (target.id === 'rotation-enabled') void action('agy_accounts', { action: 'config', enabled: (target as HTMLInputElement).checked })
  if (target.id === 'rotation-strategy') void action('agy_accounts', { action: 'config', strategy: (target as HTMLSelectElement).value })
})

await app.connect()
const host = app.getHostContext()
view = (host?.['zcode/widgetState'] as ViewState | undefined) ?? {}

// Push channel: the server notifies on registry / account changes.
const capabilities = app.getHostCapabilities()
if (capabilities?.experimental?.['zcode/resourceSubscribe']) {
  try {
    await app.request({ method: 'resources/subscribe', params: { uri: 'ui://agy-delegate/panel.html' } }, EmptyResultSchema)
  } catch {
    // fall back to the polling loop below
  }
}

await refresh()
setInterval(() => {
  if (data?.runs.some((r) => r.status === 'running')) void refresh()
}, 5000)
