---
name: session-manager
description: 管理 Codex 历史会话——查询/搜索会话列表、读取会话内容、重命名、归档、软删除、导出 MD/JSON。当用户提到"找之前那个会话""上次我们做到哪了""整理/清理会话""把会话导出""重命名/归档/删除某会话"时使用。
---

# Session Manager

通过 `session_manager` MCP server 提供 6 个工具：

| 工具 | 用途 | 注意 |
|---|---|---|
| list_sessions | 列出/搜索会话 | 参数 query/cwd/model |
| get_session | 读取会话全文 | 参数 id；消息多时输出较长 |
| rename_session | 重命名 | 参数 id+title；自动备份索引 |
| archive_session | 归档 | 移入 archived_sessions/（官方语义，可逆） |
| delete_session | 软删除 | 移入 .csm-trash/，**不是物理删除** |
| export_session | 导出 | format=md/json；默认写 ~/.codex/exports/；outputPath 仅限 CODEX_HOME 内 |

## 使用流程
1. 用户描述模糊时先 `list_sessions` 用关键字缩小范围，把候选（标题+时间+项目）列给用户确认。
2. 需要回顾内容时 `get_session`；用户要继续之前的工作时，总结该会话的目标与进展，建议用户在新会话中粘贴继续。
3. 批量清理时**逐个确认**再执行 archive/delete；30 秒内活跃写入的会话会被拒绝（code=active），提醒用户先关闭对应会话。

## 安全语义（务必向用户传达）
- 所有写操作自动备份到 ~/.codex/.csm-backups/
- delete 是移入回收站，可手动找回
- 绝不修改会话 jsonl 内容本身，重命名只写标题索引

## 体积与性能（务必遵守）
- `list_sessions` 在大语料下响应可达上百 KB：**永远先用 `query`/`cwd`/`model` 过滤**，不要无过滤地全量拉取。
- `get_session` 返回完整消息流，长会话最坏可达 ~0.7MB（数十万 tokens）：回顾或迁移长会话时**优先 `export_session` 落地成文件**再按需读取片段，别把全文直接灌进上下文。

## 归档/删除后的可见性（务必向用户说明）
- `list_sessions` **只列活跃会话**：一旦 `archive_session`/`delete_session`，会话即**从列表消失**，且**没有任何 MCP 工具能重新列出归档区/回收站里的会话**。
- 但只要还记得 **id**，仍可对它调 `get_session`/`rename_session`/`export_session`（id 可在归档/删除前从列表记下，或从导出文件里查）。
- **没有 restore/undelete 工具**：归档=移入 `archived_sessions/`、删除=移入 `.csm-trash/`（都先自动备份到 `.csm-backups/`）；如需恢复，请手动把对应 jsonl 移回 `sessions/`。
- 注：`get_session` 返回的 `archived` 字段对"已归档"与"在回收站"都为 `true`（v0.1 不区分二者）。
