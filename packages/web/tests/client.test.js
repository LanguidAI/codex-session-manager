import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 客户端回归测试。仓库无 jsdom（不加依赖），故用 node:vm + 极简 DOM stub
// 让 app.js 的首屏分支、在途守卫、下载路径可判别。
const APP_JS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8')

/** 仅实现 app.js 所需的最小元素面；addEventListener 记录监听器以便测试触发。 */
function makeEl() {
  const el = {
    innerHTML: '', textContent: '', className: '', value: '', hidden: false, checked: false,
    dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    _listeners: {},
    addEventListener(ev, fn) { (el._listeners[ev] ??= []).push(fn) },
    click() {}, remove() {},
  }
  return el
}

/** 手动可控的 promise（用于把请求「卡在途中」以观察在途状态）。 */
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

/** 触发元素上已注册的监听器。 */
function fire(el, ev, payload) {
  for (const fn of el._listeners[ev] ?? []) fn(payload)
}

/** 在 vm 里跑客户端脚本。vm 内 setTimeout 被替换为记录器（timers），便于断言「延后执行」。 */
async function runApp({ search = '', fetchImpl, store = {}, flush: doFlush = true, events = [], timers = [] } = {}) {
  const els = new Map()
  const el = (sel) => { if (!els.has(sel)) els.set(sel, makeEl()); return els.get(sel) }
  const calls = []
  const recordingFetch = async (path, opts = {}) => {
    calls.push({ path: String(path), method: opts.method ?? 'GET', body: opts.body })
    return fetchImpl(path, opts)
  }
  const ctx = vm.createContext({
    document: {
      querySelector: el,
      querySelectorAll: () => [],
      createElement: () => {
        const e = makeEl()
        e.click = () => events.push('a.click')
        e.remove = () => events.push('a.remove')
        return e
      },
      body: { appendChild: () => events.push('append') },
    },
    location: { search },
    sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v } },
    fetch: fetchImpl ? recordingFetch : () => Promise.reject(new Error('fetch stub not provided')),
    navigator: { clipboard: { writeText: async () => {} } },
    URL: {
      createObjectURL: () => { events.push('createObjectURL'); return 'blob:x' },
      revokeObjectURL: () => events.push('revoke'),
    },
    URLSearchParams,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: () => {},
    prompt: () => 'NEW',
    confirm: () => true,
    console,
  })
  vm.runInContext(APP_JS, ctx, { filename: 'app.js' })
  const flush = () => new Promise((r) => setTimeout(r, 0)) // 宿主定时器：冲掉微任务链
  if (doFlush) await flush()
  return { el, fire, ctx, flush, calls, events, timers }
}

const listHtml = (el) => String(el('#list').innerHTML ?? '')
const detailHtml = (el) => String(el('#detail').innerHTML ?? '')
const toastText = (el) => String(el('#toast').textContent ?? '')

const okJson = (data) => ({ ok: true, status: 200, json: async () => data })
const clickLi = (fire, el, id) => fire(el('#list'), 'click', { target: { closest: () => ({ dataset: { id } }) } })
const clickAct = (fire, el, act) => fire(el('#detail'), 'click', { target: { closest: () => ({ dataset: { act } }) } })

test('缺 token：可操作提示常驻渲染进 #list（不是 2.2s 即逝的 toast）', async () => {
  const { el } = await runApp({ search: '' })
  // 判别器：修复前只调 toast()（#list 恒为空）→ 用户看到「一片空白」；
  // 修复后把指引写进主区域常驻，故 #list 必含 token 指引。
  assert.match(listHtml(el), /token/i, '缺 token 时主区域应有常驻提示，而非只会淡出的 toast')
})

test('token 无效（401）：可操作提示同样常驻可见', async () => {
  const { el } = await runApp({
    search: '?token=WRONG',
    fetchImpl: async () => ({
      ok: false, status: 401,
      json: async () => ({ error: { code: 'unauthorized', message: 'missing or wrong bearer token' } }),
    }),
  })
  assert.match(listHtml(el), /token/i, '401 也应常驻渲染指引，而不是只闪一下')
})

