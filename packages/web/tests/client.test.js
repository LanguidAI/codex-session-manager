import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 客户端首屏分支回归测试。仓库无 jsdom（不加依赖），故用 node:vm + 极简 DOM stub
// 让 app.js 的「缺 token / 401 / 正常 / 加载态」各路径可判别。
const APP_JS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8')

/** 仅实现 app.js 所需的最小元素面；addEventListener 记录监听器以便测试触发。 */
function makeEl() {
  const el = {
    innerHTML: '', textContent: '', className: '', value: '', hidden: false, checked: false,
    dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    _listeners: {},
    addEventListener(ev, fn) { (el._listeners[ev] ??= []).push(fn) },
    click() {},
  }
  return el
}

/** 手动可控的 promise（用于把请求「卡在途中」以观察加载态）。 */
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

/** 触发元素上已注册的监听器。 */
function fire(el, ev, payload) {
  for (const fn of el._listeners[ev] ?? []) fn(payload)
}

/** 在 vm 里跑客户端脚本；返回 stub 元素访问器。flush=false 时不等待微任务（观察在途状态）。 */
async function runApp({ search = '', fetchImpl, store = {}, flush = true } = {}) {
  const els = new Map()
  const el = (sel) => { if (!els.has(sel)) els.set(sel, makeEl()); return els.get(sel) }
  const context = vm.createContext({
    document: { querySelector: el, querySelectorAll: () => [], createElement: makeEl },
    location: { search },
    sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v } },
    fetch: fetchImpl ?? (() => Promise.reject(new Error('fetch stub not provided'))),
    navigator: { clipboard: { writeText: async () => {} } },
    URLSearchParams, setTimeout, clearTimeout, console,
  })
  vm.runInContext(APP_JS, context, { filename: 'app.js' })
  if (flush) await new Promise((r) => setTimeout(r, 0)) // 冲掉 refresh() 的微任务链
  return { el, fire }
}

const listHtml = (el) => String(el('#list').innerHTML ?? '')
const detailHtml = (el) => String(el('#detail').innerHTML ?? '')

const okJson = (data) => ({ ok: true, status: 200, json: async () => data })

test('缺 token：可操作提示常驻渲染进 #list（不是 2.2s 即逝的 toast）', async () => {
  const { el } = await runApp({ search: '' })
  // 判别器：旧代码只调 toast()（#list 恒为空）→ 用户看到「一片空白」；
  // 新代码把指引写进主区域常驻，故 #list 必含 token 指引。
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
  // 判别器：旧代码在途时 #list 为空字符串（用户看到「一片空白」）；
  // 新代码先渲染加载占位。
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
  doFire(el('#list'), 'click', { target: { closest: () => ({ dataset: { id: 'x' } }) } })
  await new Promise((r) => setTimeout(r, 0))
  assert.match(detailHtml(el), /加载/, '详情请求在途时应显示加载提示')
  d.resolve()
})

// ---- #10 源码卫生：死状态字段 ----

test('#10 源码卫生：不再保留只写不读的死状态字段', () => {
  // 实测判定依据（旧代码）：
  //   grep -n "state.sessions" packages/web/public/app.js  → 仅 1 处赋值，无读取
  //   grep -n "state.view"     packages/web/public/app.js  → 仅 1 处赋值，无读取
  assert.doesNotMatch(APP_JS, /state\.sessions/, 'state.sessions 只写不读，应删除')
  assert.doesNotMatch(APP_JS, /state\.view/, 'state.view 只写不读，应删除')
})