import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 客户端首屏分支回归测试。仓库无 jsdom（不加依赖），故用 node:vm + 极简 DOM stub
// 让 app.js 的「缺 token / 401 / 正常」三条路径可判别。
const APP_JS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8')

/** 仅实现 app.js 加载与首屏分支所需的最小元素面。 */
function makeEl() {
  return {
    innerHTML: '', textContent: '', className: '', value: '', hidden: false, checked: false,
    dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
  }
}

/** 在 vm 里跑客户端脚本，返回 stub 元素表；fetch 由调用方注入。 */
async function runApp({ search = '', fetchImpl, store = {} } = {}) {
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
  await new Promise((r) => setTimeout(r, 0)) // 冲掉 refresh() 的微任务链
  return els
}

const listHtml = (els) => String(els.get('#list')?.innerHTML ?? '')

test('缺 token：可操作提示常驻渲染进 #list（不是 2.2s 即逝的 toast）', async () => {
  const els = await runApp({ search: '' })
  // 判别器：旧代码只调 toast()（#list 恒为空）→ 用户看到「一片空白」；
  // 新代码把指引写进主区域常驻，故 #list 必含 token 指引。
  assert.match(listHtml(els), /token/i, '缺 token 时主区域应有常驻提示，而非只会淡出的 toast')
})

test('token 无效（401）：可操作提示同样常驻可见', async () => {
  const els = await runApp({
    search: '?token=WRONG',
    fetchImpl: async () => ({
      ok: false, status: 401,
      json: async () => ({ error: { code: 'unauthorized', message: 'missing or wrong bearer token' } }),
    }),
  })
  assert.match(listHtml(els), /token/i, '401 也应常驻渲染指引，而不是只闪一下')
})

test('token 有效：正常渲染列表，不出现常驻错误块（回归保护）', async () => {
  const els = await runApp({
    search: '?token=good',
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({
        sessions: [{ id: 'x', title: '会话X', cwd: '/tmp', model: 'm', updatedAt: '2026-01-01T00:00:00Z', size: 2048, archived: false }],
      }),
    }),
  })
  const html = listHtml(els)
  assert.match(html, /会话X/, '有效 token 应正常渲染会话')
  assert.doesNotMatch(html, /fatal/, '正常路径不应出现致命错误块')
})

test('有效 token 写入 sessionStorage，供后续无 ?token= 的同标签页复用（N1 行为保护）', async () => {
  const store = {}
  await runApp({
    search: '?token=good',
    store,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ sessions: [] }) }),
  })
  assert.equal(store['csm-token'], 'good')
})