test('token 有效：正常渲染列表，不出现常驻错误块（回归保护）', async () => {
  const { el } = await runApp({
    search: '?token=good',
    fetchImpl: async () => okJson({
      sessions: [{ id: 'x', title: '会话X', cwd: '/tmp', model: 'm', updatedAt: '2026-01-01T00:00:00Z', size: 2048, archived: false }],
    }),
  })
  const html = listHtml(el)
  assert.match(html, /会话X/, '有效 token 应正常渲染会话')
  assert.doesNotMatch(html, /fatal/, '正常路径不应出现致命错误块')
})

test('有效 token 写入 sessionStorage，供后续无 ?token= 的同标签页复用（N1 行为保护）', async () => {
  const store = {}
  await runApp({ search: '?token=good', store, fetchImpl: async () => okJson({ sessions: [] }) })
  assert.equal(store['csm-token'], 'good')
})

// ---- #1 加载态（N7）：请求在途时不得留白 ----

test('#1 加载态：列表请求在途时主区域显示加载提示，而非空白', async () => {
  const d = deferred()
  const { el } = await runApp({ search: '?token=good', fetchImpl: () => d.promise, flush: false })
  // 判别器：修复前在途时 #list 为空字符串（用户看到「一片空白」）。
  assert.match(listHtml(el), /加载/, '列表请求在途时应显示加载提示')
  d.resolve(okJson({ sessions: [] })) // 收尾，避免悬挂 promise
})

test('#1 加载态：会话详情在途时 #detail 显示加载提示', async () => {
  const d = deferred()
  const { el, fire: doFire } = await runApp({
    search: '?token=good',
    fetchImpl: async (path) => {
      if (String(path).includes('/api/sessions/')) {
        await d.promise
        return okJson({ session: { id: 'x', title: 'X', messages: [], mtimeMs: 1 } })
      }
      return okJson({ sessions: [{ id: 'x', title: 'X', cwd: '/tmp', model: 'm', updatedAt: '2026-01-01T00:00:00Z', size: 1, archived: false }] })
    },
  })
  clickLi(doFire, el, 'x')
  await new Promise((r) => setTimeout(r, 0))
  assert.match(detailHtml(el), /加载/, '详情请求在途时应显示加载提示')
  d.resolve()
})

// ---- #2 在途守卫：迟到响应不得覆盖更晚的选择 ----

test('#2 先点 A（慢）再点 B（快）：A 的迟到响应不得覆盖 B 的面板与选中', async () => {
  const slowA = deferred()
  const { el, fire: doFire, ctx, flush } = await runApp({
    search: '?token=good',
    fetchImpl: async (path) => {
      if (String(path).endsWith('/api/sessions/A')) {
        await slowA.promise
        return okJson({ session: { id: 'A', title: 'DetailA', messages: [], mtimeMs: 111 } })
      }
      if (String(path).endsWith('/api/sessions/B')) {
        return okJson({ session: { id: 'B', title: 'DetailB', messages: [], mtimeMs: 222 } })
      }
      return okJson({ sessions: [] })
    },
  })
  clickLi(doFire, el, 'A') // 慢：故意挂起
  await flush()
  clickLi(doFire, el, 'B') // 快：立即返回
  await flush()
  assert.match(detailHtml(el), /DetailB/, '前置条件：B 已渲染')

  slowA.resolve() // A 迟到
  await flush()

  assert.match(detailHtml(el), /DetailB/, 'B 后点，终态面板应仍是 B')
  assert.doesNotMatch(detailHtml(el), /DetailA/, 'A 的迟到响应不得覆盖 B 的面板')
  assert.equal(vm.runInContext('state.selected', ctx), 'B', '迟到响应不得改写 state.selected')
  assert.equal(vm.runInContext('state.detailMtime', ctx), 222, 'detailMtime 不得被迟到响应污染（否则后续 archive 用错 expectedMtimeMs）')
})

// ---- #3 详情失败回滚 ----

