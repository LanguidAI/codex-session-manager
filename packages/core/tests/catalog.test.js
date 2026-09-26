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
  await writeSession(home, { id: 'a', day: '2026-05-20' })
  const pb = await writeSession(home, { id: 'b', day: '2026-05-21', cwd: '/proj/beta' })
  await backdate(pb, Date.now() - Date.parse('2026-05-21T12:00:00Z')) // b 无索引条目→mtime 兜底；拨回固定过去保证确定性
  await writeIndex(home, [{ id: 'a', thread_name: '修复登录', updated_at: '2026-05-21T20:00:00Z' }])
  const list = await listSessions({ home })
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'a', '索引 updatedAt 更晚的排前面')
  assert.equal(list[0].title, '修复登录')
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
