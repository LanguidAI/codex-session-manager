import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
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

test('畸形请求目标不致服务崩溃（审查 I1：new URL 入 try）', async () => {
  const home = await makeHome()
  await withServer(home, async ({ base, raw }) => {
    const port = Number(new URL(base).port)
    // 裸 socket 发送畸形绝对形式请求目标：llhttp 接受，但 new URL('http://[::1') 会抛（未闭合 IPv6）
    await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET http://[::1 HTTP/1.1\r\nHost: x\r\n\r\n')
      })
      sock.on('data', () => {}) // 读取（可能是 400 响应）后丢弃
      sock.on('close', resolve)
      sock.on('error', resolve)
      setTimeout(resolve, 500)
    })
    // 服务必须仍存活：后续正常请求 200（修复前该畸形请求会让进程崩溃 → 此处连接被拒）
    const health = await raw('/api/health')
    assert.equal(health.status, 200, '服务未因畸形请求目标崩溃')
  })
})

test('null body（合法 JSON）返回 400 invalid 而非 500（审查 I2）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'n', day: '2026-05-20' })
  await backdate(p)
  await withServer(home, async ({ api }) => {
    const res = await api('/api/sessions/n', { method: 'PATCH', body: 'null' })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.code, 'invalid')
  })
})

test('非法百分号编码 id 返回 400 invalid 而非 500（审查 I3）', async () => {
  const home = await makeHome()
  await withServer(home, async ({ api }) => {
    const res = await api('/api/sessions/%zz')
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.code, 'invalid')
  })
})

test('无标题会话 detail title=null（与 list 的 (未命名) 对齐，审查 I6）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'notitle', day: '2026-05-20' })
  await backdate(p)
  // 不写 index → 无标题
  await withServer(home, async ({ api }) => {
    const detail = await (await api('/api/sessions/notitle')).json()
    assert.equal(detail.session.title, null, 'detail 对无标题返回 null，Task 9 统一渲染 (未命名)')
    const list = await (await api('/api/sessions')).json()
    assert.equal(list.sessions[0].title, '(未命名)', 'list 用 (未命名)')
  })
})

// ---- #12 readBody 体积上限 ----

/** 用裸 socket 发请求：可伪造 Content-Length 而不真发 11MB body（fetch 无法可靠覆盖该头部）。 */
function rawRequest(port, headers, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1')
    let buf = ''
    const done = (v) => { sock.destroy(); resolve(v) }
    sock.setTimeout(timeoutMs, () => { sock.destroy(); resolve({ status: null, raw: buf, timedOut: true }) })
    sock.on('connect', () => sock.write(headers))
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      if (/\r\n\r\n/.test(buf)) done({ status: Number(buf.slice(9, 12)), raw: buf })
    })
    sock.on('error', reject)
  })
}

test('#12 Content-Length 超限：立即 413，不缓冲请求体（防无界 RSS 增长）', async () => {
  const home = await makeHome()
  await withServer(home, async ({ base }) => {
    const port = Number(new URL(base).port)
    // 声明 20MB 但一个字节也不发：若服务端先缓冲再判断，会一直等 body → timedOut
    const res = await rawRequest(port,
      'PATCH /api/sessions/x HTTP/1.1\r\n' +
      'Host: 127.0.0.1\r\n' +
      'Authorization: Bearer test-token\r\n' +
      'Content-Type: application/json\r\n' +
      'Content-Length: 20000000\r\n' +
      '\r\n')
    assert.equal(res.status, 413, `应依据 Content-Length 预检直接 413（实际 ${res.status}${res.timedOut ? '/超时=仍在等待 body' : ''}）`)
    assert.match(res.raw, /too_large|too large|过大/i, '错误码应表明体积超限')
  })
})

test('#12 正常小请求体不受影响（回归保护）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  await withServer(home, async ({ api }) => {
    const res = await api('/api/sessions/a', { method: 'PATCH', body: JSON.stringify({ title: '新标题' }) })
    assert.equal(res.status, 200, '常规 PATCH 不应被体积限制误伤')
    assert.equal((await res.json()).title, '新标题')
  })
})

test('#12 varint 式超大 content-length（>Number.MAX_SAFE_INTEGER）不得绕过或崩服务', async () => {
  const home = await makeHome()
  await withServer(home, async ({ base }) => {
    const port = Number(new URL(base).port)
    const res = await rawRequest(port,
      'PATCH /api/sessions/x HTTP/1.1\r\n' +
      'Host: 127.0.0.1\r\n' +
      'Authorization: Bearer test-token\r\n' +
      'Content-Type: application/json\r\n' +
      'Content-Length: 99999999999999999999\r\n' +
      '\r\n')
    assert.ok(res.status === 413 || res.status === 400, `应拒绝超大声明（实际 ${res.status}）`)
  })
})
