#!/usr/bin/env node
/** session-manager MCP server：把 core 能力暴露为 Codex 工具。 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createSessionTools } from './src/tools.js'

const tools = createSessionTools()
const server = new McpServer({ name: 'session-manager', version: '0.1.0' })

const ok = (data) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
})
const fail = (err) => ({
  isError: true,
  content: [{ type: 'text', text: `[${err?.code ?? 'error'}] ${err?.message ?? err}` }],
})
/** 包装工具处理函数：领域错误转 isError 结果而非协议异常。 */
const wrap = (fn) => async (args) => {
  try { return ok(await fn(args)) } catch (err) { return fail(err) }
}

// registerTool 是 SDK 1.30.1 的现代 API（server.tool 全部 overload 已标 @deprecated）；
// annotations 向客户端传达只读/破坏性语义（delete=destructive），description 内嵌 M-2/M-4 操作指引（tools/list 即对模型可见）。
server.registerTool('list_sessions', {
  title: '列出/搜索会话',
  description: '列出/搜索 Codex 历史会话（返回 id、标题、项目 cwd、模型、更新时间）。默认只返回最近 200 条（truncated=true 表示被截断，可用 limit=0 取消限制；count 始终是匹配总数）。仅列活跃会话——归档/删除后不再出现（按 id 仍可操作，见 SKILL.md）。大语料下响应可达上百 KB，务必用 query/cwd/model 过滤。',
  inputSchema: {
    query: z.string().optional().describe('关键字（标题/ID/目录，包含匹配）'),
    cwd: z.string().optional().describe('项目目录过滤（包含匹配）'),
    model: z.string().optional().describe('模型过滤（精确匹配）'),
    limit: z.number().int().nonnegative().optional().describe('最多返回多少条（默认 200；0 = 不限制）。按更新时间倒序保留最近的'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, wrap(tools.list_sessions))

server.registerTool('get_session', {
  title: '读取会话全文',
  description: '读取一个会话的完整内容（消息流、toolCallCounts、tokens、badLines）。默认只返回最近 200 条消息（实测真实语料中位 19 条、p90 151 条）；超出时返回 messagesTruncated=true 与 totalMessages，用 maxMessages=0 或更大的值取全量。大会话输出最坏可达 ~1.8MB（数万至数十万 tokens）——若只为回顾/迁移，优先用 export_session 落地文件再按需读片段，别把全文灌进上下文。',
  inputSchema: {
    id: z.string().describe('会话 ID'),
    maxMessages: z.number().int().nonnegative().optional().describe('最多返回多少条消息（默认 200；0 = 不限制）。超限时保留最近的消息并置 messagesTruncated=true'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, wrap(tools.get_session))

server.registerTool('rename_session', {
  title: '重命名会话',
  description: '重命名会话：只更新标题索引 session_index.jsonl（自动备份），绝不移动或改写会话 jsonl 本体。标题上限 200 字符。',
  inputSchema: {
    id: z.string().describe('会话 ID'),
    title: z.string().max(200).describe('新标题（≤200 字符）'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, wrap(tools.rename_session))

server.registerTool('archive_session', {
  title: '归档会话',
  description: '归档会话：移入官方 archived_sessions/（可逆，自动备份）。归档后从 list_sessions 消失，但按显式 id 仍可 get/rename/export；无 restore 工具（需手动移回 sessions/）。30 秒内仍被写入的会话会被拒（code=active），除非 force。',
  inputSchema: {
    id: z.string().describe('会话 ID'),
    force: z.boolean().optional().describe('会话 30 秒内仍被写入时强制执行'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, wrap(tools.archive_session))

server.registerTool('delete_session', {
  title: '软删除会话',
  description: '软删除会话：先备份，再移入 .csm-trash/，绝不物理删除（可手动找回）。删除后从 list_sessions 消失，但按显式 id 仍可操作；无 restore 工具。30 秒内活跃写入会被拒（code=active），除非 force。',
  inputSchema: {
    id: z.string().describe('会话 ID'),
    force: z.boolean().optional().describe('会话 30 秒内仍被写入时强制执行'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, wrap(tools.delete_session))

server.registerTool('export_session', {
  title: '导出会话',
  description: '导出会话为 Markdown 或 JSON 文件，返回 {path, bytes}。缺省写 CODEX_HOME/exports/<id>.<format>；outputPath 锚定在 CODEX_HOME 内（外部绝对路径拒绝）。安全：绝不覆盖 exports/ 之外的既有文件（命中 → code=conflict）；exports/ 内同名文件允许幂等重导。',
  inputSchema: {
    id: z.string().describe('会话 ID'),
    format: z.enum(['md', 'json']).optional().describe('导出格式，默认 md'),
    outputPath: z.string().optional().describe('输出路径（锚定 CODEX_HOME 内）；缺省 CODEX_HOME/exports/<id>.<format>'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, wrap(tools.export_session))

await server.connect(new StdioServerTransport())
console.error('[session-manager] MCP server started')
