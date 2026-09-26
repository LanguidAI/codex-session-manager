import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { CsmError } from './errors.js'

/**
 * response_item user 消息中属于上下文注入的前缀（非真实用户输入）。
 * 列表来自真实语料采样，审查后扩充至实测出现过的全部注入标签。
 */
const USER_INJECTION_PREFIXES = [
  '# AGENTS.md instructions',
  '<permissions',
  '<user_instructions',
  '<environment_context',
  '<recommended_plugins',
  '<codex_internal_context',
  '<subagent_notification',
  '<turn_aborted',
  '<codex_delegation',
  '<realtime_delegation',
  '<skill',
  '<server',
  '<repository',
  '<image',
]

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (typeof c?.text === 'string' ? c.text : ''))
    .filter((t) => t !== '')
    .join('\n')
    .trim()
}

/** 空 Session 记录。契约：title 恒为 null（由 catalog 从 session_index 合并）；tokens=null 表示无 token_count 事件（区别于 0）。 */
function emptySession() {
  return {
    id: null, title: null, cwd: null, originator: null, cliVersion: null,
    provider: null, model: null, createdAt: null, updatedAt: null,
    messages: [], toolCalls: [], tokens: null, badLines: 0,
  }
}

/**
 * 把一行已解析的 jsonl 折叠进 session 记录。
 * 非对象行（null/标量）计入 badLines；model 取第一个 turn_context（与 fastMeta 语义一致）。
 */
function handleLine(line, session) {
  if (line === null || typeof line !== 'object' || Array.isArray(line)) {
    session.badLines += 1
    return
  }
  const p = line.payload ?? {}
  if (typeof line.timestamp === 'string') session.updatedAt = line.timestamp
  switch (line.type) {
    case 'session_meta':
      session.id = p.session_id ?? p.id ?? session.id
      session.cwd = p.cwd ?? session.cwd
      session.originator = p.originator ?? session.originator
      session.cliVersion = p.cli_version ?? session.cliVersion
      session.provider = p.model_provider ?? session.provider
      session.createdAt = p.timestamp ?? line.timestamp ?? session.createdAt
      break
    case 'turn_context':
      if (session.model === null && typeof p.model === 'string') session.model = p.model
      break
    case 'response_item':
      if (p.type === 'message' && p.role === 'assistant') {
        const text = contentText(p.content)
        if (text) session.messages.push({ role: 'assistant', text, timestamp: line.timestamp ?? null })
      } else if (p.type === 'message' && p.role === 'user') {
        const text = contentText(p.content)
        if (text && !USER_INJECTION_PREFIXES.some((pre) => text.startsWith(pre))) {
          session.messages.push({ role: 'user', text, timestamp: line.timestamp ?? null, source: 'response' })
        }
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        if (typeof p.name === 'string') session.toolCalls.push(p.name)
      }
      break
    case 'event_msg':
      if (p.type === 'item_completed' && p.item?.type === 'UserMessage') {
        const text = contentText(p.item?.content)
        if (text) session.messages.push({ role: 'user', text, timestamp: line.timestamp ?? null, source: 'item' })
      } else if (p.type === 'token_count') {
        const total = p.info?.total_token_usage?.total_tokens
        if (typeof total === 'number') session.tokens = total
      }
      break
  }
}

/** 双源去重：item_completed 是权威用户消息源，存在时丢弃 response_item 回退源；随后清理内部 source 标记。 */
function finalizeSession(session) {
  if (session.messages.some((m) => m.source === 'item')) {
    session.messages = session.messages.filter((m) => m.source !== 'response')
  }
  for (const m of session.messages) delete m.source
  return session
}

/**
 * 解析整个 rollout jsonl 字符串为 Session 记录；坏行只计数不报错。
 * 消息顺序 = 文件顺序（真实语料验证时间戳单调，export/resume 可信赖）。
 */
export function parseSessionContent(content) {
  const session = emptySession()
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue
    let line
    try { line = JSON.parse(raw) } catch { session.badLines += 1; continue }
    handleLine(line, session)
  }
  return finalizeSession(session)
}

/**
 * 读取并解析磁盘上的会话文件：readline 流式（GB 级大文件安全，绝不字节截断）。
 * ENOENT 转 CsmError('not_found')，供上层映射 404。
 */
export async function readSessionFile(filePath) {
  const session = emptySession()
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const raw of rl) {
      if (!raw.trim()) continue
      let line
      try { line = JSON.parse(raw) } catch { session.badLines += 1; continue }
      handleLine(line, session)
    }
  } catch (e) {
    if (e?.code === 'ENOENT') throw new CsmError('not_found', `session file not found: ${filePath}`)
    throw e
  } finally {
    rl.close()
  }
  return finalizeSession(session)
}

/**
 * 只读文件头部若干行提取列表页所需的轻量元数据。
 * readline 逐行流式读（超长行不字节截断）；扫到 id+model 即停。
 * model 可能为 null：maxLines 界限内未出现 turn_context。
 */
export async function fastMeta(filePath, { maxLines = 200 } = {}) {
  const meta = { id: null, cwd: null, provider: null, model: null, createdAt: null }
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let scanned = 0
  try {
    for await (const raw of rl) {
      if (++scanned > maxLines) break
      if (!raw.trim()) continue
      let line
      try { line = JSON.parse(raw) } catch { continue }
      if (line === null || typeof line !== 'object' || Array.isArray(line)) continue
      const p = line.payload ?? {}
      if (line.type === 'session_meta') {
        meta.id = p.session_id ?? p.id ?? meta.id
        meta.cwd = p.cwd ?? meta.cwd
        meta.provider = p.model_provider ?? meta.provider
        meta.createdAt = p.timestamp ?? line.timestamp ?? meta.createdAt
      } else if (line.type === 'turn_context' && meta.model === null && typeof p.model === 'string') {
        meta.model = p.model
      }
      if (meta.id !== null && meta.model !== null) break
    }
  } finally {
    rl.close()
    stream.destroy() // 回收提前 break 路径的 fd（rl.close 不销毁输入流）
  }
  return meta
}
