import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fastMeta, parseSessionContent, readSessionFile } from '../src/reader.js'
import { makeHome, rolloutLines } from './helpers/fixture.js'
import { readdirSync } from 'node:fs'

test('解析 meta/model/消息/工具/tokens', () => {
  const s = parseSessionContent(rolloutLines({ id: 'sid-1', cwd: '/proj/x', model: 'gpt-5.5', provider: 'azure', userText: '目标A', assistantText: '完成A', tokens: 99 }))
  assert.equal(s.id, 'sid-1')
  assert.equal(s.cwd, '/proj/x')
  assert.equal(s.model, 'gpt-5.5')
  assert.equal(s.provider, 'azure')
  assert.equal(s.tokens, 99)
  assert.equal(s.badLines, 0)
  const users = s.messages.filter((m) => m.role === 'user')
  assert.equal(users.length, 1, 'item_completed 用户消息生效，注入与 response_item 重复项被去掉')
  assert.equal(users[0].text, '目标A')
  assert.equal(s.messages.find((m) => m.role === 'assistant').text, '完成A')
  assert.deepEqual(s.toolCalls, ['exec_command'])
})

test('无 item_completed 时回退 response_item user 并过滤注入', () => {
  const lines = [
    JSON.stringify({ timestamp: 't', ordinal: 0, type: 'session_meta', payload: { session_id: 's2', id: 's2', cwd: '/p' } }),
    JSON.stringify({ timestamp: 't', ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /p' }] } }),
    JSON.stringify({ timestamp: 't', ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '真正的问题' }] } }),
  ].join('\n')
  const s = parseSessionContent(lines)
  assert.equal(s.messages.length, 1)
  assert.equal(s.messages[0].text, '真正的问题')
})

test('坏行计数不致命', () => {
  const s = parseSessionContent('not json\n' + rolloutLines({ id: 's3' }))
  assert.equal(s.badLines, 1)
  assert.equal(s.id, 's3')
})

