import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fastMeta } from './reader.js'
import { layout } from './paths.js'

/** 读 session_index.jsonl → Map<id, {title, updatedAt}>；同 id 后行覆盖前行。 */
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
      map.set(entry.id, { title: entry.thread_name ?? null, updatedAt: entry.updated_at ?? null })
    }
  }
  return map
}

/** 递归遍历目录下所有 .jsonl 文件；目录不存在时产出空。 */
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

/**
 * 列出会话（索引标题 + 磁盘元数据合并，磁盘为准）。
 * @returns {Promise<Array>} 按 updatedAt 倒序的会话摘要
 */
export async function listSessions({ home, q, cwd, model, includeArchived = false } = {}) {
  const l = layout(home)
  const index = await readIndex(home)
  const dirs = includeArchived
    ? [[l.sessionsDir, false], [l.archivedDir, true]]
    : [[l.sessionsDir, false]]
  const out = []
  for (const [dir, archived] of dirs) {
    for await (const p of walkJsonl(dir)) {
      // 单文件读取失败（扫描期间被 Codex 删除/权限/符号链接环等）跳过，不打断整个列表（审查修订）
      let meta
      let st
      try {
        meta = await fastMeta(p)
        st = await stat(p)
      } catch { continue }
      if (!meta.id) continue
      const idx = index.get(meta.id)
      const rec = {
        id: meta.id,
        title: idx?.title ?? '(未命名)',
        cwd: meta.cwd,
        provider: meta.provider,
        model: meta.model,
        createdAt: meta.createdAt,
        updatedAt: idx?.updatedAt ?? st.mtime.toISOString(),
        size: st.size,
        archived,
        path: p,
      }
      if (q && !`${rec.title} ${rec.id} ${rec.cwd ?? ''}`.toLowerCase().includes(String(q).toLowerCase())) continue
      if (cwd && !(rec.cwd ?? '').includes(cwd)) continue
      if (model && rec.model !== model) continue
      out.push(rec)
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  return out
}

/**
 * 按 id 定位会话文件；文件名含 id 才打开解析（性能护栏）。
 * @returns {Promise<null | {path: string, location: 'active'|'archived'|'trash', mtimeMs: number, size: number}>}
 */
export async function findSessionFile(home, id) {
  const l = layout(home)
  for (const [dir, location] of [[l.sessionsDir, 'active'], [l.archivedDir, 'archived'], [l.trashDir, 'trash']]) {
    for await (const p of walkJsonl(dir)) {
      if (!basename(p).includes(id)) continue
      // 单文件读取失败跳过继续找（审查修订）
      try {
        const meta = await fastMeta(p)
        if (meta.id !== id) continue
        const st = await stat(p)
        return { path: p, location, mtimeMs: st.mtimeMs, size: st.size }
      } catch { continue }
    }
  }
  return null
}
