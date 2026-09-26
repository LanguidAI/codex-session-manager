import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { findSessionFile, listSessions, readIndex } from '../src/catalog.js'
import { layout } from '../src/paths.js'
import { backdate, makeHome, writeIndex, writeSession } from './helpers/fixture.js'

test('readIndex: 同 id 多行取最后；文件缺失返回空 Map', async () => {
  const home = await makeHome()
  assert.equal((await readIndex(home)).size, 0)
  await writeIndex(home, [
    { id: 'a', thread_name: '旧名', updated_at: '2026-05-20T12:00:00Z' },
    { id: 'a', thread_name: '新名', updated_at: '2026-05-20T13:00:00Z' },
  ])
  const idx = await readIndex(home)
  assert.equal(idx.get('a').title, '新名')
})

test('listSessions: 索引标题合并 + 未命名回退 + 按 updatedAt 倒序', async () => {
  const home = await makeHome()
  const pa = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(pa, Date.now() - Date.parse('2026-05-20T12:00:00Z'))
  const pb = await writeSession(home, { id: 'b', day: '2026-05-21', cwd: '/proj/beta' })
  await backdate(pb, Date.now() - Date.parse('2026-05-21T12:00:00Z'))
  await writeIndex(home, [{ id: 'a', thread_name: '修复登录', updated_at: '2026-05-21T20:00:00Z' }])
  const list = await listSessions({ home })
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'a', '索引 updatedAt（05-21T20）比 b 的 mtime（05-21T12）新 → 排前')
  assert.equal(list[0].title, '修复登录')
  assert.equal(list[0].updatedAt, '2026-05-21T20:00:00Z', '索引较新时用索引值')
  assert.equal(list[1].title, '(未命名)')
  assert.equal(list[1].cwd, '/proj/beta')
})

test('listSessions: q/cwd/model 过滤', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'a', cwd: '/proj/alpha', model: 'gpt-5.5', day: '2026-05-20' })
  await writeSession(home, { id: 'b', cwd: '/proj/beta', model: 'gpt-5.6', day: '2026-05-21' })
  await writeIndex(home, [{ id: 'a', thread_name: '登录问题', updated_at: '2026-05-20T12:00:00Z' }])
  assert.equal((await listSessions({ home, q: '登录' })).length, 1)
  assert.equal((await listSessions({ home, cwd: '/proj/beta' })).length, 1)
  assert.equal((await listSessions({ home, model: 'gpt-5.5' })).length, 1)
  assert.equal((await listSessions({ home, q: 'zzz不存在' })).length, 0)
})

test('listSessions: 归档目录默认不含，includeArchived 含且带 archived 标记', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  const l = layout(home)
  await mkdir(l.archivedDir, { recursive: true })
  await rename(p, join(l.archivedDir, 'rollout-a.jsonl'))
  assert.equal((await listSessions({ home })).length, 0)
  const withArchived = await listSessions({ home, includeArchived: true })
  assert.equal(withArchived.length, 1)
  assert.equal(withArchived[0].archived, true)
})

test('findSessionFile: active/archived/trash 定位与 location 标记', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  const found = await findSessionFile(home, 'a')
  assert.equal(found.location, 'active')
  assert.equal(found.path, p)
  assert.ok(found.mtimeMs > 0)
  const l = layout(home)
  await mkdir(l.archivedDir, { recursive: true })
  await rename(p, join(l.archivedDir, 'rollout-a.jsonl'))
  assert.equal((await findSessionFile(home, 'a')).location, 'archived')
  await mkdir(l.trashDir, { recursive: true })
  await rename(join(l.archivedDir, 'rollout-a.jsonl'), join(l.trashDir, 'rollout-a.jsonl'))
  assert.equal((await findSessionFile(home, 'a')).location, 'trash', '回收站也能定位')
  assert.equal(await findSessionFile(home, 'nope'), null)
})

test('sessions 目录不存在 → 空列表不报错', async () => {
  const home = await makeHome()
  assert.deepEqual(await listSessions({ home }), [])
})

test('子代理线程：payload.id 为规范 id，列表与定位都用自身 id（审查 C1）', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'child-own', parentId: 'parent-1', day: '2026-05-20' })
  await writeIndex(home, [{ id: 'child-own', thread_name: '子任务', updated_at: '2026-05-20T12:00:00Z' }])
  const list = await listSessions({ home })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'child-own', '用自身 id 而非 session_id（父线程）')
  assert.equal(list[0].title, '子任务')
  assert.equal((await findSessionFile(home, 'child-own')).location, 'active')
  assert.equal(await findSessionFile(home, 'parent-1'), null, '父线程 id 不应误指向子线程文件')
})

test('resume 分片：列表按 id 去重保留最新，findSessionFile 返回 mtime 最新文件（审查 C2）', async () => {
  const home = await makeHome()
  const p1 = await writeSession(home, { id: 'r1', day: '2026-05-20', fork: 'fork-a' })
  await backdate(p1, Date.now() - Date.parse('2026-05-20T00:00:00Z'))
  const p2 = await writeSession(home, { id: 'r1', day: '2026-05-21', fork: 'fork-b' })
  await backdate(p2, Date.now() - Date.parse('2026-05-21T00:00:00Z'))
  const list = await listSessions({ home })
  assert.equal(list.length, 1, '同 id 去重为一条')
  assert.equal(list[0].path, p2, '保留 mtime 最新的记录')
  const found = await findSessionFile(home, 'r1')
  assert.equal(found.path, p2, '定位 mtime 最新文件，不依赖 readdir 顺序')
})

test('updatedAt 取索引与 mtime 较新者；非字符串索引时间回退磁盘（审查 I1/M1）', async () => {
  const home = await makeHome()
  const p1 = await writeSession(home, { id: 'u1', day: '2026-05-20' })
  await backdate(p1, Date.now() - Date.parse('2026-05-24T00:00:00Z')) // mtime 比索引新
  const p2 = await writeSession(home, { id: 'u2', day: '2026-05-20' })
  await backdate(p2, Date.now() - Date.parse('2026-05-22T00:00:00Z'))
  await writeIndex(home, [
    { id: 'u1', thread_name: '旧索引', updated_at: '2026-05-20T00:00:00Z' },
    { id: 'u2', thread_name: '脏行', updated_at: 12345 },
  ])
  const list = await listSessions({ home })
  const u1 = list.find((r) => r.id === 'u1')
  const u2 = list.find((r) => r.id === 'u2')
  assert.equal(u1.title, '旧索引')
  assert.ok(u1.updatedAt.startsWith('2026-05-24'), 'mtime 比索引新 → 用 mtime')
  assert.ok(u2.updatedAt.startsWith('2026-05-22'), '非字符串索引时间 → 回退 mtime')
  assert.equal(list[0].id, 'u1', 'u1（05-24）排在 u2（05-22）前')
})
