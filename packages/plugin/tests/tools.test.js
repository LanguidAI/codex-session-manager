import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionTools } from '../src/tools.js'
import { backdate, makeHome, writeIndex, writeSession } from '../../core/tests/helpers/fixture.js'

test('list_sessions / get_session', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'a', day: '2026-05-20', userText: '目标A' })
  await writeIndex(home, [{ id: 'a', thread_name: '会话A', updated_at: '2026-05-20T12:00:00Z' }])
  const tools = createSessionTools({ home })
  const list = await tools.list_sessions({})
  assert.equal(list.count, 1)
  assert.equal(list.sessions[0].title, '会话A')
  assert.equal((await tools.list_sessions({ query: 'zzz' })).count, 0)
  const detail = await tools.get_session({ id: 'a' })
  assert.equal(detail.title, '会话A')
  assert.ok(detail.messages.some((m) => m.text === '目标A'))
  assert.deepEqual({ ...detail.toolCallCounts }, { exec_command: 1 }) // countBy 返回 null-proto 对象，展开成普通对象再比（node:assert/strict 的 deepEqual 即 deepStrictEqual，会查原型）
  await assert.rejects(() => tools.get_session({ id: 'nope' }), (e) => e.code === 'not_found')
})

test('rename / archive / delete 透传 core 语义', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  const tools = createSessionTools({ home })
  assert.equal((await tools.rename_session({ id: 'a', title: 'T2' })).title, 'T2')
  assert.equal((await tools.archive_session({ id: 'a' })).location, 'archived')
  assert.equal((await tools.delete_session({ id: 'a' })).location, 'trash')
})

test('export_session: 默认 CODEX_HOME/exports；outputPath 锚定在 CODEX_HOME 内', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  const tools = createSessionTools({ home })
  const r = await tools.export_session({ id: 'a', format: 'md' })
  assert.equal(r.path, join(home, 'exports', 'a.md'))
  assert.ok((await readFile(r.path, 'utf8')).includes('会话'))
  await stat(r.path)
  const r2 = await tools.export_session({ id: 'a', outputPath: 'rel.md' })
  assert.equal(r2.path, join(home, 'rel.md'), '相对路径解析进 CODEX_HOME')
  await assert.rejects(() => tools.export_session({ id: 'a', outputPath: '/etc/evil.md' }), (e) => e.code === 'invalid')
  // I-3：export_session 的工具专属组合属性——json 默认命名 + 非法 format 在任何 fs 写入前抛 invalid（零副作用）
  const rj = await tools.export_session({ id: 'a', format: 'json' })
  assert.equal(rj.path, join(home, 'exports', 'a.json'))
  assert.equal(JSON.parse(await readFile(rj.path, 'utf8')).id, 'a')
  await assert.rejects(() => tools.export_session({ id: 'a', format: '../../evil' }), (e) => e.code === 'invalid')
  assert.deepEqual((await readdir(home)).sort(), ['exports', 'rel.md', 'sessions'], '非法 format ⇒ 零 fs 副作用')
})

test('安全护栏：export 拒绝覆盖 exports/ 外文件、rename 标题封顶', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  const tools = createSessionTools({ home })
  // I-1：outputPath 指向 exports/ 外的既有文件 → conflict 且原文件完好（皇冠明珠防护，全产品唯一不可逆写）
  await writeFile(join(home, 'precious.txt'), 'ORIGINAL')
  await assert.rejects(() => tools.export_session({ id: 'a', outputPath: 'precious.txt' }), (e) => e.code === 'conflict')
  assert.equal(await readFile(join(home, 'precious.txt'), 'utf8'), 'ORIGINAL')
  // exports/ 内同名文件允许幂等重导（不 conflict）
  const e1 = await tools.export_session({ id: 'a', format: 'md' })
  const e2 = await tools.export_session({ id: 'a', format: 'md' })
  assert.equal(e1.path, e2.path)
  // I-2：rename 标题超过 200 → invalid（镜像 web MAX_TITLE）
  await assert.rejects(() => tools.rename_session({ id: 'a', title: 'x'.repeat(201) }), (e) => e.code === 'invalid')
})