test('扩充注入前缀：<recommended_plugins 等在回退模式被过滤', () => {
  const U = (ordinal, text) => JSON.stringify({ timestamp: 't', ordinal, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
  const lines = [
    JSON.stringify({ timestamp: 't', ordinal: 0, type: 'session_meta', payload: { session_id: 's4', id: 's4', cwd: '/p' } }),
    U(1, '<recommended_plugins> 试试这些插件'),
    U(2, '<turn_aborted> 已取消'),
    U(3, '<codex_internal_context source="goal"> 内部目标'),
    U(4, '接下来做什么'),
  ].join('\n')
  const s = parseSessionContent(lines)
  assert.equal(s.messages.length, 1)
  assert.equal(s.messages[0].text, '接下来做什么')
})

test('model 语义一致：parseSessionContent 与 fastMeta 均取第一个 turn_context', async () => {
  const home = await makeHome()
  const content = [
    JSON.stringify({ timestamp: 't1', ordinal: 0, type: 'session_meta', payload: { session_id: 'm1', id: 'm1', cwd: '/p' } }),
    JSON.stringify({ timestamp: 't2', ordinal: 1, type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    JSON.stringify({ timestamp: 't3', ordinal: 2, type: 'turn_context', payload: { model: 'gpt-5.6-codex' } }),
  ].join('\n') + '\n'
  assert.equal(parseSessionContent(content).model, 'gpt-5.5')
  const p = join(home, 'two-models.jsonl')
  await writeFile(p, content)
  assert.equal((await fastMeta(p)).model, 'gpt-5.5')
})

test('非对象 JSON 行（null/标量/数组）计入 badLines 且不崩溃', async () => {
  const s = parseSessionContent('null\n123\n"str"\ntrue\n[]\n' + rolloutLines({ id: 's5' }))
  assert.equal(s.badLines, 5)
  assert.equal(s.id, 's5')
  const home = await makeHome()
  const p = join(home, 'nulls.jsonl')
  await writeFile(p, 'null\n' + rolloutLines({ id: 's6' }))
  assert.equal((await fastMeta(p)).id, 's6', 'fastMeta 跳过 null 行不抛错')
})

test('fastMeta: turn_context 缺失或超出 maxLines 时 model 为 null；maxLines 可覆盖', async () => {
  const home = await makeHome()
  const noTc = join(home, 'no-tc.jsonl')
  await writeFile(noTc, JSON.stringify({ timestamp: 't', ordinal: 0, type: 'session_meta', payload: { session_id: 'f1', id: 'f1', cwd: '/p', model_provider: 'azure' } }) + '\n')
  assert.equal((await fastMeta(noTc)).model, null)
  const lateTc = join(home, 'late-tc.jsonl')
  const lines = [JSON.stringify({ timestamp: 't', ordinal: 0, type: 'session_meta', payload: { session_id: 'f2', id: 'f2', cwd: '/p' } })]
  for (let i = 1; i <= 250; i++) lines.push(JSON.stringify({ timestamp: 't', ordinal: i, type: 'event_msg', payload: { type: 'task_started' } }))
  lines.push(JSON.stringify({ timestamp: 't', ordinal: 251, type: 'turn_context', payload: { model: 'gpt-9' } }))
  await writeFile(lateTc, lines.join('\n') + '\n')
  assert.equal((await fastMeta(lateTc)).model, null, '默认 200 行界限内找不到')
  assert.equal((await fastMeta(lateTc, { maxLines: 300 })).model, 'gpt-9')
})

test('fastMeta: 超长单行（>64KB）不截断', async () => {
  const home = await makeHome()
  const p = join(home, 'big-meta.jsonl')
  const content = JSON.stringify({ timestamp: 't', ordinal: 0, type: 'session_meta', payload: { session_id: 'big1', id: 'big1', cwd: '/p', model_provider: 'azure', base_instructions: { text: 'x'.repeat(100_000) } } })
    + '\n' + JSON.stringify({ timestamp: 't', ordinal: 1, type: 'turn_context', payload: { model: 'gpt-5.5' } }) + '\n'
  await writeFile(p, content)
  const meta = await fastMeta(p)
  assert.equal(meta.id, 'big1')
  assert.equal(meta.model, 'gpt-5.5')
})

test('readSessionFile: 流式解析、updatedAt=最后时间戳、文件不存在抛 not_found', async () => {
  const home = await makeHome()
  const p = join(home, 'detail.jsonl')
  const content = [
    JSON.stringify({ timestamp: '2026-05-20T12:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { session_id: 'd1', id: 'd1', cwd: '/proj/d', originator: 'Codex Desktop', cli_version: '0.131.0', model_provider: 'azure' } }),
    JSON.stringify({ timestamp: '2026-05-20T12:00:01.000Z', ordinal: 1, type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    JSON.stringify({ timestamp: '2026-05-20T12:00:02.000Z', ordinal: 2, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '第一问' }] } } }),
    JSON.stringify({ timestamp: '2026-05-20T12:05:00.000Z', ordinal: 3, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 77 } } } }),
  ].join('\n') + '\n'
  await writeFile(p, content)
  const s = await readSessionFile(p)
  assert.equal(s.id, 'd1')
  assert.equal(s.originator, 'Codex Desktop')
  assert.equal(s.cliVersion, '0.131.0')
  assert.equal(s.createdAt, '2026-05-20T12:00:00.000Z')
  assert.equal(s.updatedAt, '2026-05-20T12:05:00.000Z')
  assert.equal(s.tokens, 77)
  assert.equal(s.messages.length, 1)
  assert.equal(s.messages[0].text, '第一问')
  await assert.rejects(() => readSessionFile(join(home, 'missing.jsonl')), (e) => e.code === 'not_found')
})

test('fastMeta: 提前 break 不泄漏 fd（stream.destroy 回收）', async () => {
  const home = await makeHome()
  const p = join(home, 'fd.jsonl')
  await writeFile(p, rolloutLines({ id: 'fd1' }))
  const countFds = () => readdirSync('/dev/fd').length
  const before = countFds()
  for (let i = 0; i < 200; i++) await fastMeta(p) // 找齐 id+model 提前退出
  for (let i = 0; i < 200; i++) await fastMeta(p, { maxLines: 1 }) // maxLines break 路径
  const after = countFds()
  assert.ok(after - before <= 5, `fd 应保持稳定: before=${before} after=${after}`)
})
