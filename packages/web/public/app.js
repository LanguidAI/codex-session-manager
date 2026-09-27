const params = new URLSearchParams(location.search)
const token = params.get('token') ?? sessionStorage.getItem('csm-token') // N1：URL 新 token 优先于 sessionStorage 旧 token（服务重启后旧标签打开新 ?token= URL 不再首屏 401）
if (params.get('token')) sessionStorage.setItem('csm-token', params.get('token'))

const $ = (sel) => document.querySelector(sel)
const state = { sessions: [], selected: null, view: 'sessions', all: [], detailMtime: null }

function toast(msg, isErr = false) {
  const el = $('#toast')
  el.textContent = msg
  el.className = `show${isErr ? ' err' : ''}`
  setTimeout(() => (el.className = ''), 2200)
}

// 常驻错误块：token 缺失 / API 失败时渲染进主区域（列表位），不再靠 2.2s 即淡出的 toast
// ——否则用户看到的是「一片空白」，最该看到的排查指引恰好最短命。
function fatal(title, message, hint) {
  $('#count').textContent = ''
  $('#list').innerHTML = `<li class="fatal"><div class="t">${esc(title)}</div><div class="m">${esc(message)}</div>${hint ? `<div class="m hint">${esc(hint)}</div>` : ''}</li>`
  $('#detail').innerHTML = '<p class="empty">无法加载会话列表，请先解决左侧提示</p>'
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...opts.headers },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error?.message ?? `HTTP ${res.status}`)
    err.code = data.error?.code
    throw err
  }
  return data
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtTime = (iso) => esc(iso ? String(iso).replace('T', ' ').slice(0, 16) : '?') // I-1：输出转义，杜绝构造 timestamp 注入 <svg onload>/<iframe srcdoc> 的存储型 XSS；String() 兼修数字 timestamp（N2）
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)

// 一次拉全量（含归档）缓存到客户端；模型下拉从全量填一次（修复旧版从过滤结果重填、选中某模型后下拉只剩该模型的 bug）。
// 列表需全语料 fastMeta 扫描（真实 ~0.9–1.3s，见 Task 8 审查），故过滤一律走客户端、瞬时完成，不再每次往返服务端。
async function refresh() {
  const { sessions } = await api('/api/sessions?archived=1')
  state.all = sessions
  const models = [...new Set(sessions.map((s) => s.model).filter(Boolean))].sort()
  const sel = $('#model')
  const cur = sel.value
  sel.innerHTML = '<option value="">全部模型</option>' + models.map((m) => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('')
}

// 客户端过滤（语义与 core listSessions 一致：q=标题/ID/项目小写子串、cwd=小写子串、model=精确、archived=含归档）。
function renderList() {
  const q = $('#q').value.trim().toLowerCase()
  const cwd = $('#cwd').value.trim().toLowerCase()
  const model = $('#model').value
  const showArchived = $('#archived').checked
  const sessions = state.all.filter((s) => {
    if (!showArchived && s.archived) return false
    if (model && s.model !== model) return false
    if (cwd && !(s.cwd ?? '').toLowerCase().includes(cwd)) return false
    if (q && ![s.title, s.id, s.cwd ?? ''].some((f) => String(f).toLowerCase().includes(q))) return false
    return true
  })
  state.sessions = sessions
  $('#count').textContent = `${sessions.length} 个会话`
  $('#list').innerHTML = sessions.map((s) => `
    <li data-id="${esc(s.id)}" class="${state.selected === s.id ? 'sel' : ''}">
      <div class="t">${esc(s.title)}</div>
      <div class="m">
        <span>${fmtTime(s.updatedAt)}</span>
        <span>${esc(s.model ?? '?')}</span>
        <span>${esc(s.cwd ?? '')}</span>
        <span>${fmtSize(s.size)}</span>
        ${s.archived ? '<span class="badge arch">已归档</span>' : ''}
      </div>
    </li>`).join('') || '<li>无匹配会话</li>'
}

async function selectSession(id) {
  state.selected = id
  document.querySelectorAll('#list li').forEach((li) => li.classList.toggle('sel', li.dataset.id === id))
  const { session: s } = await api(`/api/sessions/${encodeURIComponent(id)}`)
  state.detailMtime = s.mtimeMs // 乐观并发：archive/delete 回填 expectedMtimeMs（Task 8 I7）
  $('#detail').innerHTML = `
    <h2>${esc(s.title ?? '(未命名)')}</h2>
    <div class="meta">ID: ${esc(s.id)} · ${esc(s.cwd ?? '?')} · ${esc(s.model ?? '?')} (${esc(s.provider ?? '?')}) · ${fmtTime(s.createdAt)} → ${fmtTime(s.updatedAt)} · tokens: ${s.tokens ?? '?'}</div>
    <div class="actions">
      <button data-act="rename">✏️ 重命名</button>
      <button data-act="resume">📋 复制恢复上下文</button>
      <button data-act="export-md">⬇️ 导出 MD</button>
      <button data-act="export-json">⬇️ 导出 JSON</button>
      ${s.archived ? '' : '<button data-act="archive">📦 归档</button>'}
      <button data-act="delete" class="danger">🗑️ 删除（进回收站）</button>
    </div>
    ${s.messages.map((m) => `<div class="msg ${m.role}"><div class="who">${m.role === 'user' ? '🧑 用户' : '🤖 助手'} · ${fmtTime(m.timestamp)}</div><pre>${esc(m.text)}</pre></div>`).join('')}`
}

async function download(path, filename) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const blob = await res.blob()
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename })
  a.click()
  URL.revokeObjectURL(a.href)
}

