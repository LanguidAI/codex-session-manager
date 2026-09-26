import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findSessionFile, listSessions, readIndex } from '../src/catalog.js'
import { archiveSession, deleteSession, renameSession } from '../src/mutate.js'
import { layout } from '../src/paths.js'
import { backdate, makeHome, writeIndex, writeSession } from './helpers/fixture.js'

test('rename: 追加索引行，catalog 反映新标题，索引先备份', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  await writeIndex(home, [{ id: 'a', thread_name: '旧名', updated_at: '2026-05-20T12:00:00Z' }])
  await renameSession({ home, id: 'a', title: ' 新名字 ' })
  const idx = await readIndex(home)
  assert.equal(idx.get('a').title, '新名字', 'trim 后写入')
  const list = await listSessions({ home })
  assert.equal(list[0].title, '新名字')
  const backups = await readdir(layout(home).backupsDir)
  assert.equal(backups.length, 1)
  const backupFiles = await readdir(join(layout(home).backupsDir, backups[0]))
  assert.ok(backupFiles.includes('session_index.jsonl'))
})

test('rename: 未知 id → not_found；空标题 → invalid', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'a', day: '2026-05-20' })
  await assert.rejects(() => renameSession({ home, id: 'nope', title: 'x' }), (e) => e.code === 'not_found')
  await assert.rejects(() => renameSession({ home, id: 'a', title: '   ' }), (e) => e.code === 'invalid')
})

test('archive: 移入 archived_sessions，活跃列表消失，归档列表出现', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  const r = await archiveSession({ home, id: 'a' })
  assert.equal(r.location, 'archived')
  assert.equal((await listSessions({ home })).length, 0)
  const archived = await listSessions({ home, includeArchived: true })
  assert.equal(archived.length, 1)
  assert.equal(archived[0].archived, true)
  await stat(join(layout(home).archivedDir, 'rollout-2026-05-20T00-00-00-a.jsonl'))
  await assert.rejects(() => archiveSession({ home, id: 'a' }), (e) => e.code === 'invalid')
})

test('delete: 软删除移入 .csm-trash + 备份原文件', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  const r = await deleteSession({ home, id: 'a' })
  assert.equal(r.location, 'trash')
  assert.equal((await listSessions({ home, includeArchived: true })).length, 0)
  assert.equal((await findSessionFile(home, 'a')).location, 'trash')
  const backups = await readdir(layout(home).backupsDir)
  const backupFiles = await readdir(join(layout(home).backupsDir, backups[0]))
  assert.ok(backupFiles.some((f) => f.includes('rollout-')))
  await assert.rejects(() => deleteSession({ home, id: 'a' }), (e) => e.code === 'invalid')
})

test('活跃防护: 30 秒内被写过的文件默认拒绝，force 可越过', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'fresh', day: '2026-05-20' })
  await backdate(p, 5_000) // 5 秒前——仍在 30s 窗口内；固定偏移避免同毫秒竞态（审查修正）
  await assert.rejects(() => archiveSession({ home, id: 'fresh' }), (e) => e.code === 'active')
  const r = await archiveSession({ home, id: 'fresh', force: true })
  assert.equal(r.location, 'archived')
})

test('冲突防护: expectedMtimeMs 不符 → conflict', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  await assert.rejects(
    () => archiveSession({ home, id: 'a', expectedMtimeMs: 12345 }),
    (e) => e.code === 'conflict',
  )
})

test('resume 分片: 归档一次移走全部文件，活跃列表不再出现该线程', async () => {
  const home = await makeHome()
  const p1 = await writeSession(home, { id: 'r1', day: '2026-05-20', fork: 'fork-a' })
  await backdate(p1)
  const p2 = await writeSession(home, { id: 'r1', day: '2026-05-21', fork: 'fork-b' })
  await backdate(p2)
  const r = await archiveSession({ home, id: 'r1' })
  assert.equal(r.location, 'archived')
  assert.equal((await listSessions({ home })).length, 0, '活跃列表不再有该 id（两个分片都被移走）')
  const names = await readdir(layout(home).archivedDir)
  assert.equal(names.length, 2, '两个分片都进了归档目录')
  assert.equal((await findSessionFile(home, 'r1')).location, 'archived')
})

test('目的地重名: 不覆盖归档目录已有文件（前置修订 2）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  const l = layout(home)
  await mkdir(l.archivedDir, { recursive: true })
  const squatter = join(l.archivedDir, 'rollout-2026-05-20T00-00-00-a.jsonl')
  await writeFile(squatter, 'PRE-EXISTING\n')
  const r = await archiveSession({ home, id: 'a' })
  assert.notEqual(r.path, squatter, '重名时换用不冲突的目的名')
  assert.equal(await readFile(squatter, 'utf8'), 'PRE-EXISTING\n', '已有文件未被覆盖')
  await stat(r.path)
})

test('活跃防护: 同一毫秒写入的文件也必须拒绝（审查修正：age 负值夹紧）', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'now', day: '2026-05-20' }) // mtime ≈ now，可能与 Date.now() 同毫秒
  await assert.rejects(() => archiveSession({ home, id: 'now' }), (e) => e.code === 'active')
})
