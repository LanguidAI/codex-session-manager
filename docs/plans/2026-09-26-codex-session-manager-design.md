# 设计文档：Codex 会话管理器（CSM）

- 日期：2026-09-26
- 状态：已批准（用户确认）
- 作者：DeepSeek Harness 会话（brainstorming 流程产出）

## 1. 背景与目标

用户使用 Codex Desktop（无 codex CLI），本地会话数据位于 `~/.codex/sessions/`。
需要一个"会话管理 UI 插件"，能可视化地查看、搜索、统计、导出历史会话，
并能通过 Codex 官方插件机制让模型在对话中直接操作会话。

目标形态（用户选择）：**Codex 官方插件（工具能力）+ 独立本地 Web 面板（可视化 UI）两者结合**。

## 2. 用户确认的需求

| 需求项 | 用户选择 |
|---|---|
| 插件形态 | 两者结合：官方插件 + Web 面板 |
| 功能集 | 会话列表+搜索过滤 / 统计看板 / 恢复-继续 / 重命名-归档-删除 / 导出 MD-JSON |
| 恢复会话方式 | MVP：复制压缩上下文，手动粘到 Codex Desktop 新会话 |
| 技术栈 | Node 单服务 + 网页（前端原生，无构建） |
| 插件工具集 | 只读（list/get）+ 写操作（rename/archive/delete）+ 导出文件 + SKILL.md |
| 整体架构 | 方案 A：单体仓库 + 共享核心库（packages/core 被 web 与 plugin 复用） |

## 3. 本地事实（调研结论，实施须遵守）

- `~/.codex/session_index.jsonl`：轻量索引，每行 `{"id","thread_name","updated_at"}`；同 id 可能有多行（标题变更历史）
- `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl`：完整会话；
  每行 `{"timestamp","ordinal","type","payload"}`；`session_meta` 含 cwd / originator / cli_version / model_provider / base_instructions
- `~/.codex/archived_sessions/`：官方归档目录（移入即归档），归档语义与官方一致
- Codex 插件清单：`.codex-plugin/plugin.json`（name/version/description/author/license + 可引用 `.mcp.json`、skills）
- 本地插件市场机制：`config.toml` 的 `[marketplaces.xxx] source_type="local"` + `[plugins."name@marketplace"] enabled=true`
- 本机 Node v25.2.1：原生 ESM，支持零构建方案
- 无 codex CLI 二进制；会话由 Codex Desktop 写入（写操作需防并发冲突）

## 4. 架构

```
codex-session-manager/                     # npm workspace 根
├── package.json
├── docs/plans/2026-09-26-codex-session-manager-design.md
├── packages/
│   ├── core/                              # 共享核心库（纯 ESM JS，零依赖）
│   │   ├── src/
│   │   │   ├── index.js                   # 导出所有公共 API
│   │   │   ├── paths.js                   # CODEX_HOME 解析（默认 ~/.codex）、路径锚定防护
│   │   │   ├── catalog.js                 # 读索引 + 扫描磁盘合并去重；过滤搜索
│   │   │   ├── reader.js                  # 解析 rollout jsonl → Session；坏行容错
│   │   │   ├── mutate.js                  # rename / archive / delete；备份；防冲突
│   │   │   ├── export.js                  # MD/JSON 导出；resume 压缩上下文
│   │   │   └── stats.js                   # 按天/项目/模型统计
│   │   └── tests/                         # node:test 单元测试（fixture 数据）
│   ├── web/                               # 本地 Web 面板
│   │   ├── server.mjs                     # 内置 http + REST API（仅绑 127.0.0.1）
│   │   ├── token.js                       # 启动生成随机 bearer token
│   │   ├── public/                        # index.html / app.js / style.css（原生前端）
│   │   └── tests/                         # API 集成测试（临时 CODEX_HOME + 临时端口）
│   └── plugin/                            # Codex 官方插件
│       ├── .codex-plugin/plugin.json
│       ├── .mcp.json
│       ├── server.mjs                     # MCP stdio 工具，复用 core
│       ├── SKILL.md                       # session-manager 技能说明
│       └── install.mjs                    # 本地 marketplace + config.toml 追加（先备份）
```

技术选型：纯 ESM JavaScript、`node:test`、唯一外部依赖 `@modelcontextprotocol/sdk`（MCP server）。
core 支持 `CODEX_HOME` 环境变量覆盖（默认 `~/.codex`），测试使用临时目录。

## 5. 组件职责与 API

### core/catalog
- `listSessions({q, cwd, model})`：合并索引与磁盘扫描，按 id 去重（标题取最新），支持过滤
- 索引与磁盘不一致时以磁盘为准