test('#3 详情拉取失败：回滚到上一个会话，不残留载入态、selected 不指向失败 id', async () => {
  const { el, fire: doFire, ctx, calls, flush } = await runApp({
    search: '?token=good',
    fetchImpl: async (path) => {
      if (String(path).endsWith('/api/sessions/A')) return okJson({ session: { id: 'A', title: 'DetailA', messages: [], mtimeMs: 111 } })
      if (String(path).endsWith('/api/sessions/B')) {
        return { ok: false, status: 500, json: async () => ({ error: { message: '读取失败' } }) }
      }
      return okJson({ sessions: [] })
    },
  })
  clickLi(doFire, el, 'A')
  await flush()
  assert.match(detailHtml(el), /DetailA/, '前置条件：A 已渲染')

  clickLi(doFire, el, 'B') // 失败
  await flush()

  assert.match(detailHtml(el), /DetailA/, '失败后应回滚到上一个会话面板，而非停在「加载中…」或空白')
  assert.doesNotMatch(detailHtml(el), /加载中/, '不应残留载入态')
  assert.equal(vm.runInContext('state.selected', ctx), 'A', 'selected 应回滚到 A')

  // 关键后果：此后的 rename 必须作用于 A（修复前 selected 仍为 B，会去改一个读不出来的会话）
  clickAct(doFire, el, 'rename')
  await flush()
  const patch = calls.find((c) => c.method === 'PATCH')
  assert.ok(patch, '应发出 PATCH')
  assert.match(patch.path, /\/api\/sessions\/A$/, 'rename 必须指向回滚后的 A，而不是失败的 B')
})

test('#3 归档成功后：在途的详情响应不得把面板「复活」回已归档会话', async () => {
  const slowA = deferred()
  const { el, fire: doFire, ctx, flush } = await runApp({
    search: '?token=good',
    fetchImpl: async (path, opts = {}) => {
      if (String(path).endsWith('/archive')) return okJson({ location: 'archived' })
      if (String(path).endsWith('/api/sessions/A')) {
        await slowA.promise
        return okJson({ session: { id: 'A', title: 'DetailA', messages: [], mtimeMs: 111 } })
      }
      return okJson({ sessions: [] })
    },
  })
  clickLi(doFire, el, 'A') // 详情在途
  await flush()
  clickAct(doFire, el, 'archive') // 归档成功 → 应清空面板
  await flush()
  assert.equal(vm.runInContext('state.selected', ctx), null, '前置条件：归档后 selected 为 null')

  slowA.resolve() // 详情迟到
  await flush()
  assert.doesNotMatch(detailHtml(el), /DetailA/, '迟到详情不得让已归档会话的面板复活')
  assert.equal(vm.runInContext('state.selected', ctx), null, 'selected 不得被迟到响应改回 A')
})

// ---- #5 download 错误体 ----

test('#5 导出失败：透出服务端错误体，而非只报 HTTP 500', async () => {
  const { el, fire: doFire, flush } = await runApp({
    search: '?token=good',
    fetchImpl: async (path) => {
      if (String(path).includes('/export')) {
        return { ok: false, status: 500, json: async () => ({ error: { code: 'internal', message: '磁盘写入被拒绝' } }) }
      }
      if (String(path).endsWith('/api/sessions/A')) return okJson({ session: { id: 'A', title: 'A', messages: [], mtimeMs: 1 } })
      return okJson({ sessions: [{ id: 'A', title: 'A', cwd: '/tmp', model: 'm', updatedAt: '2026-01-01T00:00:00Z', size: 1, archived: false }] })
    },
  })
  clickLi(doFire, el, 'A')
  await flush()
  clickAct(doFire, el, 'export-md')
  await flush()
  // 判别器：修复前 throw new Error(`HTTP ${res.status}`) → 用户只看到「失败：HTTP 500」
  assert.match(toastText(el), /磁盘写入被拒绝/, '应透出服务端 error.message')
  assert.doesNotMatch(toastText(el), /HTTP 500/, '不应退化成裸状态码')
})

// ---- #6 revokeObjectURL 时序 ----

