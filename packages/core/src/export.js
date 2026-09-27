import { CsmError } from './errors.js'

function countBy(arr) {
  const out = []
  const seen = new Map()
  for (const x of arr) seen.set(x, (seen.get(x) ?? 0) + 1)
  for (const [name, n] of seen) out.push({ name, count: n })
  return out
}

function clip(text, n) {
  if (text.length <= n) return text
  const cut = /^[\uD800-\uDBFF]$/.test(text[n - 1]) ? n - 1 : n // 不拆开代理对（审查 I2）
  return `${text.slice(0, cut)}…（已截断）`
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

/** 导出字段白名单：只含 Session 固有字段，排除上层临时挂载的本地状态（archived/mtimeMs 等），
 *  保证同一会话的 JSON 导出逐字节可复现（审查 I1）。保留 reader 全保真字段（含 badLines）。 */
const EXPORT_FIELDS = [
  'id', 'title', 'cwd', 'originator', 'cliVersion', 'provider', 'model',
  'createdAt', 'updatedAt', 'messages', 'toolCalls', 'tokens', 'badLines',
]

/** 会话 → 结构化 JSON（字段白名单，见 EXPORT_FIELDS）。 */
export function toJson(session) {
  return JSON.stringify(Object.fromEntries(EXPORT_FIELDS.map((k) => [k, session[k] ?? null])), null, 2)
}

/**
 * 生成紧凑的“恢复上下文” Markdown，供粘贴到新会话继续。
 * 选项单位均为 UTF-16 code unit；预算总量 ≈ goalChars + maxMessages×maxCharsPerMessage（默认 ≈ 3.9K，语料最坏实测 ≈ 5.2KB）。
 * @param {number} maxMessages 纳入的最近消息条数（<=0 表示只保留原目标、不带最近进展；审查 I3）
 * @param {number} maxCharsPerMessage 每条最近消息的裁剪长度
 * @param {number} goalChars 原目标（首条用户消息）的裁剪长度
 */
export function buildResumeContext(session, { maxMessages = 6, maxCharsPerMessage = 400, goalChars = 1500 } = {}) {
  const firstUser = session.messages.find((m) => m.role === 'user')
  const window = maxMessages > 0 ? session.messages.slice(-maxMessages) : []
  // I-6 去重：短会话（消息数 ≤ maxMessages）时首条用户消息同时落在「原目标」与窗口内。
  // 保留信息更全的那份（goalChars 1500 > maxCharsPerMessage 400），把它从窗口移除；
  // 若反过来省略整个「原目标」小节，长目标会从 1500 字缩水到 400 字——那是信息损失而非去重。
  const recent = firstUser === undefined ? window : window.filter((m) => m !== firstUser)
  const goalSection = [
    '## 原目标',
    firstUser ? clip(firstUser.text, goalChars) : '（无用户消息记录）',
    '',
  ]
  // 窗口被去重抽空（如会话只有一条用户消息）时不留空标题
  const recentSection = recent.length === 0 ? [] : [
    '## 最近进展',
    // I-6：条目之间补空行——Markdown 会把连续行合并进同一段落，
    // 否则多条「**用户**: …」在渲染后挤成一整块，读不出分隔。
    ...recent.map((m, i) => `${i > 0 ? '\n' : ''}**${m.role === 'user' ? '用户' : '助手'}**: ${clip(m.text, maxCharsPerMessage)}`),
    '',
  ]
  return [
    `# 请继续这个 Codex 会话：${session.title ?? session.id}`,
    `- 原项目目录: ${session.cwd ?? '?'}`,
    `- 使用模型: ${session.model ?? '?'}`,
    `- 最后活跃: ${session.updatedAt ?? '?'}`,
    '',
    ...goalSection,
    ...recentSection,
    '请基于以上上下文继续完成任务。',
  ].join('\n')
}

/** 按格式渲染导出内容；格式非法抛 CsmError('invalid')。 */
export function renderExport(session, format) {
  if (format === 'json') return toJson(session)
  if (format === 'md') return toMarkdown(session)
  throw new CsmError('invalid', `unknown export format: ${format}`)
}
