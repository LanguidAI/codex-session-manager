import { randomBytes } from 'node:crypto'
import { appendFile, copyFile, mkdir, rename as fsRename, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { findSessionFiles } from './catalog.js'
import { CsmError } from './errors.js'
import { layout } from './paths.js'

/** 距上次写入不足该窗口的会话视为“正在使用”，默认拒绝变更。 */
const ACTIVE_WINDOW_MS = 30_000

/** 备份目录名：时间戳 + 随机后缀，避免同一毫秒内两次变更的备份互相覆盖（前置修订 3）。 */
function backupDirName() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`
}

/** 把文件备份到 .csm-backups/<时间戳-随机>/ 下，返回备份路径。 */
async function backupFile(home, filePath) {
  const dir = join(layout(home).backupsDir, backupDirName())
  await mkdir(dir, { recursive: true })
  const dest = join(dir, basename(filePath))
  await copyFile(filePath, dest)
  return dest
}

/** 防碰撞目的名：目标已存在时在扩展名前插入 -<毫秒时间戳>-<序号>，绝不覆盖已有文件（前置修订 2）。 */
async function uniqueDest(dir, filePath) {
  const base = basename(filePath)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  let dest = join(dir, base)
  for (let i = 1; ; i++) {
    try {
      await stat(dest)
      dest = join(dir, `${stem}-${Date.now()}-${i}${ext}`)
    } catch {
      return dest
    }
  }
}

/** 移动前防护：mtime 与读取时不符 → conflict；30s 内活跃写入 → active（force 越过）。 */
async function guardMovable(filePath, { force, expectedMtimeMs } = {}) {
  const st = await stat(filePath)
  if (expectedMtimeMs !== undefined && st.mtimeMs !== expectedMtimeMs) {
    throw new CsmError('conflict', `session file changed since read (expected mtime ${expectedMtimeMs}, got ${st.mtimeMs})`)
  }
  const age = Date.now() - st.mtimeMs
  if (!force && age >= 0 && age < ACTIVE_WINDOW_MS) {
    throw new CsmError('active', `会话 ${Math.round(age / 1000)} 秒前仍在写入，可能正被 Codex 使用；确认后可用 force=true 强制`)
  }
  return st
}

/** 重命名：向 session_index.jsonl 追加新行（后行生效语义），追加前备份索引。 */
export async function renameSession({ home, id, title }) {
  const t = typeof title === 'string' ? title.trim() : ''
  if (!t) throw new CsmError('invalid', 'title is required')
  const matches = await findSessionFiles(home, id)
  if (matches.length === 0) throw new CsmError('not_found', `session ${id} not found`)
  const l = layout(home)
  try {
    await stat(l.index)
    await backupFile(home, l.index)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  await appendFile(l.index, JSON.stringify({ id, thread_name: t, updated_at: new Date().toISOString() }) + '\n')
  return { id, title: t }
}

/** 归档：把会话的全部分片文件移入官方 archived_sessions/（与 Desktop 行为一致），逐个先备份。 */
export async function archiveSession({ home, id, force, expectedMtimeMs }) {
  return moveSession({ home, id, force, expectedMtimeMs, to: 'archived' })
}

/** 删除：软删除，把会话的全部分片文件移入 .csm-trash/（绝不物理删除），逐个先备份。 */
export async function deleteSession({ home, id, force, expectedMtimeMs }) {
  return moveSession({ home, id, force, expectedMtimeMs, to: 'trash' })
}

/**
 * 共享移动逻辑：定位全部匹配 → location 校验 → 逐文件防护/备份/防碰撞移动。
 * expectedMtimeMs 只约束主文件（UI/工具读到的那个），其余分片只做活跃防护（前置修订 1）。
 */
async function moveSession({ home, id, force, expectedMtimeMs, to }) {
  const l = layout(home)
  const matches = await findSessionFiles(home, id)
  if (matches.length === 0) throw new CsmError('not_found', `session ${id} not found`)
  const primary = matches[0]
  if (to === 'archived' && primary.location !== 'active') {
    throw new CsmError('invalid', `session is already ${primary.location}`)
  }
  if (to === 'trash' && primary.location === 'trash') {
    throw new CsmError('invalid', 'session is already in trash')
  }
  const group = matches.filter((m) => m.location === primary.location)
  const destDir = to === 'archived' ? l.archivedDir : l.trashDir
  await mkdir(destDir, { recursive: true })
  let dest = null
  for (const m of group) {
    const isPrimary = m.path === primary.path
    await guardMovable(m.path, { force, expectedMtimeMs: isPrimary ? expectedMtimeMs : undefined })
    await backupFile(home, m.path)
    const d = await uniqueDest(destDir, m.path)
    await fsRename(m.path, d)
    if (isPrimary) dest = d
  }
  return { id, location: to, path: dest }
}