test('#6 下载后不得同步 revoke blob URL（会取消下载），应延后执行', async () => {
  const events = []
  const timers = []
  const { el, fire: doFire, flush } = await runApp({
    search: '?token=good',
    events,
    timers,
    fetchImpl: async (path) => {
      if (String(path).includes('/export')) {
        return { ok: true, status: 200, blob: async () => ({ size: 1, type: 'text/markdown' }) }
      }
      if (String(path).endsWith('/api/sessions/A')) return okJson({ session: { id: 'A', title: 'A', messages: [], mtimeMs: 1 } })
      return okJson({ sessions: [{ id: 'A', title: 'A', cwd: '/tmp', model: 'm', updatedAt: '2026-01-01T00:00:00Z', size: 1, archived: false }] })
    },
  })
  clickLi(doFire, el, 'A')
  await flush()
  clickAct(doFire, el, 'export-md')
  await flush()

  assert.ok(events.includes('a.click'), '前置条件：已触发下载点击')
  // 判别器：修复前在 a.click() 之后同步 URL.revokeObjectURL(a.href) → 此处已出现 'revoke'。
  assert.ok(!events.includes('revoke'), '不得在同步阶段 revoke（Firefox/Safari 会因此取消下载）')

  for (const t of timers.splice(0)) t.fn() // 执行所有已注册定时器
  assert.ok(events.includes('revoke'), '应通过定时器延后 revoke，避免泄漏 blob URL')
})

test('#3 回滚不得递归：连回滚目标 A 也拉取失败时必须收敛，不得无限重试', async () => {
  let detailCalls = 0
  let aHealthy = true // A 先成功（建立 prev=A），随后服务劣化使 A 也失败
  const { el, fire: doFire, ctx, flush } = await runApp({
    search: '?token=good',
    fetchImpl: async (path) => {
      if (String(path).endsWith('/api/sessions/A')) {
        detailCalls++
        return aHealthy
          ? okJson({ session: { id: 'A', title: '详情A', messages: [], mtimeMs: 111 } })
          : { ok: false, status: 500, json: async () => ({ error: { message: '服务不可用' } }) }
      }
      if (String(path).endsWith('/api/sessions/B')) {
        detailCalls++
        return { ok: false, status: 500, json: async () => ({ error: { message: '服务不可用' } }) }
      }
      return okJson({ sessions: [
        { id: 'A', title: 'A', cwd: '/p', model: 'm', updatedAt: '2026-01-01T00:00:00Z', size: 1, archived: false },
        { id: 'B', title: 'B', cwd: '/p', model: 'm', updatedAt: '2026-01-01T00:00:00Z', size: 1, archived: false },
      ] })
    },
  })
  clickLi(doFire, el, 'A') // 建立 prev=A
  await flush()
  assert.match(detailHtml(el), /详情A/, '前置条件：A 已成功渲染')
  aHealthy = false // 服务劣化
  detailCalls = 0

  clickLi(doFire, el, 'B') // 失败 → 触发回滚到 A → A 也失败 → 必须收敛
  await flush()
  await flush()
  await flush()
  assert.ok(detailCalls <= 2, `详情请求次数应有限（实际 ${detailCalls}），不得递归回滚 A→B→A…`)
  assert.doesNotMatch(detailHtml(el), /加载中/, '最终不应停在载入态')
  assert.equal(vm.runInContext('state.selected', ctx), null, '无可用会话时应清空选中，而非指向读不出的 id')
})

// ---- #10 源码卫生：死状态字段 ----

test('#10 源码卫生：不再保留只写不读的死状态字段', () => {
  // 实测判定依据（修复前）：
  //   grep -n "state.sessions" packages/web/public/app.js  → 仅 1 处赋值，无读取
  //   grep -n "state.view"     packages/web/public/app.js  → 仅 1 处赋值，无读取
  assert.doesNotMatch(APP_JS, /state\.sessions/, 'state.sessions 只写不读，应删除')
  assert.doesNotMatch(APP_JS, /state\.view/, 'state.view 只写不读，应删除')
})