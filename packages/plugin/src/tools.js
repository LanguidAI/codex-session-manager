import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import * as core from '@csm/core'

function countBy(arr) {
  // 空原型：工具名来自语料，构造的 'constructor'/'__proto__' 若落到 Object 原型对象上会产生脏值或丢计数
  // （与 Task 7 stats I2 同款）；null-proto 下两者都能正确计数，且 JSON 序列化（MCP 出口）不受影响。
  const o = Object.create(null)
  for (const x of arr) o[x] = (o[x] ?? 0) + 1
  return o
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
    async list_sessions({ query, cwd, model } = {}) {
      const sessions = await core.listSessions({ home: H, q: query, cwd, model })
      return {
        count: sessions.length,
        sessions: sessions.map((s) => ({
          id: s.id, title: s.title, cwd: s.cwd, model: s.model,
          provider: s.provider, updatedAt: s.updatedAt, archived: s.archived,
        })),
      }
    },
    async get_session({ id }) {
      const s = await load(id)
      return {
        id: s.id, title: s.title, cwd: s.cwd, model: s.model, provider: s.provider,
        createdAt: s.createdAt, updatedAt: s.updatedAt, tokens: s.tokens, archived: s.archived,
        messages: s.messages, toolCallCounts: countBy(s.toolCalls),
      }
    },
    async rename_session({ id, title }) {
      return core.renameSession({ home: H, id, title })
    },
    async archive_session({ id, force }) {
      return core.archiveSession({ home: H, id, force })
    },
    async delete_session({ id, force }) {
      return core.deleteSession({ home: H, id, force })
    },
    async export_session({ id, format = 'md', outputPath } = {}) {
      const s = await load(id)
      const text = core.renderExport(s, format)
      // anchor 保证 outputPath 只能落在 CODEX_HOME 内：相对路径解析进 home，home 外绝对路径抛 invalid
      const dest = core.anchor(H, outputPath ?? join(H, 'exports', `${id}.${format}`))
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, text)
      return { path: dest, bytes: Buffer.byteLength(text) }
    },
  }
}