### core/reader
- `readSession(id)`：定位 `sessions/**/*.jsonl`，解析为 `{id, title, cwd, provider, model, createdAt, updatedAt, messages[], filePath}`
- 坏行跳过并计数（不整文件失败）

### core/mutate（全部含备份与路径防护）
- `renameSession(id, newTitle)`：更新 `session_index.jsonl` 对应行（先备份）
- `archiveSession(id)`：移动 jsonl 到 `archived_sessions/`，并从活跃索引移除/标记
- `deleteSession(id)`：移动到 `~/.codex/.csm-trash/`（**不物理删除**）
- 写前检查：读后 mtime 变化 → 抛 409 冲突；文件 mtime 距今 < 30s（活跃写入中）默认拒绝，可 `force`

### core/export
- `exportSession(id, fmt)`：`md`（对话日志）/ `json`（结构化）
- `buildResumeContext(id)`：标题 + cwd + 模型 + 首条用户目标 + 最近消息摘录的紧凑 Markdown

### core/stats
- `buildStats()`：按天/项目/模型统计会话数与消息数、字符量估算

### web/server（REST，全部走 core）
- `GET /api/sessions?q=&cwd=&model=`
- `GET /api/sessions/:id`
- `PATCH /api/sessions/:id`（body: `{title}`）
- `POST /api/sessions/:id/archive`
- `POST /api/sessions/:id/delete`（body: `{force?: boolean}`）
- `GET /api/sessions/:id/export?fmt=md|json`
- `GET /api/sessions/:id/resume`（返回 resume 上下文文本）
- `GET /api/stats`
- 全部接口要求 `Authorization: Bearer <token>`；服务只绑 `127.0.0.1`

### plugin（MCP stdio 工具，复用 core）
- `list_sessions {query?, cwd?, model?}`
- `get_session {id}`
- `rename_session {id, title}`
- `archive_session {id}`
- `delete_session {id, force?}`（工具描述中明示"软删除进回收站"）
- `export_session {id, format, outputPath?}`（返回导出文件路径）
- SKILL.md：说明工具用途、适用场景、安全语义

## 6. 数据流

```
浏览器面板 ──REST──▶ web/server ──▶ core ──▶ ~/.codex 文件
Codex 模型 ──MCP──▶ plugin/server ──▶ core ──▶ ~/.codex 文件
```

前端：原生 HTML/CSS/JS，页面含会话列表（搜索/过滤）、详情（消息流）、
统计看板、重命名/归档/删除按钮、"复制恢复上下文"按钮（navigator.clipboard，localhost 为安全上下文）。

## 7. 安全与容错

- 所有路径解析锚定在 `CODEX_HOME` 内（防路径穿越）
- 删除 = 移入 `.csm-trash/`；归档 = 移入官方 `archived_sessions/`；从不 `rm` 原始文件
- 每次变更前备份受影响文件到 `CODEX_HOME/.csm-backups/<yyyyMMdd-HHmmss>/`
- 409 冲突检测（读后写前 mtime 变化）；活跃会话（30s 内被写）默认拒绝变更，可用 `force`
- 统计只读，永不触碰文件
- Web 仅绑 `127.0.0.1` + 随机 bearer token + 同源 CORS
- 修改 `config.toml` 前先备份；只追加 `/调整` `[marketplaces]`/`[plugins]` 相关条目，不动用户现有配置

## 8. 测试策略

- **core**：fixture jsonl（按真实 schema 构造）跑单测——解析、去重、过滤、rename/archive/delete、
  路径防护、409 冲突、30s 活跃防护、导出与 resume 上下文正确性
- **plugin**：进程内直接调用 MCP 工具函数（不经 stdio），验证工具输入/输出契约
- **web**：临时 `CODEX_HOME` + 随机端口，`fetch` 验证 REST 契约与鉴权（401/200/409）
- 所有测试不触碰真实 `~/.codex`

## 9. 插件安装（`npm run install:plugin`）

1. 创建本地 marketplace 目录（如 `~/.codex/marketplaces/csm/`）并放入 plugin 包结构
2. 备份 `~/.codex/config.toml`
3. 追加 `[marketplaces.csm] source_type="local" source="<marketplace 路径>"` 与
   `[plugins."session-manager@csm"] enabled=true`（若已存在则更新而非重复追加）
4. 提示重启 Codex Desktop 生效；同时提供 `npm run uninstall:plugin` 回滚

## 10. 明确不做（YAGNI）

- 不做 Resume 深度集成（MVP 用复制粘贴，见需求表）
- 不做会话全文全文检索索引（先顺序解析过滤；量大再做倒排）
- 不做多用户/服务部署（本地单机工具）
- 不做真实物理删除（回收站足以覆盖需求）