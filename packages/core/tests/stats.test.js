import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStats } from '../src/stats.js'
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
