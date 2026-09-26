import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CsmError } from './errors.js'

/** 解析 Codex 数据根目录：显式覆盖 > $CODEX_HOME > ~/.codex；空白值视为未设置。 */
export function codexHome(override) {
  for (const candidate of [override, process.env.CODEX_HOME]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return resolve(candidate)
  }
  return resolve(join(homedir(), '.codex'))
}

/** CODEX_HOME 下的标准目录布局。 */
export function layout(home) {
  return {
    home,
    index: join(home, 'session_index.jsonl'),
    sessionsDir: join(home, 'sessions'),
    archivedDir: join(home, 'archived_sessions'),
    trashDir: join(home, '.csm-trash'),
    backupsDir: join(home, '.csm-backups'),
  }
}

/**
 * 把 p 解析到 root 内；逃逸时抛 CsmError('invalid')（路径穿越防护）。
 * 双重检查：词法 relative 包含 + realpath 归一后包含（防符号链接逃逸）。
 * 不存在的目标路径按最近存在的祖先目录归一。
 */
export function anchor(root, p) {
  const resolved = isAbsolute(p) ? resolve(p) : resolve(root, p)
  assertInside(root, resolved, p)
  assertInside(realpathSafe(root), realpathSafe(resolved), p)
  return resolved
}

function assertInside(root, resolved, original) {
  const rel = relative(root, resolved)
  if (rel !== '' && (rel === '..' || rel.startsWith('..' + sep))) {
    throw new CsmError('invalid', `path escapes root: ${original}`)
  }
}

/** realpath 目标路径；ENOENT/ENOTDIR 时向上回溯到最近存在的祖先后拼接剩余尾部。 */
function realpathSafe(p) {
  let cur = resolve(p)
  const tail = []
  for (;;) {
    try {
      const real = realpathSync(cur)
      return tail.length === 0 ? real : join(real, ...tail.reverse())
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e
      const parent = dirname(cur)
      if (parent === cur) return cur
      tail.push(basename(cur))
      cur = parent
    }
  }
}
