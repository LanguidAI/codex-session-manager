import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as core from '@csm/core'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(HERE, 'public')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}
const STATUS_BY_CODE = { not_found: 404, conflict: 409, active: 409, invalid: 400 }
/** 标题长度上限（I6：core 不限，web/工具层封顶；超长 → 400 invalid）。 */
const MAX_TITLE = 200

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } })
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    // 坏 JSON body → 400 invalid（否则 SyntaxError 无 .code，会落到外层 catch 成 500）
    throw new core.CsmError('invalid', 'request body must be valid JSON')
  }
}

/** 创建面板 HTTP 服务（不监听）。home 缺省用 CODEX_HOME；token 缺省随机生成。 */
export function createApp({ home, token } = {}) {
  const H = home ?? core.codexHome()
  const T = token ?? process.env.CSM_TOKEN ?? randomBytes(16).toString('hex')

  async function loadFull(id) {
    const found = await core.findSessionFile(H, id)
    if (!found) return null
    const session = await core.readSessionFile(found.path)
    const index = await core.readIndex(H)
    session.title = index.get(id)?.title ?? session.id
    session.archived = found.location !== 'active'
    session.mtimeMs = found.mtimeMs
    return session
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true })

      if (url.pathname.startsWith('/api/')) {
        if (req.headers.authorization !== `Bearer ${T}`) {
          return sendError(res, 401, 'unauthorized', 'missing or wrong bearer token')
        }
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const sessions = await core.listSessions({
            home: H,
            q: url.searchParams.get('q') ?? undefined,
            cwd: url.searchParams.get('cwd') ?? undefined,
            model: url.searchParams.get('model') ?? undefined,
            includeArchived: url.searchParams.get('archived') === '1',
          })
          return sendJson(res, 200, { sessions })
        }
        if (req.method === 'GET' && url.pathname === '/api/stats') {
          return sendJson(res, 200, await core.buildStats({ home: H }))
        }
        const m = url.pathname.match(/^\/api\/sessions\/([^/]+)(\/export|\/resume|\/archive|\/delete)?$/)
        if (m) {
          const id = decodeURIComponent(m[1])
          const sub = m[2]
          if (req.method === 'GET' && !sub) {
            const session = await loadFull(id)
            if (!session) return sendError(res, 404, 'not_found', `session ${id} not found`)
            return sendJson(res, 200, { session })
          }
          if (req.method === 'GET' && sub === '/export') {
            const session = await loadFull(id)
            if (!session) return sendError(res, 404, 'not_found', 'session not found')
            const fmt = url.searchParams.get('fmt') === 'json' ? 'json' : 'md'
            const text = core.renderExport(session, fmt)
            // id 进响应头：去掉非 [a-zA-Z0-9._-] 字符防头部注入（正常 UUID 不受影响）
            const safeName = id.replace(/[^a-zA-Z0-9._-]/g, '_')
            res.writeHead(200, {
              'content-type': fmt === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
              'content-disposition': `attachment; filename="${safeName}.${fmt}"`,
            })
            return res.end(text)
          }
          if (req.method === 'GET' && sub === '/resume') {
            const session = await loadFull(id)
            if (!session) return sendError(res, 404, 'not_found', 'session not found')
            return sendJson(res, 200, { text: core.buildResumeContext(session) })
          }
          const body = req.method === 'PATCH' || req.method === 'POST' ? await readBody(req) : {}
          if (req.method === 'PATCH' && !sub) {
            const title = typeof body.title === 'string' ? body.title : ''
            if (title.length > MAX_TITLE) return sendError(res, 400, 'invalid', `title too long (max ${MAX_TITLE} characters)`)
            return sendJson(res, 200, await core.renameSession({ home: H, id, title }))
          }
          if (req.method === 'POST' && sub === '/archive') {
            return sendJson(res, 200, await core.archiveSession({ home: H, id, force: body.force, expectedMtimeMs: body.expectedMtimeMs }))
          }
          if (req.method === 'POST' && sub === '/delete') {
            return sendJson(res, 200, await core.deleteSession({ home: H, id, force: body.force, expectedMtimeMs: body.expectedMtimeMs }))
          }
        }
        return sendError(res, 404, 'not_found', `no route ${req.method} ${url.pathname}`)
      }

      // 静态文件（含路径穿越防护）
      const p = normalize(join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname))
      if (p !== PUBLIC_DIR && !p.startsWith(PUBLIC_DIR + sep)) return sendError(res, 403, 'invalid', 'forbidden')
      let content
      try {
        content = await readFile(p)
      } catch (e) {
        // 静态文件不存在 → 404（否则 ENOENT 落到外层 catch 成 500；穿越用例期望 403/404）
        if (e?.code === 'ENOENT') return sendError(res, 404, 'not_found', 'file not found')
        throw e
      }
      res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' })
      return res.end(content)
    } catch (err) {
      const status = STATUS_BY_CODE[err?.code] ?? 500
      return sendError(res, status, err?.code ?? 'internal', String(err?.message ?? err))
    }
  })
  return { server, token: T, home: H }
}

// 直接运行时启动面板
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, token } = createApp()
  const port = Number(process.env.CSM_PORT ?? 4173)
  server.listen(port, '127.0.0.1', () => {
    console.log(`CSM 会话面板: http://127.0.0.1:${server.address().port}/?token=${token}`)
    console.log('（仅监听 127.0.0.1；token 用于本机 API 鉴权）')
  })
}
