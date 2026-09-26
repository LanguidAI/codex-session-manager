import { CsmError } from './errors.js'

function countBy(arr) {
  const out = []
  const seen = new Map()
  for (const x of arr) seen.set(x, (seen.get(x) ?? 0) + 1)
  for (const [name, n] of seen) out.push({ name, count: n })
  return out
}

function clip(text, n) {
  return text.length > n ? `${text.slice(0, n)}…（已截断）` : text
}

/** 会话 → Markdown 对话日志。 */
export function toMarkdown(session) {
  const head = [
    `# ${session.title ?? session.id}`,
    '',
    `- 会话 ID: \`${session.id}\``,
    `- 项目目录: ${session.cwd ?? '?'}`,
    `- 模型: ${session.model ?? '?'}（provider: ${session.provider ?? '?'}）`,
    `- 时间: ${session.createdAt ?? '?'} → ${session.updatedAt ?? '?'}`,
    `- 消息数: ${session.messages.length} | 工具调用: ${session.toolCalls.length} | tokens: ${session.tokens ?? '?'}`,
    '',
  ]
  const body = session.messages.map(
    (m) => `## ${m.role === 'user' ? '🧑 用户' : '🤖 助手'}${m.timestamp ? `（${m.timestamp}）` : ''}\n\n${m.text}\n`,
  )
  const tools = session.toolCalls.length
    ? ['## 工具调用统计', '', ...countBy(session.toolCalls).map((t) => `- \`${t.name}\` × ${t.count}`), '']
    : []
  return [...head, ...body, ...tools].join('\n')
}

/** 会话 → 结构化 JSON。 */
export function toJson(session) {
  return JSON.stringify(session, null, 2)
}

/** 生成紧凑的“恢复上下文” Markdown，供粘贴到新会话继续。 */
export function buildResumeContext(session, { maxMessages = 6, maxCharsPerMessage = 400, goalChars = 1500 } = {}) {
  const firstUser = session.messages.find((m) => m.role === 'user')
  const recent = session.messages.slice(-maxMessages)
  return [
    `# 请继续这个 Codex 会话：${session.title ?? session.id}`,
    `- 原项目目录: ${session.cwd ?? '?'}`,
    `- 使用模型: ${session.model ?? '?'}`,
    `- 最后活跃: ${session.updatedAt ?? '?'}`,
    '',
    '## 原目标',
    firstUser ? clip(firstUser.text, goalChars) : '（无用户消息记录）',
    '',
    '## 最近进展',
    ...recent.map((m) => `**${m.role === 'user' ? '用户' : '助手'}**: ${clip(m.text, maxCharsPerMessage)}`),
    '',
    '请基于以上上下文继续完成任务。',
  ].join('\n')
}

/** 按格式渲染导出内容；格式非法抛 CsmError('invalid')。 */
export function renderExport(session, format) {
  if (format === 'json') return toJson(session)
  if (format === 'md') return toMarkdown(session)
  throw new CsmError('invalid', `unknown export format: ${format}`)
}
