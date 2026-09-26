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

/** 直接构造 Session 记录（export 为纯函数，接受任何该形状的对象），用于窗口化/回退/边界测试。 */
function synthSession(msgTexts, overrides = {}) {
  return {
    id: 'syn-1', title: null, cwd: '/proj/syn', originator: null, cliVersion: null,
    provider: 'openai', model: 'gpt-x', createdAt: null, updatedAt: null,
    messages: msgTexts.map((t, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: t, timestamp: null })),
    toolCalls: [], tokens: null, badLines: 0, ...overrides,
  }
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

test('renderExport: json 可 round-trip；md 走 toMarkdown；未知格式抛 invalid', () => {
  const s = sample()
  const back = JSON.parse(renderExport(s, 'json'))
  assert.equal(back.id, 'sid-1')
  assert.equal(back.messages.length, s.messages.length)
  assert.ok(renderExport(s, 'md').startsWith('# 测试会话'), 'md 分支走 toMarkdown（Task 10 export 默认格式）')
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

test('buildResumeContext: 默认窗口只取最近 6 条、排除更早消息，并按默认长度裁剪（审查缺口 #2）', () => {
  const texts = []
  for (let i = 0; i < 10; i++) texts.push(i === 9 ? 'x'.repeat(500) : `消息${i}号`)
  const s = synthSession(texts)
  const text = buildResumeContext(s) // 全默认 maxMessages=6 maxCharsPerMessage=400 goalChars=1500
  for (const i of [4, 5, 6, 7, 8]) assert.ok(text.includes(`消息${i}号`), `消息${i}号 应在最近窗口`)
  for (const i of [1, 2, 3]) assert.ok(!text.includes(`消息${i}号`), `消息${i}号 应被窗口排除`)
  assert.ok(text.includes('…（已截断）'), '500 字尾条应按默认 400 裁剪')
})

test('toMarkdown/buildResumeContext: title 为 null 时回退到 id（审查缺口 #3，真实语料 ~35% 无索引标题）', () => {
  const s = synthSession(['你好']) // title: null
  assert.ok(toMarkdown(s).startsWith('# syn-1'), 'toMarkdown 用 id 作标题')
  assert.ok(buildResumeContext(s).includes('会话：syn-1'), 'resume 上下文用 id 作标题')
})

test('clip: 截断边界不拆开代理对（审查 I2）', () => {
  const s = synthSession(['a😀b'], { title: 'T' })
  const text = buildResumeContext(s, { goalChars: 2 }) // 边界正落在 '😀' 中间
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), '输出不应含孤立高位代理')
  assert.ok(text.includes('…（已截断）'))
})

test('toJson: 白名单排除上层临时挂载字段（审查 I1，Task 10 持久化工件可复现）', () => {
  const s = sample()
  s.archived = true
  s.mtimeMs = 123456
  const back = JSON.parse(renderExport(s, 'json'))
  assert.equal(back.id, 'sid-1')
  assert.ok(Array.isArray(back.messages))
  assert.equal('archived' in back, false, 'archived 不应进入导出工件')
  assert.equal('mtimeMs' in back, false, 'mtimeMs 不应进入导出工件')
  assert.equal('badLines' in back, true, 'reader 保真字段保留')
})

test('buildResumeContext: maxMessages<=0 只保留原目标、不带最近进展（审查 I3）', () => {
  const s = synthSession(['目标消息', '进展一', '进展二'])
  const text = buildResumeContext(s, { maxMessages: 0 })
  assert.ok(text.includes('目标消息'), '原目标仍在')
  assert.ok(!text.includes('进展一'), 'maxMessages=0 不带最近进展')
})
