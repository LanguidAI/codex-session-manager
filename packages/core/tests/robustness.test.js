import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildResumeContext } from '../src/export.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** 直接构造 Session 记录（export 为纯函数）。 */
function synth(msgTexts, overrides = {}) {
  return {
    id: 'syn-1', title: '测试会话', cwd: '/proj/syn', originator: null, cliVersion: null,
    provider: 'openai', model: 'gpt-x', createdAt: null, updatedAt: '2026-05-20T12:00:00Z',
    messages: msgTexts.map((t, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: t, timestamp: null })),
    toolCalls: [], tokens: null, badLines: 0, ...overrides,
  }
}

// ---- #13 条目分隔与短会话重复 ----

test('#13 最近进展：条目之间有空行（否则 Markdown 会把连续行合并成一段）', () => {
  const out = buildResumeContext(synth(['目标', '第一步', '第二步', '第三步', '第四步', '第五步', '第六步', '第七步']))
  const lines = out.split('\n')
  const start = lines.indexOf('## 最近进展')
  const body = lines.slice(start + 1).filter((l) => l.startsWith('**'))
  assert.ok(body.length >= 2, `前置条件：应有多个条目（实际 ${body.length}）`)

  // 判别器：条目在 Markdown 源码中必须以空行相隔，否则渲染成一个段落。
  const idx = lines.indexOf(body[0])
  assert.equal(lines[idx + 1], '', '首个条目后应有空行，否则与下一条粘成一段')
})

test('#13 短会话：最近进展不得与「原目标」重复同一条消息', () => {
  // 只有 2 条消息：首条用户消息必然也落在 maxMessages 窗口内。
  const out = buildResumeContext(synth(['目标是修复登录 bug', '好的，我先看代码']))
  const occurrences = out.split('目标是修复登录 bug').length - 1
  assert.equal(occurrences, 1, `目标消息应只出现一次（实际 ${occurrences} 次）——短会话时窗口已完整覆盖原目标`)
})

test('#13 长会话：原目标不在窗口内时，两条信息都要保留', () => {
  const texts = ['最初的目标', ...Array.from({ length: 10 }, (_, i) => `进展${i}`)]
  const out = buildResumeContext(synth(texts))
  assert.match(out, /最初的目标/, '窗口外的原目标必须保留在「原目标」小节')
  assert.match(out, /进展9/, '最近进展仍须包含最新消息')
})

test('#13 窗口覆盖原目标时：保留信息更全的「原目标」，把它从最近进展中移除', () => {
  // 直接构造长目标（> maxCharsPerMessage 400，< goalChars 1500）验证「保留哪一份」
  const longGoal = '目标'.repeat(300) // 600 字符
  const out = buildResumeContext(synth([longGoal, '回复']), { maxMessages: 6 })
  assert.match(out, /## 原目标/, '「原目标」小节应保留（它的裁剪预算更大）')
  const count = out.split(longGoal).length - 1
  assert.equal(count, 1, `长目标应只出现一次且完整保留（实际 ${count} 次）`)
  // 关键：不得退化成只留最近进展里的 400 字版本（那是信息损失而非去重）
  const goalLine = out.split('\n').find((l) => l.startsWith('目标'))
  assert.equal(goalLine.length, 600, `原目标应完整保留 600 字（实际 ${goalLine.length} 字 = 被裁到 400 的退化）`)
})

test('#13 只有一条用户消息时：不出现空的「最近进展」小节', () => {
  const out = buildResumeContext(synth(['唯一目标']), { maxMessages: 6 })
  assert.match(out, /唯一目标/)
  assert.doesNotMatch(out, /## 最近进展/, '窗口内容被去重抽空后不应留下空标题')
})

// ---- #11 Date.parse 严格性与 typeof 守卫 ----

test('#11 catalog 不得裸用宽松 Date.parse 解析索引时间', () => {
  const src = readFileSync(join(SRC, 'catalog.js'), 'utf8')
  // 判别器：修复前是裸 `Date.parse(idx.updatedAt)`，会接受 '2099/01/01' 等非 ISO 形状
  // （Safari/Firefox 对宽松格式的接受度不同 → 跨引擎 updatedAt 不一致）。
  // 只断言「不裸用」+「经 dates.js 校验」，不绑定具体函数名（行为由下面的用例保证）。
  assert.doesNotMatch(src, /Date\.parse\(\s*idx[?.]*\.updatedAt/, '不应裸用 Date.parse 解析索引时间')
  assert.match(src, /from '\.\/dates\.js'/, '应复用 dates.js 的严格校验')
})

test('#11 行为：索引里的宽松格式时间不得冒充 updatedAt（须回落文件 mtime）', async () => {
  const { listSessions } = await import('../src/catalog.js')
  const { makeHome, writeIndex, writeSession, backdate } = await import('./helpers/fixture.js')
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p) // 文件 mtime 拨回过去
  // V8 的 Date.parse('2099/01/01') 是合法的（宽松解析）→ 修复前会被当成 updatedAt
  await writeIndex(home, [{ id: 'a', thread_name: '会话A', updated_at: '2099/01/01' }])
  const [s] = await listSessions({ home })
  assert.equal(s.title, '会话A', '标题仍应取自索引')
  assert.doesNotMatch(String(s.updatedAt), /2099/, '宽松格式时间不得被采纳为 updatedAt')
})

test('#11 ISO 形状校验的实际行为：接受合法 ISO，拒绝宽松/非法形状', async () => {
  const { isIsoTimestamp } = await import('../src/dates.js').catch(() => ({}))
  assert.equal(typeof isIsoTimestamp, 'function', '应导出 isIsoTimestamp 供 catalog 复用')
  assert.equal(isIsoTimestamp('2026-05-20T12:00:00Z'), true)
  assert.equal(isIsoTimestamp('2026-05-20T12:00:00.000Z'), true)
  assert.equal(isIsoTimestamp('2026-05-20T12:00:00+08:00'), true)
  assert.equal(isIsoTimestamp('2026/01/01'), false, '宽松斜杠格式不得接受')
  assert.equal(isIsoTimestamp('2026-13-45'), false, '非法月日不得接受')
  assert.equal(isIsoTimestamp('garbage'), false)
  assert.equal(isIsoTimestamp(1750000000000), false, '数字时间戳不是 ISO 字符串')
  assert.equal(isIsoTimestamp(null), false)
  assert.equal(isIsoTimestamp(undefined), false)
})

test('#11 reader：createdAt 与消息 timestamp 必须有 typeof 守卫（防非字符串污染导出/resume）', () => {
  const src = readFileSync(join(SRC, 'reader.js'), 'utf8')
  // 实测判定依据：修复前 reader.js:62 是 `p.timestamp ?? line.timestamp ?? ...`（无类型守卫），
  // 若语料里 timestamp 为数字/对象，会原样进入 Session.createdAt → export.json 输出非法类型。
  assert.doesNotMatch(src, /session\.createdAt = p\.timestamp \?\?/, 'createdAt 赋值缺 typeof 守卫')
  const guards = src.match(/typeof line\.timestamp === 'string'/g) ?? []
  assert.ok(guards.length >= 1, '应对 line.timestamp 做 typeof 判别')
})