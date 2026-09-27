import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import * as core from '@csm/core'

function countBy(arr) {
  // 空原型：工具名来自语料，构造的 'constructor'/'__proto__' 若落到 Object 原型对象上会产生脏值或丢计数
  // （与 Task 7 stats I2 同款）；null-proto 下两者都能正确计数，且 JSON 序列化（MCP 出口）不受影响。
  const o = Object.create(null)
  for (const x of arr) o[x] = (o[x] ?? 0) + 1
  return o
}

/** 标题长度上限（I6 决策：core 不限，web/MCP 入口层封顶；镜像 web server.mjs 的 MAX_TITLE=200）。 */
const MAX_TITLE = 200

// I16：MCP 载荷体积上限。实测真实语料 700 会话的消息数分布：
//   中位 19 / p90 151 / p95 310 / p99 899 / 最大 4228
// → 200 条可完整覆盖约九成会话；超出则截断尾部并显式报告，避免一次 get_session 灌满上下文。
const DEFAULT_MAX_MESSAGES = 200
const DEFAULT_LIST_LIMIT = 200

/** 非负整数校验（0 = 不限制）；非法值抛 invalid，避免负切片/字符串切片的歧义。 */
function nonNegInt(v, name) {
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new core.CsmError('invalid', `${name} must be a non-negative integer`)
  }
  return v
}

/** 创建 6 个 MCP 工具的实现函数（home 缺省用 CODEX_HOME）。 */
export function createSessionTools({ home } = {}) {
  const H = home ?? core.codexHome()

  async function load(id) {
    const found = await core.findSessionFile(H, id)
    if (!found) throw new core.CsmError('not_found', `session ${id} not found`)
    const session = await core.readSessionFile(found.path)
    const index = await core.readIndex(H)
    session.title = index.get(id)?.title ?? null // 对齐 web detail（Task 8 I6）：null=无标题；get_session 已单独返回 id，无需 UUID 兜底；renderExport 内部仍 ?? session.id 故 MD 标题保留 UUID
    session.archived = found.location !== 'active'
    return session
  }

  return {
    async list_sessions({ query, cwd, model, limit } = {}) {
      const lim = nonNegInt(limit, 'limit') ?? DEFAULT_LIST_LIMIT
      const sessions = await core.listSessions({ home: H, q: query, cwd, model })
      // core 已按 updatedAt 倒序 → 截断保留最近 N 条
      const kept = lim === 0 ? sessions : sessions.slice(0, lim)
      return {
        count: sessions.length, // 保持既有语义：匹配总数（web/测试依赖）
        returned: kept.length,
        truncated: kept.length < sessions.length,
        sessions: kept.map((s) => ({
          id: s.id, title: s.title, cwd: s.cwd, model: s.model,
          provider: s.provider, updatedAt: s.updatedAt, archived: s.archived,
        })),
      }
    },
    async get_session({ id, maxMessages } = {}) {
      const cap = nonNegInt(maxMessages, 'maxMessages') ?? DEFAULT_MAX_MESSAGES
      const s = await load(id)
      const total = s.messages.length
      // 超限时保留「最近」的消息（尾部）：回顾/续写场景下尾部信息量最大
      const messages = cap === 0 || total <= cap ? s.messages : s.messages.slice(total - cap)
      return {
        id: s.id, title: s.title, cwd: s.cwd, model: s.model, provider: s.provider,
        createdAt: s.createdAt, updatedAt: s.updatedAt, tokens: s.tokens, archived: s.archived,
        totalMessages: total,
        messagesTruncated: messages.length < total,
        messages, toolCallCounts: countBy(s.toolCalls), badLines: s.badLines, // M-3：对齐 web detail/JSON 导出，对抗语料下透出不可解析行数
      }
    },
    async rename_session({ id, title } = {}) {
      // I-2（镜像 web MAX_TITLE=200）：入口层封顶，防一次 LLM 调用用超长标题永久污染 append-only 索引（此后每次 list/get 都 token 爆炸）
      if (typeof title === 'string' && title.length > MAX_TITLE) {
        throw new core.CsmError('invalid', `title too long (max ${MAX_TITLE} characters)`)
      }
      return core.renameSession({ home: H, id, title })
    },
    async archive_session({ id, force } = {}) {
      return core.archiveSession({ home: H, id, force })
    },
    async delete_session({ id, force } = {}) {
      return core.deleteSession({ home: H, id, force })
    },
    async export_session({ id, format = 'md', outputPath } = {}) {
      const s = await load(id)
      const text = core.renderExport(s, format) // 非法 format 在此抛 invalid，早于任何 fs 副作用（I-3 顺序保证）
      const exportsDir = join(H, 'exports')
      let dest
      try {
        // anchor 保证 outputPath 只能落在 CODEX_HOME 内：相对路径解析进 home，home 外绝对路径抛 invalid
        dest = core.anchor(H, outputPath ?? join(exportsDir, `${id}.${format}`))
        await mkdir(dirname(dest), { recursive: true })
        // I-1：拒绝覆盖 exports/ 之外的既有文件——session_index/rollout 是产品皇冠明珠，此为全产品唯一不可逆无备份写；
        //      exports/ 内同名文件允许幂等重导（wx 独占创建，EEXIST → conflict）。
        const insideExports = dest === exportsDir || dest.startsWith(exportsDir + sep)
        await writeFile(dest, text, { flag: insideExports ? 'w' : 'wx' })
      } catch (e) {
        if (e instanceof core.CsmError) throw e // anchor 的路径逃逸 invalid 原样透出（测试 3 依赖）
        // M-1：其余 fs/参数错误（EISDIR/EACCES/ENAMETOOLONG/NUL TypeError…）脱敏成域错误码，只暴露 errno 不泄漏绝对路径
        if (e?.code === 'EEXIST') throw new core.CsmError('conflict', 'target file already exists; refusing to overwrite outside exports/')
        throw new core.CsmError('invalid', `cannot write export: ${e?.code ?? 'unknown error'}`)
      }
      return { path: dest, bytes: Buffer.byteLength(text) }
    },
  }
}
