import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fastMeta } from './reader.js'
import { layout } from './paths.js'
import { parseIsoMs } from './dates.js'

/** 读 session_index.jsonl → Map<id, {title, updatedAt}>；同 id 后行覆盖前行；非字符串 updated_at 视为无。 */
export async function readIndex(home) {
  const map = new Map()
  let content
  try {
    content = await readFile(layout(home).index, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return map
    throw e
  }
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue
    let entry
    try { entry = JSON.parse(raw) } catch { continue }
    if (typeof entry?.id === 'string') {
      map.set(entry.id, {
        title: entry.thread_name ?? null,
        updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : null,
      })
    }
  }
  return map
}

/**
 * 递归遍历目录下所有 .jsonl 文件；目录不存在（ENOENT）时产出空。
 * 其他目录级错误（如 EACCES）上抛——失败要响亮，不静默缺会话。
 * 符号链接目录/文件不跟随（Dirent.isDirectory/isFile 对 symlink 均为 false）。
 */
async function* walkJsonl(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return
    throw e
  }
  for (const ent of entries) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) yield* walkJsonl(p)
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) yield p
  }
}

/** 文件系统级错误（带 .code：ENOENT/EACCES/EMFILE/ELOOP 等）可按文件跳过；编程错误上抛，避免静默吞 bug。 */
function isFsError(e) {
  return typeof e?.code === 'string'
}

/**
 * 列出会话（索引标题 + 磁盘元数据合并，磁盘为准）。
 * 审查修订：同 id（resume 分片）去重保留 mtime 最新记录；
 * updatedAt 取索引时间与 mtime 的较新者（索引不因 resume 刷新，不能遮蔽磁盘活动）；
 * 排序用数值时间戳（索引小数精度不齐，字符串比较不可靠）。
 * @returns {Promise<Array>} 按 updatedAt 倒序的会话摘要
 */
export async function listSessions({ home, q, cwd, model, includeArchived = false } = {}) {
  const l = layout(home)
  const index = await readIndex(home)
  const dirs = includeArchived
    ? [[l.sessionsDir, false], [l.archivedDir, true]]
    : [[l.sessionsDir, false]]
  const byId = new Map()
  for (const [dir, archived] of dirs) {
    for await (const p of walkJsonl(dir)) {
      // 单文件读取失败（扫描期间被 Codex 删除/权限/符号链接环等）跳过，不打断整个列表（审查修订）
      let meta
      let st
      try {
        meta = await fastMeta(p)
        st = await stat(p)
      } catch (e) {
        if (isFsError(e)) continue
        throw e
      }
      if (!meta.id) continue
      const idx = index.get(meta.id)
      const idxMs = parseIsoMs(idx?.updatedAt) // I-2：严格 ISO 形状；宽松格式（2026/01/01）不再冒充 updatedAt，回落文件 mtime
      const useIndex = Number.isFinite(idxMs) && idxMs > st.mtimeMs
      const rec = {
        id: meta.id,
        title: idx?.title ?? '(未命名)',
        cwd: meta.cwd,
        provider: meta.provider,
        model: meta.model,
        createdAt: meta.createdAt,
        updatedAt: useIndex ? idx.updatedAt : st.mtime.toISOString(),
        size: st.size,
        archived,
        path: p,
        // 内部字段（返回前删除）：排序用数值时间戳、去重/较新比较用 mtime
        sortMs: useIndex ? idxMs : st.mtimeMs,
        mtimeMs: st.mtimeMs,
      }
      if (q) {
        const needle = String(q).toLowerCase()
        const hit = [rec.title, rec.id, rec.cwd ?? ''].some((f) => String(f).toLowerCase().includes(needle))
        if (!hit) continue
      }
      if (cwd && !(rec.cwd ?? '').toLowerCase().includes(String(cwd).toLowerCase())) continue
      if (model && rec.model !== model) continue
      const prev = byId.get(rec.id)
      if (!prev || rec.mtimeMs > prev.mtimeMs) byId.set(rec.id, rec)
    }
  }
  const out = [...byId.values()]
  out.sort((a, b) => b.sortMs - a.sortMs)
  for (const rec of out) {
    delete rec.sortMs
    delete rec.mtimeMs
  }
  return out
}

/**
 * 按 id 找出全部文件（含 resume 分片），按 location 优先级（active > archived > trash）分组、
 * 组内按 mtime 降序。首元素与 findSessionFile 的返回语义一致。
 * @returns {Promise<Array<{path: string, location: 'active'|'archived'|'trash', mtimeMs: number, size: number}>>}
 */
export async function findSessionFiles(home, id) {
  if (typeof id !== 'string' || id === '') return []
  const l = layout(home)
  const out = []
  for (const [dir, location] of [[l.sessionsDir, 'active'], [l.archivedDir, 'archived'], [l.trashDir, 'trash']]) {
    const group = []
    for await (const p of walkJsonl(dir)) {
      if (!basename(p).includes(id)) continue
      // 单文件读取失败跳过继续找（审查修订）
      try {
        const meta = await fastMeta(p)
        if (meta.id !== id) continue
        const st = await stat(p)
        group.push({ path: p, location, mtimeMs: st.mtimeMs, size: st.size })
      } catch (e) {
        if (isFsError(e)) continue
        throw e
      }
    }
    group.sort((a, b) => b.mtimeMs - a.mtimeMs)
    out.push(...group)
  }
  return out
}

/**
 * 按 id 定位会话文件；文件名含 id 才打开解析（性能护栏）。
 * 同 id 多文件（resume 分片）返回优先级最高 location 中 mtime 最新者。
 * @returns {Promise<null | {path: string, location: 'active'|'archived'|'trash', mtimeMs: number, size: number}>}
 */
export async function findSessionFile(home, id) {
  const matches = await findSessionFiles(home, id)
  return matches.length > 0 ? matches[0] : null
}
