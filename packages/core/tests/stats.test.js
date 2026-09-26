import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildStats } from '../src/stats.js'
import { archiveSession } from '../src/mutate.js'
import { backdate, makeHome, writeIndex, writeSession } from './helpers/fixture.js'

test('buildStats: 按天/项目/模型/供应商聚合', async () => {
  const home = await makeHome()
  const pa = await writeSession(home, { id: 'a', day: '2026-05-20', cwd: '/p1', model: 'gpt-5.5' })
  const pb = await writeSession(home, { id: 'b', day: '2026-05-20', cwd: '/p1', model: 'gpt-5.6' })
  const pc = await writeSession(home, { id: 'c', day: '2026-05-21', cwd: '/p2', model: 'gpt-5.5' })
  // 关键：backdate 到目标日期，否则 mtime=now 会经 max() 覆盖索引时间，byDay 落到今天（前置修订 1）
  await backdate(pa, Date.now() - Date.parse('2026-05-20T12:00:00Z'))
  await backdate(pb, Date.now() - Date.parse('2026-05-20T13:00:00Z'))
  await backdate(pc, Date.now() - Date.parse('2026-05-21T13:00:00Z'))
  await writeIndex(home, [
    { id: 'a', thread_name: 'A', updated_at: '2026-05-20T12:00:00Z' },
    { id: 'b', thread_name: 'B', updated_at: '2026-05-20T13:00:00Z' },
    { id: 'c', thread_name: 'C', updated_at: '2026-05-21T13:00:00Z' },
  ])
  const s = await buildStats({ home })
  assert.equal(s.total, 3)
  assert.equal(s.archived, 0)
  assert.equal(s.byDay['2026-05-20'], 2)
  assert.equal(s.byDay['2026-05-21'], 1)
  assert.equal(s.byProject['/p1'], 2)
  assert.equal(s.byModel['gpt-5.5'], 2)
  assert.equal(s.byProvider['azure'], 3)
})

test('buildStats: recent7 只计近 7 天更新的会话（前置修订 3）', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'r', day: '2026-05-20' }) // mtime = now → 近 7 天内
  const pOld = await writeSession(home, { id: 'o', day: '2026-05-20' })
  await backdate(pOld, Date.now() - Date.parse('2026-05-20T12:00:00Z')) // 远期
  const s = await buildStats({ home })
  assert.equal(s.total, 2)
  assert.equal(s.recent7, 1, '仅未 backdate 者（mtime=now）在近 7 天内')
})

test('buildStats: archived 计入 archived、不进入 total 与 by* 分布（审查缺口 1）', async () => {
  const home = await makeHome()
  const pActive = await writeSession(home, { id: 'act', day: '2026-05-20', cwd: '/p1', model: 'gpt-5.5' })
  await backdate(pActive, Date.now() - Date.parse('2026-05-20T12:00:00Z'))
  const pArch = await writeSession(home, { id: 'arch', day: '2026-05-21', cwd: '/p2', model: 'gpt-9.9' })
  await backdate(pArch, Date.now() - Date.parse('2026-05-21T12:00:00Z'))
  await archiveSession({ home, id: 'arch' }) // 已 backdate，越过活跃防护
  const s = await buildStats({ home })
  assert.equal(s.total, 1, 'total 只计 active')
  assert.equal(s.archived, 1)
  assert.equal(s.byProject['/p1'], 1)
  assert.ok(!('/p2' in s.byProject), 'archived 的 cwd 不进入 byProject')
  assert.ok(!('gpt-9.9' in s.byModel), 'archived 的 model 不进入 byModel')
  assert.ok(!('2026-05-21' in s.byDay), 'archived 的日期不进入 byDay')
})

test('buildStats: model 缺失（无 turn_context）的会话被 byModel 跳过（审查 Issue 3/缺口 2）', async () => {
  const home = await makeHome()
  const pOk = await writeSession(home, { id: 'ok', day: '2026-05-20', model: 'gpt-5.5' })
  await backdate(pOk, Date.now() - Date.parse('2026-05-20T12:00:00Z'))
  // 手写一个无 turn_context 的会话文件 → fastMeta 读不到 model → null
  const dir = join(home, 'sessions', '2026', '05', '20')
  await mkdir(dir, { recursive: true })
  const pNoModel = join(dir, 'rollout-2026-05-20T00-00-00-nomodel.jsonl')
  await writeFile(pNoModel, JSON.stringify({ timestamp: '2026-05-20T12:00:00Z', ordinal: 0, type: 'session_meta', payload: { id: 'nomodel', session_id: 'nomodel', cwd: '/p1', model_provider: 'azure' } }) + '\n')
  await backdate(pNoModel, Date.now() - Date.parse('2026-05-20T12:00:00Z'))
  const s = await buildStats({ home })
  assert.equal(s.total, 2)
  assert.equal(s.byModel['gpt-5.5'], 1)
  assert.ok(!('nomodel' in s.byModel))
  assert.equal(Object.values(s.byModel).reduce((a, b) => a + b, 0), 1, 'byModel 之和 < total（null model 被跳过）')
  assert.equal(s.byProvider['azure'], 2, 'provider 仍计（session_meta 里有 model_provider）')
})

test('buildStats: 空 home 返回全零与空分布（审查缺口 3）', async () => {
  const home = await makeHome()
  const s = await buildStats({ home })
  assert.equal(s.total, 0)
  assert.equal(s.archived, 0)
  assert.equal(s.recent7, 0)
  for (const m of [s.byDay, s.byProject, s.byModel, s.byProvider]) {
    assert.equal(Object.keys(m).length, 0)
  }
})

test('buildStats: byDay 键按日期倒序（最近在前），供 Task 9 日期窗口渲染（审查缺口 4）', async () => {
  const home = await makeHome()
  const p1 = await writeSession(home, { id: 'd1', day: '2026-05-20' })
  await backdate(p1, Date.now() - Date.parse('2026-05-20T12:00:00Z'))
  const p2 = await writeSession(home, { id: 'd2', day: '2026-05-22' })
  await backdate(p2, Date.now() - Date.parse('2026-05-22T12:00:00Z'))
  const p3 = await writeSession(home, { id: 'd3', day: '2026-05-21' })
  await backdate(p3, Date.now() - Date.parse('2026-05-21T12:00:00Z'))
  const s = await buildStats({ home })
  assert.deepEqual(Object.keys(s.byDay), ['2026-05-22', '2026-05-21', '2026-05-20'], 'byDay 键最近在前')
})

test('buildStats: 对抗性键不污染计数（审查 Issue 2：null 原型）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'evil', day: '2026-05-20', cwd: 'constructor' })
  await backdate(p, Date.now() - Date.parse('2026-05-20T12:00:00Z'))
  const s = await buildStats({ home })
  assert.equal(s.byProject['constructor'], 1, 'constructor 作为普通键计 1，而非继承的函数')
  assert.equal(typeof s.byProject['constructor'], 'number')
})
