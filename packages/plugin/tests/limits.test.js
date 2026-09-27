import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionTools } from '../src/tools.js'
import { makeHome, sessionRelPath, writeIndex, writeSession } from '../../core/tests/helpers/fixture.js'

// #16：MCP 载荷体积上限。实测真实语料消息数分布（700 会话）：
//   中位 19 / p90 151 / p95 310 / p99 899 / 最大 4228
// → get_session 默认 maxMessages=200 可完整覆盖约九成会话，超出的截断并显式报告。
const DEFAULT_MAX_MESSAGES = 200

/** 写入含 n 条 user 消息的会话（用于构造超大会话）。 */
async function writeBigSession(home, { id, n, day = '2026-05-20' }) {
  const p = join(home, sessionRelPath(id, day))
  await mkdir(dirname(p), { recursive: true })
  const ts = '2026-05-20T12:00:00.000Z'
  const lines = [JSON.stringify({
    timestamp: ts, ordinal: 0, type: 'session_meta',
    payload: { session_id: id, id, timestamp: ts, cwd: '/proj/alpha', originator: 'Codex Desktop', cli_version: '0.131.0', model_provider: 'azure' },
  })]
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({
      timestamp: ts, ordinal: i + 1, type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'UserMessage', id: `item-${i}`, content: [{ type: 'text', text: `msg-${i}` }] } },
    }))
  }
  await writeFile(p, lines.join('\n') + '\n')
  return p
}

test('#16 get_session：超大会话默认截断到 200 条并报告总数（保留最近消息）', async () => {
  const home = await makeHome()
  await writeBigSession(home, { id: 'big', n: 300 })
  const tools = createSessionTools({ home })

  const r = await tools.get_session({ id: 'big' })
  assert.equal(r.totalMessages, 300, '应报告截断前的消息总数')
  assert.equal(r.messages.length, DEFAULT_MAX_MESSAGES, '默认应只返回 200 条')
  assert.equal(r.messagesTruncated, true, '应显式标记已截断，提示改用 export_session')
  assert.equal(r.messages.at(-1).text, 'msg-299', '应保留最近的 200 条（尾部）而非最早的')

  // 显式放行全量（0 = 不限制）
  const all = await tools.get_session({ id: 'big', maxMessages: 0 })
  assert.equal(all.messages.length, 300, 'maxMessages=0 应返回全量')
  assert.equal(all.messagesTruncated, false)
  assert.equal(all.totalMessages, 300)
})

test('#16 get_session：小会话不受影响（不截断、不误标）', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'a', day: '2026-05-20', userText: '目标A' })
  await writeIndex(home, [{ id: 'a', thread_name: '会话A', updated_at: '2026-05-20T12:00:00Z' }])
  const tools = createSessionTools({ home })
  const r = await tools.get_session({ id: 'a' })
  assert.equal(r.messagesTruncated, false, '小会话不应标记截断')
  assert.equal(r.totalMessages, r.messages.length)
  assert.ok(r.messages.some((m) => m.text === '目标A'), '原有内容仍可见')
})

test('#16 list_sessions：支持 limit 并报告 total/returned/truncated（count 保持为匹配总数）', async () => {
  const home = await makeHome()
  for (const id of ['a', 'b', 'c']) {
    await writeSession(home, { id, day: '2026-05-2' + (id === 'a' ? '0' : id === 'b' ? '1' : '2'), userText: `目标${id}` })
  }
  const tools = createSessionTools({ home })

  const capped = await tools.list_sessions({ limit: 2 })
  assert.equal(capped.sessions.length, 2, 'limit=2 应只返回 2 条')
  assert.equal(capped.count, 3, 'count 应仍为匹配总数（兼容既有语义）')
  assert.equal(capped.returned, 2)
  assert.equal(capped.truncated, true, '应标记已截断')

  const all = await tools.list_sessions({})
  assert.equal(all.sessions.length, 3, '默认 limit 不应截断小语料')
  assert.equal(all.truncated, false)
  assert.equal(all.count, 3)
})

test('#16 非法 limit/maxMessages 抛 invalid（防负数/非数值造成切片歧义）', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'a', day: '2026-05-20' })
  const tools = createSessionTools({ home })
  await assert.rejects(() => tools.list_sessions({ limit: -1 }), (e) => e.code === 'invalid')
  await assert.rejects(() => tools.list_sessions({ limit: 'abc' }), (e) => e.code === 'invalid')
  await assert.rejects(() => tools.get_session({ id: 'a', maxMessages: -5 }), (e) => e.code === 'invalid')
})

test('#16 MCP schema 暴露 limit / maxMessages（否则 MCP 客户端会剥掉这两个参数，限制形同虚设）', () => {
  const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs'), 'utf8')
  assert.match(server, /maxMessages/, 'server.mjs 的 get_session inputSchema 应声明 maxMessages')
  assert.match(server, /\blimit\b/, 'server.mjs 的 list_sessions inputSchema 应声明 limit')
  // 描述里也要提示截断行为，否则模型不知为何少了消息
  assert.match(server, /截断/, '工具描述应说明截断语义')
})