import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

/** response_item user 消息中属于上下文注入的前缀（非真实用户输入）。 */
const USER_INJECTION_PREFIXES = ['# AGENTS.md instructions', '<permissions', '<user_instructions', '<environment_context']

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n').trim()
}

/** 解析整个 rollout jsonl 内容为 Session 记录；坏行只计数不报错。 */
export function parseSessionContent(content) {
  const session = {
    id: null, title: null, cwd: null, originator: null, cliVersion: null,
    provider: null, model: null, createdAt: null, updatedAt: null,
    messages: [], toolCalls: [], tokens: null, badLines: 0,
  }
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue
    let line
    try { line = JSON.parse(raw) } catch { session.badLines += 1; continue }
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
        if (typeof p.model === 'string') session.model = p.model
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
  // item_completed 是权威用户消息源：存在时丢弃 response_item 回退源
  if (session.messages.some((m) => m.source === 'item')) {
    session.messages = session.messages.filter((m) => m.source !== 'response')
  }
  for (const m of session.messages) delete m.source
  return session
}

/** 读取并解析磁盘上的会话文件。 */
export async function readSessionFile(filePath) {
  return parseSessionContent(await readFile(filePath, 'utf8'))
}

/**
 * 只读文件头部若干行提取列表页所需的轻量元数据。
 * 用 readline 逐行流式读，避免 base_instructions 超长行截断问题；扫到 id+model 即停。
 */
export async function fastMeta(filePath, { maxLines = 200 } = {}) {
  const meta = { id: null, cwd: null, provider: null, model: null, createdAt: null }
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity })
  let scanned = 0
  try {
    for await (const raw of rl) {
      if (++scanned > maxLines) break
      if (!raw.trim()) continue
      let line
      try { line = JSON.parse(raw) } catch { continue }
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
  }
  return meta
}
