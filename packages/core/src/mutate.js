import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, copyFile, mkdir, readFile, rename as fsRename, stat } from 'node:fs/promises'
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

/**
 * 把文件备份到 .csm-backups/<时间戳-随机>/ 下，返回备份路径。
 * COPYFILE_EXCL：备份目标已存在时拒绝覆盖——宁可响亮失败也不静默覆盖（审查 I7）。
 */
async function backupFile(home, filePath) {
  const dir = join(layout(home).backupsDir, backupDirName())
  await mkdir(dir, { recursive: true })
  const dest = join(dir, basename(filePath))
  await copyFile(filePath, dest, constants.COPYFILE_EXCL)
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
  // 审查 I3：null/undefined 视为未提供；数值字符串强转；其余非数值 → invalid（避免 "expected X, got X" 式不可诊断假冲突）
  if (expectedMtimeMs != null) {
    const expected = Number(expectedMtimeMs)
    if (!Number.isFinite(expected)) {
      throw new CsmError('invalid', `expectedMtimeMs must be a finite number, got ${JSON.stringify(expectedMtimeMs)}`)
    }
    if (st.mtimeMs !== expected) {
      throw new CsmError('conflict', `session file changed since read (expected mtime ${expected}, got ${st.mtimeMs})`)
    }
  }
  // 审查修正：APFS mtime 带小数精度而 Date.now() 截断到整毫秒，同一毫秒内写入的文件 age 为微小负值；
  // 原 `age >= 0` 条件会放行最危险的“正在写入”场景。夹紧到 0：宁可误拒（force 可越过）不可漏放。
  const age = Math.max(0, Date.now() - st.mtimeMs)
  if (!force && age < ACTIVE_WINDOW_MS) {
    throw new CsmError('active', `会话 ${Math.round(age / 1000)} 秒前仍在写入，可能正被 Codex 使用；确认后可用 force=true 强制`)
  }
  return st
}

/**
 * 重命名：向 session_index.jsonl 追加新行（后行生效语义），追加前备份索引。
 * 审查 I2：索引末行缺换行符（写入中断产物）时先补 \n 再追加，避免粘连吞掉条目。
 * @returns {Promise<{id: string, title: string}>}
 */
export async function renameSession({ home, id, title }) {
  if (typeof id !== 'string' || id === '') throw new CsmError('invalid', 'id must be a non-empty string')
  const t = typeof title === 'string' ? title.trim() : ''
  if (!t) throw new CsmError('invalid', 'title is required')
  const matches = await findSessionFiles(home, id)
  if (matches.length === 0) throw new CsmError('not_found', `session ${id} not found`)
  const l = layout(home)
  let needsNewline = false
  try {
    const existing = await readFile(l.index)
    needsNewline = existing.length > 0 && existing[existing.length - 1] !== 0x0a
    await backupFile(home, l.index)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  await appendFile(l.index, (needsNewline ? '\n' : '') + JSON.stringify({ id, thread_name: t, updated_at: new Date().toISOString() }) + '\n')
  return { id, title: t }
}

/**
 * 归档：把会话 active 组的全部分片文件移入官方 archived_sessions/（与 Desktop 行为一致），逐个先备份。
 * @returns {Promise<{id: string, location: 'archived', path: string}>}
 */
export async function archiveSession({ home, id, force, expectedMtimeMs }) {
  return moveSession({ home, id, force, expectedMtimeMs, to: 'archived' })
}

/**
 * 删除：软删除，把会话的全部分片文件扫入 .csm-trash/（绝不物理删除），逐个先备份。
 * 审查 I1：跨 active/archived 一并扫走，保证“delete ⇒ 列表消失”契约成立。
 * @returns {Promise<{id: string, location: 'trash', path: string}>}
 */
export async function deleteSession({ home, id, force, expectedMtimeMs }) {
  return moveSession({ home, id, force, expectedMtimeMs, to: 'trash' })
}

/**
 * 共享移动逻辑：定位全部匹配 → location 校验 → 两阶段执行（审查 I4）：
 * 先逐文件防护（conflict/active）——可预期失败全部发生在任何写盘之前；
 * 再逐文件备份/防碰撞移动。expectedMtimeMs 只约束主文件（UI/工具读到的那个）。
 * 移动中被外部并发删除（ENOENT）→ conflict（重试可完成剩余分片）。
 */
async function moveSession({ home, id, force, expectedMtimeMs, to }) {
  if (typeof id !== 'string' || id === '') throw new CsmError('invalid', 'id must be a non-empty string')
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
  // archive 只移动主 location 组；delete 扫走全部尚未入 trash 的分片（审查 I1）
  const group = to === 'trash'
    ? matches.filter((m) => m.location !== 'trash')
    : matches.filter((m) => m.location === primary.location)
  const destDir = to === 'archived' ? l.archivedDir : l.trashDir
  await mkdir(destDir, { recursive: true })
  for (const m of group) {
    const isPrimary = m.path === primary.path
    await guardMovable(m.path, { force, expectedMtimeMs: isPrimary ? expectedMtimeMs : undefined })
  }
  let dest = null
  for (const m of group) {
    const d = await uniqueDest(destDir, m.path)
    try {
      await backupFile(home, m.path)
      await fsRename(m.path, d)
    } catch (e) {
      if (e?.code === 'ENOENT') {
        throw new CsmError('conflict', `session file vanished during operation, retry to finish: ${m.path}`)
      }
      throw e
    }
    if (m.path === primary.path) dest = d
  }
  return { id, location: to, path: dest }
}
