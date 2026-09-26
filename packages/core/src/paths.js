import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 解析 Codex 数据根目录：显式覆盖 > $CODEX_HOME > ~/.codex。 */
export function codexHome(override) {
  return resolve(override ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'))
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

/** 把 p 解析到 root 内；结果逃逸 root 时抛错（路径穿越防护）。 */
export function anchor(root, p) {
  const resolved = isAbsolute(p) ? resolve(p) : resolve(root, p)
  const rel = relative(root, resolved)
  if (rel !== '' && (rel === '..' || rel.startsWith('..' + sep))) {
    throw new Error(`path escapes CODEX_HOME: ${p}`)
  }
  return resolved
}
