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
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store', // API 响应不缓存，防 Task 9 在 rename/archive 后读到陈旧列表（审查 I8）
  })
  res.end(body)
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } })
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (chunks.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    // 坏 JSON body → 400 invalid（否则 SyntaxError 无 .code，会落到外层 catch 成 500）
    throw new core.CsmError('invalid', 'request body must be valid JSON')
  }
  // 合法 JSON 但为 null/数组/标量 → 400（否则 null 会在 body.title 处触发 TypeError → 500，审查 I2）
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new core.CsmError('invalid', 'request body must be a JSON object')
  }
  return parsed
}

/** 创建面板 HTTP 服务（不监听）。home 缺省用 CODEX_HOME；token 缺省随机生成。 */
export function createApp({ home, token } = {}) {
  const H = home ?? core.codexHome()
  const T = token ?? process.env.CSM_TOKEN ?? randomBytes(16).toString('hex')

  /** 读取完整会话并挂载详情页字段：title（无索引标题时为 null，Task 9 统一渲染 (未命名)）、archived、mtimeMs（供乐观并发回填）。 */
  async function loadFull(id) {
    const found = await core.findSessionFile(H, id)
    if (!found) return null
    const session = await core.readSessionFile(found.path)
    const index = await core.readIndex(H)
    session.title = index.get(id)?.title ?? null // 审查 I6：与 list 语义对齐；export/resume 内部仍 ?? session.id
    session.archived = found.location !== 'active'
    session.mtimeMs = found.mtimeMs
    return session
  }

  const server = createServer(async (req, res) => {
    // 审查 I1：new URL 必须进 try —— llhttp 接受畸形绝对形式请求目标（如 "http://[::1"），
    // new URL 抛 TypeError 会逃逸 async handler → 未处理拒绝 → 进程崩溃（未鉴权单包 DoS）。
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      return sendError(res, 400, 'invalid', 'malformed request target')
    }
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
          // 审查 I3：decodeURIComponent 对非法百分号编码（%zz）抛 URIError（无 .code）→ 会成 500；显式转 400
          let id
          try {
            id = decodeURIComponent(m[1])
          } catch {
            return sendError(res, 400, 'invalid', 'malformed session id encoding')
          }
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

      // 静态文件（仅 GET/HEAD；其他方法 → 404，审查 I11）
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 404, 'not_found', 'not found')
      const p = normalize(join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname))
      // 纵深防御：WHATWG URL 已解析掉 dot-segments，合法 HTTP 到不了下面的 403（会落 404）；
      // 保留是防未来重构（如改用手动解析 req.url 或先解码后 join）逃逸 PUBLIC_DIR（审查 I10）。
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
      // 审查 I9：headers 已发出后不能再 writeHead（会抛 ERR_HTTP_HEADERS_SENT 二次崩溃）
      if (res.headersSent) return res.end()
      const status = STATUS_BY_CODE[err?.code]
      // 审查 I5：仅已知 CsmError code 走映射（4xx 消息用户可读，按 I6 策略原样透出）；
      // 未映射者（fs errno/编程错误）→ 服务端记日志，对外只给通用 internal，不泄漏绝对路径/errno。
      // typeof number 判定同时杜绝 STATUS_BY_CODE['__proto__'] 取到 Object.prototype 真值的潜在隐患。
      if (typeof status === 'number') return sendError(res, status, err.code, String(err?.message ?? err))
      console.error(err)
      return sendError(res, 500, 'internal', 'internal server error')
    }
  })
  return { server, token: T, home: H }
}

// 直接运行时启动面板
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, token } = createApp()
  const requested = Number(process.env.CSM_PORT ?? 4173)
  const port = Number.isFinite(requested) ? requested : 4173 // CSM_PORT 非法 → NaN 会静默用随机端口，回退默认
  server.listen(port, '127.0.0.1', () => {
    console.log(`CSM 会话面板: http://127.0.0.1:${server.address().port}/?token=${token}`)
    console.log('（仅监听 127.0.0.1；token 用于本机 API 鉴权）')
  })
}
