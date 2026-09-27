# codex-session-manager (CSM)

Codex Desktop 会话管理器：**本地 Web 面板** + **Codex 官方插件**（MCP 工具 + skill），共享同一个 core 库。

## 功能
- 📋 会话列表：标题/关键字/项目目录/模型过滤，含归档
- 🔍 会话详情：完整消息流、工具调用统计、tokens
- ✏️ 重命名 / 📦 归档（官方 archived_sessions/）/ 🗑️ 软删除（.csm-trash/，先备份）
- ⬇️ 导出 Markdown / JSON
- 📋 一键复制「恢复上下文」，粘到 Codex 新会话接着干
- 📊 统计看板：按天/项目/模型/供应商
- 🔌 Codex 插件：在对话里直接让模型查/改/导出会话（6 个 MCP 工具）

## 快速开始
```bash
npm install
npm test                # 全部测试（使用临时 CODEX_HOME，不碰真实数据）
npm run web             # 启动面板，打开终端打印的 http://127.0.0.1:4173/?token=...
                        # token 每次启动随机；想固定：CSM_TOKEN=mytoken npm run web → 打开 http://127.0.0.1:4173/?token=mytoken
                        # 注意：URL 必须带 ?token=，否则页面只显示常驻的排查提示（不渲染列表）
npm run install:plugin  # 安装 Codex 插件（自动备份 config.toml），重启 Codex Desktop
npm run uninstall:plugin
```

## 安全设计
- 只监听 127.0.0.1 + 随机 bearer token
- 会话写操作（重命名/归档/删除）先备份到 `~/.codex/.csm-backups/`；插件安装的 `config.toml` 备份为同目录下 `config.toml.bak-csm-<时间戳>`
- 删除 = 移入回收站，绝不物理删除；归档 = 移入官方归档目录
- 30 秒内活跃写入的会话默认拒绝变更（`force` 可越过）
- 读后写前 mtime 校验（冲突返回 409）

## 结构
`packages/core`（数据读写）· `packages/web`（面板）· `packages/plugin`（Codex 插件）
设计文档与实施计划见 `docs/plans/`。
