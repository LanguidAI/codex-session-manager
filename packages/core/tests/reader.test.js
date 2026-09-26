import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionContent } from '../src/reader.js'
import { rolloutLines } from './helpers/fixture.js'

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