$('#detail').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]')
  if (!btn) return
  const id = state.selected
  const act = btn.dataset.act
  try {
    if (act === 'rename') {
      const title = prompt('新标题：')
      if (!title) return
      await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) })
      toast('已重命名')
      await refresh()
      renderList()
      await selectSession(id)
    } else if (act === 'resume') {
      const { text } = await api(`/api/sessions/${encodeURIComponent(id)}/resume`)
      await navigator.clipboard.writeText(text)
      toast('恢复上下文已复制，去 Codex 新建对话粘贴即可')
    } else if (act === 'export-md') {
      await download(`/api/sessions/${encodeURIComponent(id)}/export?fmt=md`, `${id}.md`)
    } else if (act === 'export-json') {
      await download(`/api/sessions/${encodeURIComponent(id)}/export?fmt=json`, `${id}.json`)
    } else if (act === 'archive') {
      if (!confirm('归档该会话？（移入 archived_sessions，可手动移回）')) return
      await api(`/api/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify({ expectedMtimeMs: state.detailMtime }) })
      toast('已归档')
      state.selected = null
      $('#detail').innerHTML = '<p class="empty">选择左侧会话查看详情</p>'
      await refresh()
      renderList()
    } else if (act === 'delete') {
      if (!confirm('删除该会话？（软删除：移入 .csm-trash 并先备份，不会物理删除）')) return
      await api(`/api/sessions/${encodeURIComponent(id)}/delete`, { method: 'POST', body: JSON.stringify({ expectedMtimeMs: state.detailMtime }) })
      toast('已移入回收站')
      state.selected = null
      $('#detail').innerHTML = '<p class="empty">选择左侧会话查看详情</p>'
      await refresh()
      renderList()
    }
  } catch (e) {
    const msg = e.code === 'active' ? '会话正被 Codex 使用中，稍后再试'
      : e.code === 'conflict' ? '会话自读取后已变化，请重新选择后再试'
      : `失败：${e.message}`
    toast(msg, true)
  }
})

$('#list').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-id]')
  if (li) selectSession(li.dataset.id).catch((e) => toast(e.message, true))
})

// 过滤一律客户端（renderList 同步瞬时），不再 debounce/服务端往返
for (const sel of ['#q', '#cwd', '#model', '#archived']) {
  $(sel).addEventListener(sel === '#model' || sel === '#archived' ? 'change' : 'input', () => renderList())
}

async function loadStats() {
  const s = await api('/api/stats')
  const rows = (obj, limit = 10) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, limit)
      .map(([k, v]) => `<div class="row"><span>${esc(k)}</span><b>${v}</b></div>`).join('')
  // byDay 是时间序列：按日期键降序取最近 N 天（勿按计数排序，否则"最近 14 天"变成"最忙 14 天"——Task 7 Issue 1）
  const dayRows = (obj, limit = 14) =>
    Object.entries(obj).sort((a, b) => b[0].localeCompare(a[0])).slice(0, limit)
      .map(([k, v]) => `<div class="row"><span>${esc(k)}</span><b>${v}</b></div>`).join('')
  $('#view-stats').innerHTML = `
    <div class="cards">
      <div class="card"><b>${s.total}</b><span>活跃会话</span></div>
      <div class="card"><b>${s.archived}</b><span>已归档</span></div>
      <div class="card"><b>${s.recent7}</b><span>近 7 天活跃</span></div>
    </div>
    <div class="grid">
      <div class="box"><h3>按项目目录</h3>${rows(s.byProject)}</div>
      <div class="box"><h3>按模型</h3>${rows(s.byModel)}</div>
      <div class="box"><h3>按供应商</h3>${rows(s.byProvider)}</div>
      <div class="box"><h3>按日期（最近 14 天）</h3>${dayRows(s.byDay, 14)}</div>
    </div>`
}

function switchView(view) {
  state.view = view
  $('#tab-sessions').classList.toggle('active', view === 'sessions')
  $('#tab-stats').classList.toggle('active', view === 'stats')
  $('#view-sessions').hidden = view !== 'sessions'
  $('#view-stats').hidden = view !== 'stats'
  if (view === 'stats') loadStats().catch((e) => toast(e.message, true))
}
$('#tab-sessions').addEventListener('click', () => switchView('sessions'))
$('#tab-stats').addEventListener('click', () => switchView('stats'))

if (!token) {
  // 常驻指引（含如何重拿 token），不再只弹 2.2s 即逝的 toast
  fatal('缺少访问令牌', 'URL 里没有 ?token= 参数，因此无法读取会话列表。',
    '请使用服务启动时终端打印的完整地址打开，例如：http://127.0.0.1:4173/?token=<你的 token>；也可以用固定 token 启动：CSM_TOKEN=mytoken npm run web')
} else {
  refresh().then(renderList).catch((e) => {
    if (e.code === 'unauthorized') {
      fatal('访问令牌无效', '服务拒绝了本次请求（401）。', 'token 可能已过期（服务重启后会重新随机生成）。请用启动时打印的完整地址重开，或用固定 token 启动：CSM_TOKEN=mytoken npm run web')
    } else {
      fatal('加载失败', e.message ?? '未知错误', '请确认服务仍在运行，并查看终端输出。')
    }
    toast(e.message, true)
  })
}
