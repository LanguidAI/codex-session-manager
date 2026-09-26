import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** 新建一个临时 CODEX_HOME。 */
export async function makeHome() {
  return mkdtemp(join(tmpdir(), 'csm-test-'))
}

/** 按真实 rollout schema 生成会话文件内容。 */
export function rolloutLines({
  id,
  parentId,
  cwd = '/proj/alpha',
  model = 'gpt-5.5',
  provider = 'azure',
  userText = '帮我修登录 bug',
  assistantText = '已修复并补了回归测试。',
  createdAt = '2026-05-20T12:00:00.000Z',
  tokens = 4200,
}) {
  const L = (ordinal, type, payload) => JSON.stringify({ timestamp: createdAt, ordinal, type, payload })
  return [
    L(0, 'session_meta', { session_id: parentId ?? id, id, timestamp: createdAt, cwd, originator: 'Codex Desktop', cli_version: '0.131.0', source: 'vscode', thread_source: 'user', model_provider: provider, base_instructions: { text: 'x'.repeat(200) } }),
    L(1, 'turn_context', { turn_id: 'turn-1', cwd, model, approval_policy: 'never' }),
    L(2, 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions> sandbox on' }] }),
    L(3, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${cwd}` }] }),
    L(4, 'event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'item-1', content: [{ type: 'text', text: userText }] } }),
    L(5, 'response_item', { type: 'function_call', name: 'exec_command', arguments: '{}', call_id: 'c1' }),
    L(6, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistantText }] }),
    L(7, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: tokens, output_tokens: 0, total_tokens: tokens } } }),
  ].join('\n') + '\n'
}

/** 会话文件相对 CODEX_HOME 的路径（YYYY/MM/DD 目录 + rollout 文件名含 id；fork 模拟 resume 分片）。 */
export function sessionRelPath(id, day = '2026-05-20', fork) {
  const [y, m, d] = day.split('-')
  return join('sessions', y, m, d, `rollout-${day}T00-00-00-${id}${fork ? `_${fork}` : ''}.jsonl`)
}

/** 写入一个会话文件，返回绝对路径。 */
export async function writeSession(home, opts) {
  const p = join(home, sessionRelPath(opts.id, opts.day, opts.fork))
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, rolloutLines(opts))
  return p
}

/** 写 session_index.jsonl（entries: [{id, thread_name, updated_at}]）。 */
export async function writeIndex(home, entries) {
  await writeFile(join(home, 'session_index.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

/** 把文件 mtime 拨回过去，避开 30 秒活跃写入防护。 */
export async function backdate(path, ms = 120_000) {
  const t = new Date(Date.now() - ms)
  await utimes(path, t, t)
}
