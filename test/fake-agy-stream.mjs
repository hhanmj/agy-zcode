#!/usr/bin/env node
// Offline agy stand-in for persistent sessions and hook supervision.
// Streaming input (--input-format stream-json): one turn per stdin line, the
// process stays alive until stdin closes (a one-shot stdin prompt is just a
// single line followed by EOF). With -p it runs one turn and exits.
// Like the real CLI it loads .agents/hooks.json from --add-dir directories
// and runs the PreToolUse/Stop commands through the shell (cwd = .agents).
// Prompt directives:
//   CMD=<command>  run_command tool call, subject to the PreToolUse hook
//   SLEEP=<ms>     pause inside a tool step
//   WRITE=<name>   create <name> in the working directory
//   FAIL           finish the turn with an ERROR result (session continues)
//   EXIT           die mid-turn without a result (exit 1)
// Each turn is appended to $FAKE_AGY_LOG as one JSON line.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'

const HELP = [
  'Usage of agy.exe:',
  '  --add-dir                       Add a directory to the workspace (repeatable) (default [])',
  '  --conversation                  Resume a previous conversation by ID',
  '  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting',
  '  --effort                        Reasoning effort (low|medium|high|xhigh|max)',
  '  --input-format                  Input format for print mode (text, stream-json). stream-json reads one NDJSON message per line from stdin',
  '  --model                         Model for the current CLI session',
  '  --output-format                 Output format for print mode (text, json, stream-json) (default text)',
  '  --print                         Run a single prompt non-interactively and print the response',
  '  --print-timeout                 Optional time limit for print mode',
  '  --sandbox                       Run in a sandbox with terminal restrictions enabled',
  '',
].join('\n')
const MODELS = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n'

const args = process.argv.slice(2)
if (args[0] === 'help') {
  process.stdout.write(HELP)
  process.exit(0)
}
if (args[0] === 'models') {
  process.stdout.write(MODELS)
  process.exit(0)
}

const flag = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const log = (entry) => {
  if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(entry) + '\n')
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n')

const resumed = flag('--conversation') !== undefined
const conversation = flag('--conversation') ?? 'conv-' + randomUUID()
const addDirs = args.flatMap((arg, i) => (arg === '--add-dir' ? [args[i + 1]] : []))
const hookDirs = addDirs.filter((dir) => existsSync(join(dir, '.agents', 'hooks.json')))

function runHook(dir, event, input) {
  const config = JSON.parse(readFileSync(join(dir, '.agents', 'hooks.json'), 'utf8'))['dsh-agy-supervisor']
  const command = event === 'PreToolUse' ? config.PreToolUse[0].hooks[0].command : config.Stop[0].command
  const result = spawnSync(command, { shell: true, cwd: join(dir, '.agents'), input: JSON.stringify(input), encoding: 'utf8', env: process.env, windowsHide: true })
  try {
    return JSON.parse(result.stdout)
  } catch {
    // agy treats malformed hook output as a block
    return { decision: '', reason: 'malformed hook output: ' + result.stdout + result.stderr }
  }
}

let turn = 0
let step = 0
emit({ event: 'init', conversation_id: conversation, init: { cwd: process.cwd(), tools: ['run_command'], permission_mode: 'always-proceed' } })

async function runTurn(prompt) {
  turn += 1
  log({ pid: process.pid, turn, cwd: process.cwd(), conversation, resumed, args, prompt, policy: process.env.DSH_AGY_SUPERVISOR_POLICY ?? null, protectedPaths: process.env.DSH_AGY_SUPERVISOR_POLICY ? JSON.parse(readFileSync(process.env.DSH_AGY_SUPERVISOR_POLICY, 'utf8')).protectedPaths : [], hookDirs })
  const stepUpdate = (fields) => emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: step, ...fields } })
  stepUpdate({ state: 'DONE', step_type: 'user_input' })
  step += 1

  const command = (/CMD=(.+)$/m.exec(prompt) ?? [])[1]?.trim()
  const sleepMs = Number((/SLEEP=(\d+)/.exec(prompt) ?? [])[1] ?? 0)
  const toolCommand = command ?? 'echo working'
  stepUpdate({ state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: toolCommand } } })
  let denied
  if (command !== undefined) {
    for (const dir of hookDirs) {
      const decision = runHook(dir, 'PreToolUse', { stepIdx: step, toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: process.cwd() } } })
      if (decision.decision !== 'allow') denied = decision.reason ?? 'blocked'
    }
  }
  if (sleepMs > 0) await sleep(sleepMs)
  if (prompt.includes('EXIT')) process.exit(1)
  if (denied !== undefined) {
    stepUpdate({ state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: toolCommand }, error: { type: 'TOOL_ERROR', message: 'tool call denied by pre-tool hook: ' + denied } } })
  } else {
    stepUpdate({ state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.1, tool_info: { name: 'run_command', parameters: { CommandLine: toolCommand }, output: 'ok\n' } })
  }
  step += 1
  const write = (/WRITE=([\w.-]+)/.exec(prompt) ?? [])[1]
  if (write) writeFileSync(join(process.cwd(), write), 'written by fake agy\n')
  for (const dir of hookDirs) runHook(dir, 'Stop', { terminationReason: 'NO_TOOL_CALL' })

  if (prompt.includes('FAIL')) {
    emit({ event: 'result', result: { conversation_id: conversation, status: 'ERROR', error: 'boom from fake agy' } })
    return false
  }
  const answer = 'Echo: ' + prompt.split('\n')[0] + ' [pid ' + process.pid + ' turn ' + turn + (resumed ? ' resumed' : '') + ']'
  for (const piece of [answer.slice(0, 6), answer.slice(6)]) stepUpdate({ state: 'ACTIVE', step_type: 'agent_response', text_delta: piece })
  stepUpdate({ state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 10, output_tokens: 5 } })
  step += 1
  emit({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: answer, num_turns: turn } })
  return true
}

if (flag('--input-format') === 'stream-json') {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim().length === 0) continue
    await runTurn(JSON.parse(line).message.content)
  }
  process.exit(0)
} else {
  const ok = await runTurn(flag('-p') ?? '')
  process.exit(ok ? 0 : 3)
}
