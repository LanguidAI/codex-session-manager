import test from 'node:test'
import assert from 'node:assert/strict'
import { buildResumeContext, renderExport, toMarkdown } from '../src/export.js'
import { parseSessionContent } from '../src/reader.js'
import { rolloutLines } from './helpers/fixture.js'

function sample(overrides = {}) {
  const s = parseSessionContent(rolloutLines({ id: 'sid-1', userText: '目标A', assistantText: '完成A', ...overrides }))
  s.title = '测试会话'
  return s
}

test('toMarkdown: 含元信息头、用户/助手消息、工具统计', () => {
  const md = toMarkdown(sample())
  assert.ok(md.includes('# 测试会话'))
  assert.ok(md.includes('`sid-1`'))
  assert.ok(md.includes('/proj/alpha'))
  assert.ok(md.includes('目标A'))
  assert.ok(md.includes('完成A'))
  assert.ok(md.includes('exec_command'))
})

test('renderExport: json 可 round-trip；未知格式抛 invalid', () => {
  const s = sample()
  const back = JSON.parse(renderExport(s, 'json'))
  assert.equal(back.id, 'sid-1')
  assert.equal(back.messages.length, s.messages.length)
  assert.throws(() => renderExport(s, 'xml'), (e) => e.code === 'invalid')
})

test('buildResumeContext: 含原目标 + 最近进展 + 截断', () => {
  const s = sample({ userText: '很'.repeat(3000) })
  const text = buildResumeContext(s, { goalChars: 100 })
  assert.ok(text.includes('# 请继续这个 Codex 会话：测试会话'))
  assert.ok(text.includes('原项目目录: /proj/alpha'))
  assert.ok(text.includes('…（已截断）'))
  assert.ok(text.includes('完成A'))
})
