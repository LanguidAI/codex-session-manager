import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server.mjs'
import { backdate, makeHome, writeIndex, writeSession } from '../../core/tests/helpers/fixture.js'

async function withServer(home, fn) {
  const { server, token } = createApp({ home, token: 'test-token' })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const api = (path, opts = {}) =>
    fetch(base + path, { ...opts, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...opts.headers } })
  try {
    return await fn({ base, api, raw: (path) => fetch(base + path) })
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('health 无需鉴权；API 无 token 返回 401', async () => {
  const home = await makeHome()
  await withServer(home, async ({ base, raw }) => {
    assert.equal((await raw('/api/health')).status, 200)
    assert.equal((await raw('/api/sessions')).status, 401)
  })
})

test('列表 + 详情 + 重命名 + 归档 + 删除 + 导出 + resume + stats 全链路', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20', userText: '目标A' })
  await backdate(p)
  await writeIndex(home, [{ id: 'a', thread_name: '原名', updated_at: '2026-05-20T12:00:00Z' }])
  await withServer(home, async ({ api }) => {
    // 列表
    let res = await api('/api/sessions')
    assert.equal(res.status, 200)
    let body = await res.json()
    assert.equal(body.sessions.length, 1)
    assert.equal(body.sessions[0].title, '原名')
    // 详情
    res = await api('/api/sessions/a')
    body = await res.json()
    assert.equal(body.session.messages.find((m) => m.role === 'user').text, '目标A')
    // 重命名
    res = await api('/api/sessions/a', { method: 'PATCH', body: JSON.stringify({ title: '新名' }) })
    assert.equal(res.status, 200)
    assert.equal((await (await api('/api/sessions')).json()).sessions[0].title, '新名')
    // 导出
    res = await api('/api/sessions/a/export?fmt=md')
    assert.ok((await res.text()).includes('# 新名'))
    // resume
    res = await api('/api/sessions/a/resume')
    assert.ok((await res.json()).text.includes('目标A'))
    // stats
    res = await api('/api/stats')
    assert.equal((await res.json()).total, 1)
    // 归档 → 活跃列表为空
    res = await api('/api/sessions/a/archive', { method: 'POST', body: '{}' })
    assert.equal(res.status, 200)
    assert.equal((await (await api('/api/sessions')).json()).sessions.length, 0)
    // 删除（对已归档会话）→ 进回收站
    res = await api('/api/sessions/a/delete', { method: 'POST', body: '{}' })
    assert.equal(res.status, 200)
    // 404
    assert.equal((await api('/api/sessions/nope')).status, 404)
  })
})

test('静态页: / 返回 index.html；路径穿越被拒', async () => {
  const home = await makeHome()
  await withServer(home, async ({ raw }) => {
    const res = await raw('/')
    assert.equal(res.status, 200)
    assert.ok((res.headers.get('content-type') ?? '').includes('text/html'))
    const evil = await raw('/../../etc/passwd')
    assert.ok([403, 404].includes(evil.status))
  })
})

test('活跃会话变更返回 409 active', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'fresh', day: '2026-05-20' }) // mtime = now
  await withServer(home, async ({ api }) => {
    const res = await api('/api/sessions/fresh/archive', { method: 'POST', body: '{}' })
    assert.equal(res.status, 409)
    assert.equal((await res.json()).error.code, 'active')
  })
})

test('陈旧 expectedMtimeMs 返回 409 conflict，正确值放行（前置修订 2：乐观并发透传）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 's', day: '2026-05-20' })
  await backdate(p) // 越过活跃窗口，只剩陈旧检测
  await withServer(home, async ({ api }) => {
    const detail = await (await api('/api/sessions/s')).json()
    const realMtime = detail.session.mtimeMs // loadFull 透出的 mtimeMs
    assert.equal(typeof realMtime, 'number')
    // 错误的 expectedMtimeMs → 陈旧冲突
    let res = await api('/api/sessions/s/archive', { method: 'POST', body: JSON.stringify({ expectedMtimeMs: realMtime + 1 }) })
    assert.equal(res.status, 409)
    assert.equal((await res.json()).error.code, 'conflict')
    // 正确的 expectedMtimeMs → 放行
    res = await api('/api/sessions/s/archive', { method: 'POST', body: JSON.stringify({ expectedMtimeMs: realMtime }) })
    assert.equal(res.status, 200)
  })
})

test('title 超长返回 400 invalid（前置修订 3：web 层封顶 MAX_TITLE）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 't', day: '2026-05-20' })
  await backdate(p)
  await withServer(home, async ({ api }) => {
    const res = await api('/api/sessions/t', { method: 'PATCH', body: JSON.stringify({ title: 'x'.repeat(201) }) })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.code, 'invalid')
  })
})

test('malformed JSON body 返回 400 invalid 而非 500（前置修订 4）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'j', day: '2026-05-20' })
  await backdate(p)
  await withServer(home, async ({ api }) => {
    const res = await api('/api/sessions/j', { method: 'PATCH', body: '{not json' })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.code, 'invalid')
  })
})
