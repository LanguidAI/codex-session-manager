# Codex 会话管理器（CSM）Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 Codex Desktop 用户提供会话管理能力：本地 Web 面板（列表/搜索/统计/重命名/归档/软删除/导出/复制恢复上下文）+ Codex 官方插件（6 个 MCP 工具 + SKILL.md），共享同一个 core 库。

**Architecture:** npm workspaces 单体仓库（方案 A）。`packages/core` 是零依赖纯 ESM 库，负责所有 `~/.codex` 文件读写（可被 `CODEX_HOME` 环境变量重定向）；`packages/web` 用 Node 内置 `http` 提供 REST API + 原生前端；`packages/plugin` 是 Codex 官方插件（`.codex-plugin/plugin.json` + MCP stdio server + skill），MCP 工具直接复用 core。所有写操作先备份、软删除进回收站、活跃会话防冲突。

**Tech Stack:** Node ≥ 22（本机 v25.2.1，原生 ESM + `node:test`）、`@modelcontextprotocol/sdk` + `zod`（仅 plugin 依赖）、原生 HTML/CSS/JS 前端（无构建）。

**设计文档:** `docs/plans/2026-09-26-codex-session-manager-design.md`（已批准）

**仓库:** `/Users/xuxianxian/Documents/test/codex-session-manager`（git remote 已配置为 `ssh://git@ssh.github.com:443/LanguidAI/codex-session-manager.git`，推送用 `git push` 即可；**github.com:443 HTTPS 在本网络被墙，勿改回 HTTPS remote**）

---

## 背景事实（实施者必读，全部来自真实环境采样）

### Codex 数据格式

1. **`$CODEX_HOME/session_index.jsonl`**（默认 `~/.codex/`）— 每行一个 JSON：
   ```json
   {"id":"019daf28-767c-7002-808c-b917cc682505","thread_name":"介绍自己","updated_at":"2026-04-21T08:29:35.343959Z"}
   ```
   同一 id 可出现多行（改名历史），**后出现的行生效**。文件可能不存在。

2. **`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<时间串>-<session_id>.jsonl`** — 完整会话，每行：
   ```json
   {"timestamp":"...","ordinal":0,"type":"session_meta","payload":{"session_id":"...","id":"...","timestamp":"...","cwd":"/path","originator":"Codex Desktop","cli_version":"0.131.0-alpha.9","source":"vscode","model_provider":"azure","base_instructions":{...超大...}}}
   ```
   行 type 共 4 种：
   - `session_meta`（第 0 行，payload 含 cwd/provider/版本；**注意 base_instructions 可能超 64KB，不能按固定字节截断读**）
   - `turn_context`（payload 含 `model`，如 `"gpt-5.5"`，出现很早）
   - `response_item`（payload.type: `message`{role: developer|user|assistant, content:[{type: input_text|output_text, text}]}、`reasoning`、`function_call`{name,arguments,call_id}、`function_call_output`、`custom_tool_call`{name,input}、`custom_tool_call_output`）
   - `event_msg`（payload.type: `task_started`、`item_completed`{item:{type:"UserMessage",content:[{type:"text",text}]}}、`token_count`{info:{total_token_usage:{input_tokens,output_tokens,total_tokens,...}}}、`task_complete`{last_agent_message}）

3. **⚠️ 用户消息的两个来源**：`response_item` 里 role=user 的消息**多数是上下文注入**（以 `# AGENTS.md instructions`、`<permissions`、`<user_instructions`、`<environment_context` 开头）；**真实用户输入**在 `event_msg/item_completed` 且 `item.type === "UserMessage"`。解析规则：两者都收集并打 source 标记，若存在 item 来源则丢弃 response 来源的 user 消息；若无 item 来源（旧版 CLI 文件），回退用 response 来源但过滤注入前缀。assistant 消息只来自 `response_item` role=assistant。

4. **`$CODEX_HOME/archived_sessions/`** — 官方归档目录（Desktop 自己就是把文件移进来）。

5. **⚠️ 子代理线程的双 id**（Task 4 质量审查实测，190/709 文件）：subagent 派生线程（`thread_source: "subagent"`）的 `payload.session_id` = **父线程** id，`payload.id` = **自身** id；rollout 文件名 UUID 与 `session_index.jsonl` 的键都是**自身 id**（423 个索引 id 中 420 个匹配 payload.id，仅 371 个匹配 session_id）。**规范 id 一律取 `payload.id ?? payload.session_id`**（所有实测文件都有 payload.id；session_id 仅作老文件回退）。

6. **⚠️ resume 分片文件**（实测 6 个 id 共 16 个文件）：同一线程恢复续写会生成多个 `rollout-<ts>-<threadId>_<forkUuid>.jsonl`，`payload.id` 相同；且 Desktop **不因 resume 刷新索引** updated_at（实测比文件 mtime 旧 6 天）。因此：列表**按 id 去重、保留 mtime 最新**的记录；`updatedAt = max(索引时间, mtime)`；`findSessionFile` 在同一 location 内取 **mtime 最新**的文件（location 优先级 active > archived > trash 不变）。

7. **时间戳精度不齐**：索引 `updated_at` 小数位有 4/5/6 位（546 行中 11/50/485），mtime ISO 恒 3 位 —— 排序与比较必须用**数值时间戳**（`Date.parse` / `mtimeMs`），字符串比较在同一秒内会翻转。索引 `updated_at` 还可能是非字符串脏值，读取时需类型守卫。

### Codex 插件/市场格式（从 openai-bundled 实物采样）

- 市场目录：`<market>/.agents/plugins/marketplace.json`：
  ```json
  {"name":"csm","interface":{"displayName":"..."},"plugins":[{"name":"session-manager","source":{"source":"local","path":"./plugins/session-manager"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Productivity"}]}
  ```
- 插件目录：`<market>/plugins/<name>/` 内含 `.codex-plugin/plugin.json`（字段：name/version/description/author/license/keywords/`"mcpServers":"./.mcp.json"`/`"skills":"./skills/"`/interface{displayName,shortDescription,longDescription,developerName,category,capabilities}）、`skills/<skill>/SKILL.md`、`.mcp.json`（`{"mcpServers":{"<srv>":{"command","args","cwd","default_tools_approval_mode","tools":{"<tool>":{"approval_mode":"prompt"}}}}}`）。
- 启用：`~/.codex/config.toml` 中 `[marketplaces.csm]`（`source_type="local"` + `source="<市场目录绝对路径>"`）和 `[plugins."session-manager@csm"]`（`enabled=true`）。

### 环境约束

- Node v25.2.1、npm registry 可达；`node --test <目录>` 会递归找 `*.test.js`（helpers 子目录里的 `fixture.js` 不会被当成测试）。
- 所有测试必须用临时 `CODEX_HOME`（`mkdtemp`），**禁止触碰真实 `~/.codex`**。

---

### Task 1: Workspace 脚手架

**Files:**
- Create: `package.json`、`.gitignore`、`README.md`、`packages/core/package.json`、`packages/web/package.json`、`packages/plugin/package.json`

**Step 1: 写根 package.json**

```json
{
  "name": "codex-session-manager",
  "private": true,
  "type": "module",
  "workspaces": ["packages/core", "packages/web", "packages/plugin"],
  "scripts": {
    "test": "node --test 'packages/*/tests/*.test.js'",
    "web": "node packages/web/server.mjs",
    "install:plugin": "node packages/plugin/install.mjs",
    "uninstall:plugin": "node packages/plugin/install.mjs --uninstall"
  }
}
```

> 修订（2026-09-26）：Node 25 的 `node --test <目录>` 不再展开目录（会把目录当单个测试文件执行而失败），改用引号 glob；node 自身解析通配，未匹配的包目录（tests 为空/不存在）容忍且退出码 0。

**Step 2: 写三个子包 package.json**

`packages/core/package.json`:
```json
{
  "name": "@csm/core",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.js" }
}
```

`packages/web/package.json`:
```json
{
  "name": "@csm/web",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "dependencies": { "@csm/core": "*" }
}
```

`packages/plugin/package.json`:
```json
{
  "name": "@csm/plugin",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "dependencies": {
    "@csm/core": "*",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.25.0"
  }
}
```

> 注：若 `npm install` 报 sdk 与 zod 版本 peer 冲突，以 `npm ls zod` 显示 sdk 实际依赖的 zod 大版本为准，调整 plugin 的 zod 依赖后重装。

**Step 3: 写 .gitignore 和 README 占位**

`.gitignore`:
```
node_modules/
.DS_Store
*.log
```

`README.md`（占位，Task 13 补全）:
```markdown
# codex-session-manager

Codex 会话管理器：Web 面板 + Codex 官方插件。实施中，见 docs/plans/。
```

**Step 4: 安装依赖并验证 workspace 链接**

Run: `cd /Users/xuxianxian/Documents/test/codex-session-manager && npm install`
Expected: 生成 `package-lock.json` 与 `node_modules/`，无 error（warn 可忽略）

Run: `ls node_modules/@csm`
Expected: 列出 `core`、`plugin`、`web` 三个符号链接

**Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore README.md packages/core/package.json packages/web/package.json packages/plugin/package.json
git commit -m "chore: workspace 脚手架（core/web/plugin 三包）"
```

---

### Task 2: core — errors + paths

**Files:**
- Create: `packages/core/src/errors.js`、`packages/core/src/paths.js`
- Test: `packages/core/tests/paths.test.js`

**Step 1: 写失败测试** `packages/core/tests/paths.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { anchor, codexHome, layout } from '../src/paths.js'

test('codexHome: 显式覆盖 > 环境变量 > ~/.codex', () => {
  assert.equal(codexHome('/x/y'), '/x/y')
  process.env.CODEX_HOME = '/tmp/fake-codex-home'
  try {
    assert.equal(codexHome(), '/tmp/fake-codex-home')
  } finally {
    delete process.env.CODEX_HOME
  }
  assert.equal(codexHome(), join(process.env.HOME, '.codex'))
})

test('layout: 标准目录映射', () => {
  const l = layout('/h')
  assert.equal(l.index, '/h/session_index.jsonl')
  assert.equal(l.sessionsDir, '/h/sessions')
  assert.equal(l.archivedDir, '/h/archived_sessions')
  assert.equal(l.trashDir, '/h/.csm-trash')
  assert.equal(l.backupsDir, '/h/.csm-backups')
})

test('anchor: 根内解析放行', () => {
  assert.equal(anchor('/root', 'sub/a.txt'), '/root/sub/a.txt')
  assert.equal(anchor('/root', '/root/b.txt'), '/root/b.txt')
})

test('anchor: 逃逸路径抛错', () => {
  assert.throws(() => anchor('/root', '../outside'), /escapes/)
  assert.throws(() => anchor('/root', '/etc/passwd'), /escapes/)
  assert.throws(() => anchor('/root', 'sub/../../etc'), /escapes/)
})
```

**Step 2: 跑测试确认失败**

Run: `node --test packages/core/tests/paths.test.js`
Expected: FAIL，报错 `Cannot find module '.../src/paths.js'`

**Step 3: 最小实现**

`packages/core/src/errors.js`:
```js
/** 带机器可读 code 的领域错误（not_found/conflict/active/invalid）。 */
export class CsmError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CsmError'
    this.code = code
  }
}
```

`packages/core/src/paths.js`:
```js
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 解析 Codex 数据根目录：显式覆盖 > $CODEX_HOME > ~/.codex。 */
export function codexHome(override) {
  return resolve(override ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'))
}

/** CODEX_HOME 下的标准目录布局。 */
export function layout(home) {
  return {
    home,
    index: join(home, 'session_index.jsonl'),
    sessionsDir: join(home, 'sessions'),
    archivedDir: join(home, 'archived_sessions'),
    trashDir: join(home, '.csm-trash'),
    backupsDir: join(home, '.csm-backups'),
  }
}

/** 把 p 解析到 root 内；结果逃逸 root 时抛错（路径穿越防护）。 */
export function anchor(root, p) {
  const resolved = isAbsolute(p) ? resolve(p) : resolve(root, p)
  const rel = relative(root, resolved)
  if (rel !== '' && (rel === '..' || rel.startsWith('..' + sep))) {
    throw new Error(`path escapes CODEX_HOME: ${p}`)
  }
  return resolved
}
```

**Step 4: 跑测试确认通过**

Run: `node --test packages/core/tests/paths.test.js`
Expected: PASS（4 tests）

**Step 5: Commit**

```bash
git add packages/core/src/errors.js packages/core/src/paths.js packages/core/tests/paths.test.js
git commit -m "feat(core): CODEX_HOME 解析、目录布局与路径锚定防护"
```

### Task 2 修订（质量审查修正，后续任务以本节为准）

质量审查发现 3 个 Important 问题，以 fix 提交修正：

1. `anchor()` 原为纯词法包含检查，符号链接可绕过 → 增加 **realpath 归一后的包含检查**（不存在的路径按最近存在祖先归一）
2. `anchor()` 原抛普通 `Error`（无 code，web 层会映射成 500）→ 改抛 **`CsmError('invalid')`**，消息文案与 root 解耦
3. `codexHome()` 空字符串 override/env 会静默解析为 CWD → **空白值视为未设置**，回退 `~/.codex`

配套决定（对应审查跨任务问题）：Task 10 的 `export_session.outputPath` **必须经过 `anchor`** 锚定在 CODEX_HOME 内（Task 10 文本已同步更新）。

**paths.js（修订后完整实现，取代上文 Step 3 的 paths.js）：**

```js
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CsmError } from './errors.js'

/** 解析 Codex 数据根目录：显式覆盖 > $CODEX_HOME > ~/.codex；空白值视为未设置。 */
export function codexHome(override) {
  for (const candidate of [override, process.env.CODEX_HOME]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return resolve(candidate)
  }
  return resolve(join(homedir(), '.codex'))
}

/** CODEX_HOME 下的标准目录布局。 */
export function layout(home) {
  return {
    home,
    index: join(home, 'session_index.jsonl'),
    sessionsDir: join(home, 'sessions'),
    archivedDir: join(home, 'archived_sessions'),
    trashDir: join(home, '.csm-trash'),
    backupsDir: join(home, '.csm-backups'),
  }
}

/**
 * 把 p 解析到 root 内；逃逸时抛 CsmError('invalid')（路径穿越防护）。
 * 双重检查：词法 relative 包含 + realpath 归一后包含（防符号链接逃逸）。
 * 不存在的目标路径按最近存在的祖先目录归一。
 */
export function anchor(root, p) {
  const resolved = isAbsolute(p) ? resolve(p) : resolve(root, p)
  assertInside(root, resolved, p)
  assertInside(realpathSafe(root), realpathSafe(resolved), p)
  return resolved
}

function assertInside(root, resolved, original) {
  const rel = relative(root, resolved)
  if (rel !== '' && (rel === '..' || rel.startsWith('..' + sep))) {
    throw new CsmError('invalid', `path escapes root: ${original}`)
  }
}

/** realpath 目标路径；ENOENT/ENOTDIR 时向上回溯到最近存在的祖先后拼接剩余尾部。 */
function realpathSafe(p) {
  let cur = resolve(p)
  const tail = []
  for (;;) {
    try {
      const real = realpathSync(cur)
      return tail.length === 0 ? real : join(real, ...tail.reverse())
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e
      const parent = dirname(cur)
      if (parent === cur) return cur
      tail.push(basename(cur))
      cur = parent
    }
  }
}
```

**paths.test.js（修订后完整测试，取代上文 Step 1，共 6 个用例）：**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { anchor, codexHome, layout } from '../src/paths.js'

test('codexHome: 显式覆盖 > 环境变量 > ~/.codex；空白值视为未设置', () => {
  const saved = process.env.CODEX_HOME
  delete process.env.CODEX_HOME
  try {
    assert.equal(codexHome('/x/y'), '/x/y')
    process.env.CODEX_HOME = '/tmp/fake-codex-home'
    assert.equal(codexHome(), '/tmp/fake-codex-home')
    assert.equal(codexHome('   '), '/tmp/fake-codex-home', '空白 override 落到 env')
    process.env.CODEX_HOME = ''
    assert.equal(codexHome(), join(homedir(), '.codex'), '空白 env 落到默认')
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = saved
  }
})

test('layout: 标准目录映射（完整键集）', () => {
  assert.deepEqual(layout('/h'), {
    home: '/h',
    index: '/h/session_index.jsonl',
    sessionsDir: '/h/sessions',
    archivedDir: '/h/archived_sessions',
    trashDir: '/h/.csm-trash',
    backupsDir: '/h/.csm-backups',
  })
})

test('anchor: 根内解析放行（根自身、..foo 前缀碰撞）', () => {
  assert.equal(anchor('/root', 'sub/a.txt'), '/root/sub/a.txt')
  assert.equal(anchor('/root', '/root/b.txt'), '/root/b.txt')
  assert.equal(anchor('/root', '/root'), '/root')
  assert.equal(anchor('/root', '..foo'), '/root/..foo')
})

test('anchor: 逃逸路径抛 CsmError(invalid)', () => {
  for (const p of ['../outside', '/etc/passwd', 'sub/../../etc']) {
    assert.throws(() => anchor('/root', p), (e) => e.code === 'invalid' && /escapes/.test(e.message), `应拒绝: ${p}`)
  }
})

test('anchor: 符号链接逃逸被 realpath 包含检查拦截', async () => {
  const root = await mkdtemp(join(tmpdir(), 'csm-anchor-'))
  await symlink('/etc', join(root, 'link'))
  assert.throws(() => anchor(root, 'link/passwd'), (e) => e.code === 'invalid')
  assert.throws(() => anchor(root, 'link/nope-deep/file'), (e) => e.code === 'invalid')
  await writeFile(join(root, 'ok.txt'), 'x')
  assert.equal(anchor(root, 'ok.txt'), join(root, 'ok.txt'))
})

test('anchor: 根内不存在的路径放行（按最近存在祖先归一）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'csm-anchor-'))
  assert.equal(anchor(root, 'future/dir/file.txt'), join(root, 'future/dir/file.txt'))
})
```

---

### Task 3: core — 测试夹具 + reader（会话解析）

**Files:**
- Create: `packages/core/tests/helpers/fixture.js`、`packages/core/src/reader.js`
- Test: `packages/core/tests/reader.test.js`

**Step 1: 写夹具** `packages/core/tests/helpers/fixture.js`（按真实 schema 构造）

```js
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** 新建一个临时 CODEX_HOME。 */
export async function makeHome() {
  return mkdtemp(join(tmpdir(), 'csm-test-'))
}

/** 按真实 rollout schema 生成会话文件内容。 */
export function rolloutLines({
  id,
  cwd = '/proj/alpha',
  model = 'gpt-5.5',
  provider = 'azure',
  userText = '帮我修登录 bug',
  assistantText = '已修复并补了回归测试。',
  createdAt = '2026-05-20T12:00:00.000Z',
  tokens = 4200,
}) {
  const L = (ordinal, type, payload) => JSON.stringify({ timestamp: createdAt, ordinal, type, payload })
  return [
    L(0, 'session_meta', { session_id: id, id, timestamp: createdAt, cwd, originator: 'Codex Desktop', cli_version: '0.131.0', source: 'vscode', thread_source: 'user', model_provider: provider, base_instructions: { text: 'x'.repeat(200) } }),
    L(1, 'turn_context', { turn_id: 'turn-1', cwd, model, approval_policy: 'never' }),
    L(2, 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions> sandbox on' }] }),
    L(3, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${cwd}` }] }),
    L(4, 'event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'item-1', content: [{ type: 'text', text: userText }] } }),
    L(5, 'response_item', { type: 'function_call', name: 'exec_command', arguments: '{}', call_id: 'c1' }),
    L(6, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistantText }] }),
    L(7, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: tokens, output_tokens: 0, total_tokens: tokens } } }),
  ].join('\n') + '\n'
}

/** 会话文件相对 CODEX_HOME 的路径（YYYY/MM/DD 目录 + rollout 文件名含 id）。 */
export function sessionRelPath(id, day = '2026-05-20') {
  const [y, m, d] = day.split('-')
  return join('sessions', y, m, d, `rollout-${day}T00-00-00-${id}.jsonl`)
}

/** 写入一个会话文件，返回绝对路径。 */
export async function writeSession(home, opts) {
  const p = join(home, sessionRelPath(opts.id, opts.day))
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, rolloutLines(opts))
  return p
}

/** 写 session_index.jsonl（entries: [{id, thread_name, updated_at}]）。 */
export async function writeIndex(home, entries) {
  await writeFile(join(home, 'session_index.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

/** 把文件 mtime 拨回过去，避开 30 秒活跃写入防护。 */
export async function backdate(path, ms = 120_000) {
  const t = new Date(Date.now() - ms)
  await utimes(path, t, t)
}
```

**Step 2: 写失败测试** `packages/core/tests/reader.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionContent } from '../src/reader.js'
import { rolloutLines } from './helpers/fixture.js'

test('解析 meta/model/消息/工具/tokens', () => {
  const s = parseSessionContent(rolloutLines({ id: 'sid-1', cwd: '/proj/x', model: 'gpt-5.5', provider: 'azure', userText: '目标A', assistantText: '完成A', tokens: 99 }))
  assert.equal(s.id, 'sid-1')
  assert.equal(s.cwd, '/proj/x')
  assert.equal(s.model, 'gpt-5.5')
  assert.equal(s.provider, 'azure')
  assert.equal(s.tokens, 99)
  assert.equal(s.badLines, 0)
  const users = s.messages.filter((m) => m.role === 'user')
  assert.equal(users.length, 1, 'item_completed 用户消息生效，注入与 response_item 重复项被去掉')
  assert.equal(users[0].text, '目标A')
  assert.equal(s.messages.find((m) => m.role === 'assistant').text, '完成A')
  assert.deepEqual(s.toolCalls, ['exec_command'])
})

test('无 item_completed 时回退 response_item user 并过滤注入', () => {
  const lines = [
    JSON.stringify({ timestamp: 't', ordinal: 0, type: 'session_meta', payload: { session_id: 's2', id: 's2', cwd: '/p' } }),
    JSON.stringify({ timestamp: 't', ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /p' }] } }),
    JSON.stringify({ timestamp: 't', ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '真正的问题' }] } }),
  ].join('\n')
  const s = parseSessionContent(lines)
  assert.equal(s.messages.length, 1)
  assert.equal(s.messages[0].text, '真正的问题')
})

test('坏行计数不致命', () => {
  const s = parseSessionContent('not json\n' + rolloutLines({ id: 's3' }))
  assert.equal(s.badLines, 1)
  assert.equal(s.id, 's3')
})
```

**Step 3: 跑测试确认失败**

Run: `node --test packages/core/tests/reader.test.js`
Expected: FAIL，`Cannot find module '.../src/reader.js'`

**Step 4: 实现** `packages/core/src/reader.js`

```js
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
```

**Step 5: 跑测试确认通过**

Run: `node --test packages/core/tests/reader.test.js`
Expected: PASS（3 tests）

**Step 6: Commit**

```bash
git add packages/core/tests/helpers/fixture.js packages/core/src/reader.js packages/core/tests/reader.test.js
git commit -m "feat(core): rollout jsonl 解析器（双源用户消息去重 + fastMeta 流式头读）"
```

### Task 3 修订（质量审查修正，后续任务以本节为准）

质量审查用真实 `~/.codex` 语料（650 个 rollout 文件 / 4.8 GB，只读）实证后发现 1 个 Critical + 4 个 Important，以 fix 提交修正：

1. **Critical**：`readSessionFile` 整文件 `readFile` —— 真实语料存在 1030 MB 会话（超过 Node 字符串上限，抛无 code 的 RangeError），147 MB 文件峰值 RSS 1.8 GB → 改为 **readline 流式解析**（导出名不变，下游 API 零改动）；ENOENT 转 `CsmError('not_found')` 供 web 层映射 404
2. `null` 等**非对象 JSON 行**会让 `parseSessionContent`/`fastMeta` 抛 TypeError（违反"坏行只计数"契约）→ 类型守卫，计入 badLines / 跳过
3. **注入前缀表不全**：真实回退模式会话中 `<recommended_plugins>` 必然泄漏（37 处），另有 `<codex_internal_context>`/`<subagent_notification>`/`<turn_aborted>` 等实测标签 → 前缀表扩充至 14 项
4. **model 语义不一致**：`parseSessionContent` 原取最后一个 turn_context、`fastMeta` 取第一个（真实语料 2.9% 会话中途换模型，列表页与详情页会打架）→ 统一 **first-wins**（会话起始模型）
5. **fastMeta/readSessionFile 零直接测试** → reader.test.js 从 3 个用例扩到 **9 个**（含 >64KB 超长行、maxLines 界限、null 行、updatedAt=最后时间戳、not_found）

配套修订：Task 4 的 `listSessions`/`findSessionFile` 对单文件 `fastMeta`/`stat` 失败改为 **try/catch 跳过**（上文 Task 4 代码已更新）——扫描期间文件可能被 Codex 删除/移动。

语料实测事实（供后续任务参考，勿再重复测量）：fastMeta 全库扫描 650 文件/4.8 GB 仅 1.37 s（Task 4 无需缓存）；消息顺序 = 文件顺序且时间戳单调（export/resume 可信赖）；47/650 会话走 response 回退源（回退分支不是死代码）。

**reader.js（修订后完整实现，取代上文 Step 4）：**

```js
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
  if (line === null || typeof line !== 'object') {
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
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity })
  let scanned = 0
  try {
    for await (const raw of rl) {
      if (++scanned > maxLines) break
      if (!raw.trim()) continue
      let line
      try { line = JSON.parse(raw) } catch { continue }
      if (line === null || typeof line !== 'object') continue
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
```

**reader.test.js（修订后完整测试，取代上文 Step 2，共 9 个用例）：**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fastMeta, parseSessionContent, readSessionFile } from '../src/reader.js'
import { makeHome, rolloutLines } from './helpers/fixture.js'

test('解析 meta/model/消息/工具/tokens', () => {
  const s = parseSessionContent(rolloutLines({ id: 'sid-1', cwd: '/proj/x', model: 'gpt-5.5', provider: 'azure', userText: '目标A', assistantText: '完成A', tokens: 99 }))
  assert.equal(s.id, 'sid-1')
  assert.equal(s.cwd, '/proj/x')
  assert.equal(s.model, 'gpt-5.5')
  assert.equal(s.provider, 'azure')
  assert.equal(s.tokens, 99)
  assert.equal(s.badLines, 0)
  const users = s.messages.filter((m) => m.role === 'user')
  assert.equal(users.length, 1, 'item_completed 用户消息生效，注入与 response_item 重复项被去掉')
  assert.equal(users[0].text, '目标A')
  assert.equal(s.messages.find((m) => m.role === 'assistant').text, '完成A')
  assert.deepEqual(s.toolCalls, ['exec_command'])
})

test('无 item_completed 时回退 response_item user 并过滤注入', () => {
  const lines = [
    JSON.stringify({ timestamp: 't', ordinal: 0, type: 'session_meta', payload: { session_id: 's2', id: 's2', cwd: '/p' } }),
    JSON.stringify({ timestamp: 't', ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /p' }] } }),
    JSON.stringify({ timestamp: 't', ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '真正的问题' }] } }),
  ].join('\n')
  const s = parseSessionContent(lines)
  assert.equal(s.messages.length, 1)
  assert.equal(s.messages[0].text, '真正的问题')
})

test('坏行计数不致命', () => {
  const s = parseSessionContent('not json\n' + rolloutLines({ id: 's3' }))
  assert.equal(s.badLines, 1)
  assert.equal(s.id, 's3')
})

test('扩充注入前缀：<recommended_plugins 等在回退模式被过滤', () => {
  const U = (ordinal, text) => JSON.stringify({ timestamp: 't', ordinal, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
  const lines = [
    JSON.stringify({ timestamp: 't', ordinal: 0, type: 'session_meta', payload: { session_id: 's4', id: 's4', cwd: '/p' } }),
    U(1, '<recommended_plugins> 试试这些插件'),
    U(2, '<turn_aborted> 已取消'),
    U(3, '<codex_internal_context source="goal"> 内部目标'),
    U(4, '接下来做什么'),
  ].join('\n')
  const s = parseSessionContent(lines)
  assert.equal(s.messages.length, 1)
  assert.equal(s.messages[0].text, '接下来做什么')
})

test('model 语义一致：parseSessionContent 与 fastMeta 均取第一个 turn_context', async () => {
  const home = await makeHome()
  const content = [
    JSON.stringify({ timestamp: 't1', ordinal: 0, type: 'session_meta', payload: { session_id: 'm1', id: 'm1', cwd: '/p' } }),
    JSON.stringify({ timestamp: 't2', ordinal: 1, type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    JSON.stringify({ timestamp: 't3', ordinal: 2, type: 'turn_context', payload: { model: 'gpt-5.6-codex' } }),
  ].join('\n') + '\n'
  assert.equal(parseSessionContent(content).model, 'gpt-5.5')
  const p = join(home, 'two-models.jsonl')
  await writeFile(p, content)
  assert.equal((await fastMeta(p)).model, 'gpt-5.5')
})

test('非对象 JSON 行（null/标量）计入 badLines 且不崩溃', async () => {
  const s = parseSessionContent('null\n123\n"str"\ntrue\n' + rolloutLines({ id: 's5' }))
  assert.equal(s.badLines, 4)
  assert.equal(s.id, 's5')
  const home = await makeHome()
  const p = join(home, 'nulls.jsonl')
  await writeFile(p, 'null\n' + rolloutLines({ id: 's6' }))
  assert.equal((await fastMeta(p)).id, 's6', 'fastMeta 跳过 null 行不抛错')
})

test('fastMeta: turn_context 缺失或超出 maxLines 时 model 为 null；maxLines 可覆盖', async () => {
  const home = await makeHome()
  const noTc = join(home, 'no-tc.jsonl')
  await writeFile(noTc, JSON.stringify({ timestamp: 't', ordinal: 0, type: 'session_meta', payload: { session_id: 'f1', id: 'f1', cwd: '/p', model_provider: 'azure' } }) + '\n')
  assert.equal((await fastMeta(noTc)).model, null)
  const lateTc = join(home, 'late-tc.jsonl')
  const lines = [JSON.stringify({ timestamp: 't', ordinal: 0, type: 'session_meta', payload: { session_id: 'f2', id: 'f2', cwd: '/p' } })]
  for (let i = 1; i <= 250; i++) lines.push(JSON.stringify({ timestamp: 't', ordinal: i, type: 'event_msg', payload: { type: 'task_started' } }))
  lines.push(JSON.stringify({ timestamp: 't', ordinal: 251, type: 'turn_context', payload: { model: 'gpt-9' } }))
  await writeFile(lateTc, lines.join('\n') + '\n')
  assert.equal((await fastMeta(lateTc)).model, null, '默认 200 行界限内找不到')
  assert.equal((await fastMeta(lateTc, { maxLines: 300 })).model, 'gpt-9')
})

test('fastMeta: 超长单行（>64KB）不截断', async () => {
  const home = await makeHome()
  const p = join(home, 'big-meta.jsonl')
  const content = JSON.stringify({ timestamp: 't', ordinal: 0, type: 'session_meta', payload: { session_id: 'big1', id: 'big1', cwd: '/p', model_provider: 'azure', base_instructions: { text: 'x'.repeat(100_000) } } })
    + '\n' + JSON.stringify({ timestamp: 't', ordinal: 1, type: 'turn_context', payload: { model: 'gpt-5.5' } }) + '\n'
  await writeFile(p, content)
  const meta = await fastMeta(p)
  assert.equal(meta.id, 'big1')
  assert.equal(meta.model, 'gpt-5.5')
})

test('readSessionFile: 流式解析、updatedAt=最后时间戳、文件不存在抛 not_found', async () => {
  const home = await makeHome()
  const p = join(home, 'detail.jsonl')
  const content = [
    JSON.stringify({ timestamp: '2026-05-20T12:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { session_id: 'd1', id: 'd1', cwd: '/proj/d', originator: 'Codex Desktop', cli_version: '0.131.0', model_provider: 'azure' } }),
    JSON.stringify({ timestamp: '2026-05-20T12:00:01.000Z', ordinal: 1, type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    JSON.stringify({ timestamp: '2026-05-20T12:00:02.000Z', ordinal: 2, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '第一问' }] } } }),
    JSON.stringify({ timestamp: '2026-05-20T12:05:00.000Z', ordinal: 3, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 77 } } } }),
  ].join('\n') + '\n'
  await writeFile(p, content)
  const s = await readSessionFile(p)
  assert.equal(s.id, 'd1')
  assert.equal(s.originator, 'Codex Desktop')
  assert.equal(s.cliVersion, '0.131.0')
  assert.equal(s.createdAt, '2026-05-20T12:00:00.000Z')
  assert.equal(s.updatedAt, '2026-05-20T12:05:00.000Z')
  assert.equal(s.tokens, 77)
  assert.equal(s.messages.length, 1)
  assert.equal(s.messages[0].text, '第一问')
  await assert.rejects(() => readSessionFile(join(home, 'missing.jsonl')), (e) => e.code === 'not_found')
})
```

**Task 3 复审遗留条件（在 Task 4 Step 0 落地）**：复审实测发现 `fastMeta` 提前 break（找齐 id+model / maxLines 界限）时每次调用泄漏 1 个 fd——`rl.close()` 不销毁底层输入流；800 次调用泄漏 800 fd，常见 `ulimit -n 256/1024` 下 Task 4 全库扫描会 EMFILE，且 try/catch 容错会**静默吞掉**该错误导致列表缺会话。修复方案（已在 /tmp 复本验证 fd 持平）：`fastMeta` 持有 `stream` 引用，`finally` 中 `rl.close()` 后补 `stream.destroy()`；顺带把**数组行**计入坏行（`Array.isArray` 守卫）。reader.test.js 增加 fd 稳定回归测试（第 10 用例）。`readSessionFile` 全量读到 EOF、流自动关闭，实测不泄漏，不改。

---

### Task 4: core — catalog（索引合并 + 列表 + 定位）

**Files:**
- Modify: `packages/core/src/reader.js`（Step 0 遗留条件）
- Modify: `packages/core/tests/reader.test.js`（Step 0 回归测试）
- Create: `packages/core/src/catalog.js`
- Test: `packages/core/tests/catalog.test.js`

**Step 0（Task 3 复审遗留条件：fastMeta fd 泄漏修复，先于本任务其余步骤完成）**

`reader.js` 的 `fastMeta` 替换为（持有 stream 引用 + finally destroy；数组行跳过）：

```js
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
```

同文件 `handleLine` 的守卫改为：`if (line === null || typeof line !== 'object' || Array.isArray(line)) {`（数组行计入 badLines）。

`reader.test.js` 两处修改：
1. 原「非对象 JSON 行」用例改名并扩充——输入 `'null\n123\n"str"\ntrue\n[]\n' + rolloutLines({ id: 's5' })`，断言 `badLines` 为 **5**，用例名改为 `'非对象 JSON 行（null/标量/数组）计入 badLines 且不崩溃'`
2. 文件顶部增加 `import { readdirSync } from 'node:fs'`，末尾追加第 10 个用例：

```js
test('fastMeta: 提前 break 不泄漏 fd（stream.destroy 回收）', async () => {
  const home = await makeHome()
  const p = join(home, 'fd.jsonl')
  await writeFile(p, rolloutLines({ id: 'fd1' }))
  const countFds = () => readdirSync('/dev/fd').length
  const before = countFds()
  for (let i = 0; i < 200; i++) await fastMeta(p) // 找齐 id+model 提前退出
  for (let i = 0; i < 200; i++) await fastMeta(p, { maxLines: 1 }) // maxLines break 路径
  const after = countFds()
  assert.ok(after - before <= 5, `fd 应保持稳定: before=${before} after=${after}`)
})
```

验证：`node --test "packages/core/tests/*.test.js"` → **16/16 PASS**（paths 6 + reader 10）。

**测试修订（2026-09-26，实施中发现）**：① 原排序用例依赖墙钟——b 无索引条目时 updatedAt 回退为文件 mtime（=测试运行时刻），恒排在 2026-05-21 的索引日期之前，断言永不成立；改为用 `backdate` 把 b 拨回固定过去时刻，确定性成立（原稿遗漏该行，未使用的 backdate 导入即其痕迹）。② 原 findSessionFile 用例的 trash 分支未真实覆盖（文件被移到 home 根而非 `.csm-trash/`）；改为真实移入 trashDir 并断言 location='trash'。③ 移除未使用的 `sessionRelPath` 导入。

**Step 1: 写失败测试** `packages/core/tests/catalog.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { findSessionFile, listSessions, readIndex } from '../src/catalog.js'
import { layout } from '../src/paths.js'
import { backdate, makeHome, writeIndex, writeSession } from './helpers/fixture.js'

test('readIndex: 同 id 多行取最后；文件缺失返回空 Map', async () => {
  const home = await makeHome()
  assert.equal((await readIndex(home)).size, 0)
  await writeIndex(home, [
    { id: 'a', thread_name: '旧名', updated_at: '2026-05-20T12:00:00Z' },
    { id: 'a', thread_name: '新名', updated_at: '2026-05-20T13:00:00Z' },
  ])
  const idx = await readIndex(home)
  assert.equal(idx.get('a').title, '新名')
})

test('listSessions: 索引标题合并 + 未命名回退 + 按 updatedAt 倒序', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'a', day: '2026-05-20' })
  const pb = await writeSession(home, { id: 'b', day: '2026-05-21', cwd: '/proj/beta' })
  await backdate(pb, Date.now() - Date.parse('2026-05-21T12:00:00Z')) // b 无索引条目→mtime 兜底；拨回固定过去保证确定性
  await writeIndex(home, [{ id: 'a', thread_name: '修复登录', updated_at: '2026-05-21T20:00:00Z' }])
  const list = await listSessions({ home })
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'a', '索引 updatedAt 更晚的排前面')
  assert.equal(list[0].title, '修复登录')
  assert.equal(list[1].title, '(未命名)')
  assert.equal(list[1].cwd, '/proj/beta')
})

test('listSessions: q/cwd/model 过滤', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'a', cwd: '/proj/alpha', model: 'gpt-5.5', day: '2026-05-20' })
  await writeSession(home, { id: 'b', cwd: '/proj/beta', model: 'gpt-5.6', day: '2026-05-21' })
  await writeIndex(home, [{ id: 'a', thread_name: '登录问题', updated_at: '2026-05-20T12:00:00Z' }])
  assert.equal((await listSessions({ home, q: '登录' })).length, 1)
  assert.equal((await listSessions({ home, cwd: '/proj/beta' })).length, 1)
  assert.equal((await listSessions({ home, model: 'gpt-5.5' })).length, 1)
  assert.equal((await listSessions({ home, q: 'zzz不存在' })).length, 0)
})

test('listSessions: 归档目录默认不含，includeArchived 含且带 archived 标记', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  const l = layout(home)
  await mkdir(l.archivedDir, { recursive: true })
  await rename(p, join(l.archivedDir, 'rollout-a.jsonl'))
  assert.equal((await listSessions({ home })).length, 0)
  const withArchived = await listSessions({ home, includeArchived: true })
  assert.equal(withArchived.length, 1)
  assert.equal(withArchived[0].archived, true)
})

test('findSessionFile: active/archived/trash 定位与 location 标记', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  const found = await findSessionFile(home, 'a')
  assert.equal(found.location, 'active')
  assert.equal(found.path, p)
  assert.ok(found.mtimeMs > 0)
  const l = layout(home)
  await mkdir(l.archivedDir, { recursive: true })
  await rename(p, join(l.archivedDir, 'rollout-a.jsonl'))
  assert.equal((await findSessionFile(home, 'a')).location, 'archived')
  await mkdir(l.trashDir, { recursive: true })
  await rename(join(l.archivedDir, 'rollout-a.jsonl'), join(l.trashDir, 'rollout-a.jsonl'))
  assert.equal((await findSessionFile(home, 'a')).location, 'trash', '回收站也能定位')
  assert.equal(await findSessionFile(home, 'nope'), null)
})

test('sessions 目录不存在 → 空列表不报错', async () => {
  const home = await makeHome()
  assert.deepEqual(await listSessions({ home }), [])
})
```

**Step 2: 跑测试确认失败**

Run: `node --test packages/core/tests/catalog.test.js`
Expected: FAIL，`Cannot find module '.../src/catalog.js'`

**Step 3: 实现** `packages/core/src/catalog.js`

```js
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fastMeta } from './reader.js'
import { layout } from './paths.js'

/** 读 session_index.jsonl → Map<id, {title, updatedAt}>；同 id 后行覆盖前行。 */
export async function readIndex(home) {
  const map = new Map()
  let content
  try {
    content = await readFile(layout(home).index, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return map
    throw e
  }
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue
    let entry
    try { entry = JSON.parse(raw) } catch { continue }
    if (typeof entry?.id === 'string') {
      map.set(entry.id, { title: entry.thread_name ?? null, updatedAt: entry.updated_at ?? null })
    }
  }
  return map
}

/** 递归遍历目录下所有 .jsonl 文件；目录不存在时产出空。 */
async function* walkJsonl(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return
    throw e
  }
  for (const ent of entries) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) yield* walkJsonl(p)
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) yield p
  }
}

/**
 * 列出会话（索引标题 + 磁盘元数据合并，磁盘为准）。
 * @returns {Promise<Array>} 按 updatedAt 倒序的会话摘要
 */
export async function listSessions({ home, q, cwd, model, includeArchived = false } = {}) {
  const l = layout(home)
  const index = await readIndex(home)
  const dirs = includeArchived
    ? [[l.sessionsDir, false], [l.archivedDir, true]]
    : [[l.sessionsDir, false]]
  const out = []
  for (const [dir, archived] of dirs) {
    for await (const p of walkJsonl(dir)) {
      // 单文件读取失败（扫描期间被 Codex 删除/权限/符号链接环等）跳过，不打断整个列表（审查修订）
      let meta
      let st
      try {
        meta = await fastMeta(p)
        st = await stat(p)
      } catch { continue }
      if (!meta.id) continue
      const idx = index.get(meta.id)
      const rec = {
        id: meta.id,
        title: idx?.title ?? '(未命名)',
        cwd: meta.cwd,
        provider: meta.provider,
        model: meta.model,
        createdAt: meta.createdAt,
        updatedAt: idx?.updatedAt ?? st.mtime.toISOString(),
        size: st.size,
        archived,
        path: p,
      }
      if (q && !`${rec.title} ${rec.id} ${rec.cwd ?? ''}`.toLowerCase().includes(String(q).toLowerCase())) continue
      if (cwd && !(rec.cwd ?? '').includes(cwd)) continue
      if (model && rec.model !== model) continue
      out.push(rec)
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  return out
}

/**
 * 按 id 定位会话文件；文件名含 id 才打开解析（性能护栏）。
 * @returns {Promise<null | {path: string, location: 'active'|'archived'|'trash', mtimeMs: number, size: number}>}
 */
export async function findSessionFile(home, id) {
  const l = layout(home)
  for (const [dir, location] of [[l.sessionsDir, 'active'], [l.archivedDir, 'archived'], [l.trashDir, 'trash']]) {
    for await (const p of walkJsonl(dir)) {
      if (!basename(p).includes(id)) continue
      // 单文件读取失败跳过继续找（审查修订）
      try {
        const meta = await fastMeta(p)
        if (meta.id !== id) continue
        const st = await stat(p)
        return { path: p, location, mtimeMs: st.mtimeMs, size: st.size }
      } catch { continue }
    }
  }
  return null
}
```

**Step 4: 跑测试确认通过**

Run: `node --test packages/core/tests/catalog.test.js`
Expected: PASS（6 tests）

**Step 5: Commit**

```bash
git add packages/core/src/catalog.js packages/core/tests/catalog.test.js
git commit -m "feat(core): 会话目录（索引合并、过滤搜索、active/archived/trash 定位）"
```

### Task 4 修订（质量审查修正，后续任务以本节为准）

质量审查用真实语料实证了 2 个 Critical + 2 个 Important + 若干 Minor，以 fix 提交修正（对应背景事实第 5/6/7 条）：

- **C1**：规范 id 优先级写反——子代理线程 `session_id`=父线程 id、`payload.id`=自身 id；原实现 `session_id ?? id` 使 27% 真实会话无法按 id 定位（findSessionFile→null）、列表挂父线程标题、52 行重复 id。修正：`p.id ?? p.session_id`（reader.js 两处）。
- **C2**：resume 分片（同 id 多文件）无去重——列表重复 N 行、findSessionFile 返回 readdir 顺序的任意（实测陈旧 6 天）文件；设计文档 §5 本就要求按 id 去重。修正：listSessions 按 id 保留 mtime 最新记录；findSessionFile 同 location 取 mtime 最新。
- **I1**：索引 updated_at 优先违反"磁盘为准"（resume 不刷索引 → 今天用过的线程排到 6 天前）。修正：`updatedAt = max(索引时间, mtime)`。
- **I2**：裸 `catch { continue }` 会静默吞掉编程错误（TypeError 等）导致会话无声消失。修正：仅容忍带 `.code` 的文件系统错误，其余上抛。
- **M1**：字符串比较排序在混合小数精度下同一秒内翻转；索引脏值（非字符串 updated_at）泄漏。修正：数值 sortMs 排序 + readIndex 类型守卫。
- **M2**：q 跨字段拼接误匹配、cwd 大小写敏感。修正：逐字段匹配、cwd 双侧小写。
- **M4**：`findSessionFile(home, '')` 全树扫描。修正：空/非字符串 id 直接返回 null。

**reader.js 两处 id 优先级（C1）：**

- `handleLine` 的 session_meta 分支：`session.id = p.session_id ?? p.id ?? session.id` → `session.id = p.id ?? p.session_id ?? session.id // 规范 id：payload.id 为线程自身 id；子代理线程的 session_id 是父线程（语料实测）`
- `fastMeta` 的 session_meta 分支：`meta.id = p.session_id ?? p.id ?? meta.id` → `meta.id = p.id ?? p.session_id ?? meta.id`

**tests/helpers/fixture.js 三处扩展（子代理 + resume 形态）：**

1. `rolloutLines` 解构参数增加 `parentId`（默认 undefined），session_meta 行改为 `session_id: parentId ?? id`（其余字段不变）。
2. `sessionRelPath` 增加第三参 `fork`：
```js
/** 会话文件相对 CODEX_HOME 的路径（YYYY/MM/DD 目录 + rollout 文件名含 id；fork 模拟 resume 分片）。 */
export function sessionRelPath(id, day = '2026-05-20', fork) {
  const [y, m, d] = day.split('-')
  return join('sessions', y, m, d, `rollout-${day}T00-00-00-${id}${fork ? `_${fork}` : ''}.jsonl`)
}
```
3. `writeSession` 透传 fork：`const p = join(home, sessionRelPath(opts.id, opts.day, opts.fork))`（其余不变）。

**catalog.js（修订后完整实现，取代上文 Step 3）：**

```js
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fastMeta } from './reader.js'
import { layout } from './paths.js'

/** 读 session_index.jsonl → Map<id, {title, updatedAt}>；同 id 后行覆盖前行；非字符串 updated_at 视为无。 */
export async function readIndex(home) {
  const map = new Map()
  let content
  try {
    content = await readFile(layout(home).index, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return map
    throw e
  }
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue
    let entry
    try { entry = JSON.parse(raw) } catch { continue }
    if (typeof entry?.id === 'string') {
      map.set(entry.id, {
        title: entry.thread_name ?? null,
        updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : null,
      })
    }
  }
  return map
}

/**
 * 递归遍历目录下所有 .jsonl 文件；目录不存在（ENOENT）时产出空。
 * 其他目录级错误（如 EACCES）上抛——失败要响亮，不静默缺会话。
 * 符号链接目录/文件不跟随（Dirent.isDirectory/isFile 对 symlink 均为 false）。
 */
async function* walkJsonl(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return
    throw e
  }
  for (const ent of entries) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) yield* walkJsonl(p)
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) yield p
  }
}

/** 文件系统级错误（带 .code：ENOENT/EACCES/EMFILE/ELOOP 等）可按文件跳过；编程错误上抛，避免静默吞 bug。 */
function isFsError(e) {
  return typeof e?.code === 'string'
}

/**
 * 列出会话（索引标题 + 磁盘元数据合并，磁盘为准）。
 * 审查修订：同 id（resume 分片）去重保留 mtime 最新记录；
 * updatedAt 取索引时间与 mtime 的较新者（索引不因 resume 刷新，不能遮蔽磁盘活动）；
 * 排序用数值时间戳（索引小数精度不齐，字符串比较不可靠）。
 * @returns {Promise<Array>} 按 updatedAt 倒序的会话摘要
 */
export async function listSessions({ home, q, cwd, model, includeArchived = false } = {}) {
  const l = layout(home)
  const index = await readIndex(home)
  const dirs = includeArchived
    ? [[l.sessionsDir, false], [l.archivedDir, true]]
    : [[l.sessionsDir, false]]
  const byId = new Map()
  for (const [dir, archived] of dirs) {
    for await (const p of walkJsonl(dir)) {
      // 单文件读取失败（扫描期间被 Codex 删除/权限/符号链接环等）跳过，不打断整个列表（审查修订）
      let meta
      let st
      try {
        meta = await fastMeta(p)
        st = await stat(p)
      } catch (e) {
        if (isFsError(e)) continue
        throw e
      }
      if (!meta.id) continue
      const idx = index.get(meta.id)
      const idxMs = idx?.updatedAt ? Date.parse(idx.updatedAt) : NaN
      const useIndex = Number.isFinite(idxMs) && idxMs > st.mtimeMs
      const rec = {
        id: meta.id,
        title: idx?.title ?? '(未命名)',
        cwd: meta.cwd,
        provider: meta.provider,
        model: meta.model,
        createdAt: meta.createdAt,
        updatedAt: useIndex ? idx.updatedAt : st.mtime.toISOString(),
        size: st.size,
        archived,
        path: p,
        // 内部字段（返回前删除）：排序用数值时间戳、去重/较新比较用 mtime
        sortMs: useIndex ? idxMs : st.mtimeMs,
        mtimeMs: st.mtimeMs,
      }
      if (q) {
        const needle = String(q).toLowerCase()
        const hit = [rec.title, rec.id, rec.cwd ?? ''].some((f) => String(f).toLowerCase().includes(needle))
        if (!hit) continue
      }
      if (cwd && !(rec.cwd ?? '').toLowerCase().includes(String(cwd).toLowerCase())) continue
      if (model && rec.model !== model) continue
      const prev = byId.get(rec.id)
      if (!prev || rec.mtimeMs > prev.mtimeMs) byId.set(rec.id, rec)
    }
  }
  const out = [...byId.values()]
  out.sort((a, b) => b.sortMs - a.sortMs)
  for (const rec of out) {
    delete rec.sortMs
    delete rec.mtimeMs
  }
  return out
}

/**
 * 按 id 定位会话文件；文件名含 id 才打开解析（性能护栏）。
 * 审查修订：同 id 多文件（resume 分片）返回该 location 内 mtime 最新者（不再依赖 readdir 顺序）；
 * location 优先级 active > archived > trash；空/非字符串 id 直接返回 null。
 * @returns {Promise<null | {path: string, location: 'active'|'archived'|'trash', mtimeMs: number, size: number}>}
 */
export async function findSessionFile(home, id) {
  if (typeof id !== 'string' || id === '') return null
  const l = layout(home)
  for (const [dir, location] of [[l.sessionsDir, 'active'], [l.archivedDir, 'archived'], [l.trashDir, 'trash']]) {
    let best = null
    for await (const p of walkJsonl(dir)) {
      if (!basename(p).includes(id)) continue
      // 单文件读取失败跳过继续找（审查修订）
      try {
        const meta = await fastMeta(p)
        if (meta.id !== id) continue
        const st = await stat(p)
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = { path: p, location, mtimeMs: st.mtimeMs, size: st.size }
        }
      } catch (e) {
        if (isFsError(e)) continue
        throw e
      }
    }
    if (best) return best
  }
  return null
}
```

**reader.test.js 追加第 11 个用例（C1 回归）：**

```js
test('子代理线程：规范 id 取 payload.id（session_id 是父线程）', async () => {
  const content = rolloutLines({ id: 'own-1', parentId: 'parent-9' })
  assert.equal(parseSessionContent(content).id, 'own-1')
  const home = await makeHome()
  const p = join(home, 'sub.jsonl')
  await writeFile(p, content)
  assert.equal((await fastMeta(p)).id, 'own-1')
})
```

**catalog.test.js：第 2 个用例改为（双 backdate 确定性 + 索引较新断言）：**

```js
test('listSessions: 索引标题合并 + 未命名回退 + 按 updatedAt 倒序', async () => {
  const home = await makeHome()
  const pa = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(pa, Date.now() - Date.parse('2026-05-20T12:00:00Z'))
  const pb = await writeSession(home, { id: 'b', day: '2026-05-21', cwd: '/proj/beta' })
  await backdate(pb, Date.now() - Date.parse('2026-05-21T12:00:00Z'))
  await writeIndex(home, [{ id: 'a', thread_name: '修复登录', updated_at: '2026-05-21T20:00:00Z' }])
  const list = await listSessions({ home })
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'a', '索引 updatedAt（05-21T20）比 b 的 mtime（05-21T12）新 → 排前')
  assert.equal(list[0].title, '修复登录')
  assert.equal(list[0].updatedAt, '2026-05-21T20:00:00Z', '索引较新时用索引值')
  assert.equal(list[1].title, '(未命名)')
  assert.equal(list[1].cwd, '/proj/beta')
})
```

**catalog.test.js：追加 3 个用例（C1/C2/I1 回归，共 9 个）：**

```js
test('子代理线程：payload.id 为规范 id，列表与定位都用自身 id（审查 C1）', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'child-own', parentId: 'parent-1', day: '2026-05-20' })
  await writeIndex(home, [{ id: 'child-own', thread_name: '子任务', updated_at: '2026-05-20T12:00:00Z' }])
  const list = await listSessions({ home })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'child-own', '用自身 id 而非 session_id（父线程）')
  assert.equal(list[0].title, '子任务')
  assert.equal((await findSessionFile(home, 'child-own')).location, 'active')
  assert.equal(await findSessionFile(home, 'parent-1'), null, '父线程 id 不应误指向子线程文件')
})

test('resume 分片：列表按 id 去重保留最新，findSessionFile 返回 mtime 最新文件（审查 C2）', async () => {
  const home = await makeHome()
  const p1 = await writeSession(home, { id: 'r1', day: '2026-05-20', fork: 'fork-a' })
  await backdate(p1, Date.now() - Date.parse('2026-05-20T00:00:00Z'))
  const p2 = await writeSession(home, { id: 'r1', day: '2026-05-21', fork: 'fork-b' })
  await backdate(p2, Date.now() - Date.parse('2026-05-21T00:00:00Z'))
  const list = await listSessions({ home })
  assert.equal(list.length, 1, '同 id 去重为一条')
  assert.equal(list[0].path, p2, '保留 mtime 最新的记录')
  const found = await findSessionFile(home, 'r1')
  assert.equal(found.path, p2, '定位 mtime 最新文件，不依赖 readdir 顺序')
})

test('updatedAt 取索引与 mtime 较新者；非字符串索引时间回退磁盘（审查 I1/M1）', async () => {
  const home = await makeHome()
  const p1 = await writeSession(home, { id: 'u1', day: '2026-05-20' })
  await backdate(p1, Date.now() - Date.parse('2026-05-24T00:00:00Z')) // mtime 比索引新
  const p2 = await writeSession(home, { id: 'u2', day: '2026-05-20' })
  await backdate(p2, Date.now() - Date.parse('2026-05-22T00:00:00Z'))
  await writeIndex(home, [
    { id: 'u1', thread_name: '旧索引', updated_at: '2026-05-20T00:00:00Z' },
    { id: 'u2', thread_name: '脏行', updated_at: 12345 },
  ])
  const list = await listSessions({ home })
  const u1 = list.find((r) => r.id === 'u1')
  const u2 = list.find((r) => r.id === 'u2')
  assert.equal(u1.title, '旧索引')
  assert.ok(u1.updatedAt.startsWith('2026-05-24'), 'mtime 比索引新 → 用 mtime')
  assert.ok(u2.updatedAt.startsWith('2026-05-22'), '非字符串索引时间 → 回退 mtime')
  assert.equal(list[0].id, 'u1', 'u1（05-24）排在 u2（05-22）前')
})
```

修订后套件规模：paths 6 + reader 11 + catalog 9 = **26 tests**。

**Task 8 备注（审查建议 #4，实施 Task 8 时落实）**：web 变更路由应透传 `expectedMtimeMs`（前端从 detail 的 `mtimeMs` 取得后随请求回传），否则 Task 5 的冲突防护在 web 路径上是死代码。

---

### Task 5: core — mutate（重命名 / 归档 / 软删除 + 备份 + 防护）

**Files:**
- Create: `packages/core/src/mutate.js`
- Modify: `packages/core/src/catalog.js`（前置修订：新增 `findSessionFiles`，见下）
- Test: `packages/core/tests/mutate.test.js`

**前置修订（2026-09-26，控制器预审，基于 Task 4 审查实证）：**

1. **分片整体移动**：Task 4 审查实证 resume 分片（同 id 多文件）真实存在（语料 6 id/16 文件）。若归档/删除只移动 `findSessionFile` 返回的单个最新文件，旧分片仍留在活跃列表——用户看到"归档了却还在列表里"。修正：catalog.js 新增 `findSessionFiles(home, id)` 返回**全部**匹配文件（location 优先级 active > archived > trash 分组、组内 mtime 降序），`findSessionFile` 重构为其薄封装（取首元素，行为不变）；`archiveSession`/`deleteSession` 移动**主 location 的全部同 id 文件**（`expectedMtimeMs` 只约束主文件，其余分片只做活跃防护）。
2. **目的地防碰撞**：`fsRename` 遇同名目标会**静默覆盖**且被覆盖方无备份（违反"绝不丢数据"设计原则）。修正：`uniqueDest()` 在目标已存在时于扩展名前插入 `-<毫秒时间戳>-<序号>`。
3. **备份目录防同名**：备份目录名追加 4 位随机十六进制后缀，避免同一毫秒内两次变更互相覆盖备份。

**catalog.js 修订（替换现有 `findSessionFile` 函数为以下两个函数，其余不动）：**

```js
/**
 * 按 id 找出全部文件（含 resume 分片），按 location 优先级（active > archived > trash）分组、
 * 组内按 mtime 降序。首元素与 findSessionFile 的返回语义一致。
 * @returns {Promise<Array<{path: string, location: 'active'|'archived'|'trash', mtimeMs: number, size: number}>>}
 */
export async function findSessionFiles(home, id) {
  if (typeof id !== 'string' || id === '') return []
  const l = layout(home)
  const out = []
  for (const [dir, location] of [[l.sessionsDir, 'active'], [l.archivedDir, 'archived'], [l.trashDir, 'trash']]) {
    const group = []
    for await (const p of walkJsonl(dir)) {
      if (!basename(p).includes(id)) continue
      // 单文件读取失败跳过继续找（审查修订）
      try {
        const meta = await fastMeta(p)
        if (meta.id !== id) continue
        const st = await stat(p)
        group.push({ path: p, location, mtimeMs: st.mtimeMs, size: st.size })
      } catch (e) {
        if (isFsError(e)) continue
        throw e
      }
    }
    group.sort((a, b) => b.mtimeMs - a.mtimeMs)
    out.push(...group)
  }
  return out
}

/**
 * 按 id 定位会话文件；文件名含 id 才打开解析（性能护栏）。
 * 同 id 多文件（resume 分片）返回优先级最高 location 中 mtime 最新者。
 * @returns {Promise<null | {path: string, location: 'active'|'archived'|'trash', mtimeMs: number, size: number}>}
 */
export async function findSessionFile(home, id) {
  const matches = await findSessionFiles(home, id)
  return matches.length > 0 ? matches[0] : null
}
```

**Step 1: 写失败测试** `packages/core/tests/mutate.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findSessionFile, listSessions, readIndex } from '../src/catalog.js'
import { archiveSession, deleteSession, renameSession } from '../src/mutate.js'
import { layout } from '../src/paths.js'
import { backdate, makeHome, writeIndex, writeSession } from './helpers/fixture.js'

test('rename: 追加索引行，catalog 反映新标题，索引先备份', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  await writeIndex(home, [{ id: 'a', thread_name: '旧名', updated_at: '2026-05-20T12:00:00Z' }])
  await renameSession({ home, id: 'a', title: ' 新名字 ' })
  const idx = await readIndex(home)
  assert.equal(idx.get('a').title, '新名字', 'trim 后写入')
  const list = await listSessions({ home })
  assert.equal(list[0].title, '新名字')
  const backups = await readdir(layout(home).backupsDir)
  assert.equal(backups.length, 1)
  const backupFiles = await readdir(join(layout(home).backupsDir, backups[0]))
  assert.ok(backupFiles.includes('session_index.jsonl'))
})

test('rename: 未知 id → not_found；空标题 / 非字符串 id → invalid', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'a', day: '2026-05-20' })
  await assert.rejects(() => renameSession({ home, id: 'nope', title: 'x' }), (e) => e.code === 'not_found')
  await assert.rejects(() => renameSession({ home, id: 'a', title: '   ' }), (e) => e.code === 'invalid')
  await assert.rejects(() => renameSession({ home, id: 123, title: 'x' }), (e) => e.code === 'invalid', '非字符串 id → invalid（审查 I5）')
})

test('archive: 移入 archived_sessions，活跃列表消失，归档列表出现', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  const r = await archiveSession({ home, id: 'a' })
  assert.equal(r.location, 'archived')
  assert.equal((await listSessions({ home })).length, 0)
  const archived = await listSessions({ home, includeArchived: true })
  assert.equal(archived.length, 1)
  assert.equal(archived[0].archived, true)
  await stat(join(layout(home).archivedDir, 'rollout-2026-05-20T00-00-00-a.jsonl'))
  await assert.rejects(() => archiveSession({ home, id: 'a' }), (e) => e.code === 'invalid')
})

test('delete: 软删除移入 .csm-trash + 备份原文件', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  const r = await deleteSession({ home, id: 'a' })
  assert.equal(r.location, 'trash')
  assert.equal((await listSessions({ home, includeArchived: true })).length, 0)
  assert.equal((await findSessionFile(home, 'a')).location, 'trash')
  const backups = await readdir(layout(home).backupsDir)
  const backupFiles = await readdir(join(layout(home).backupsDir, backups[0]))
  assert.ok(backupFiles.some((f) => f.includes('rollout-')))
  await assert.rejects(() => deleteSession({ home, id: 'a' }), (e) => e.code === 'invalid')
})

test('活跃防护: 30 秒内被写过的文件默认拒绝，force 可越过', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'fresh', day: '2026-05-20' })
  await backdate(p, 5_000) // 5 秒前——仍在 30s 窗口内；固定偏移避免同毫秒竞态（审查修正）
  await assert.rejects(() => archiveSession({ home, id: 'fresh' }), (e) => e.code === 'active')
  const r = await archiveSession({ home, id: 'fresh', force: true })
  assert.equal(r.location, 'archived')
})

test('冲突防护: expectedMtimeMs 不符 → conflict', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  await assert.rejects(
    () => archiveSession({ home, id: 'a', expectedMtimeMs: 12345 }),
    (e) => e.code === 'conflict',
  )
})

test('resume 分片: 归档一次移走全部文件，活跃列表不再出现该线程', async () => {
  const home = await makeHome()
  const p1 = await writeSession(home, { id: 'r1', day: '2026-05-20', fork: 'fork-a' })
  await backdate(p1)
  const p2 = await writeSession(home, { id: 'r1', day: '2026-05-21', fork: 'fork-b' })
  await backdate(p2)
  const r = await archiveSession({ home, id: 'r1' })
  assert.equal(r.location, 'archived')
  assert.equal((await listSessions({ home })).length, 0, '活跃列表不再有该 id（两个分片都被移走）')
  const names = await readdir(layout(home).archivedDir)
  assert.equal(names.length, 2, '两个分片都进了归档目录')
  assert.equal((await findSessionFile(home, 'r1')).location, 'archived')
})

test('目的地重名: 不覆盖归档目录已有文件（前置修订 2）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  const l = layout(home)
  await mkdir(l.archivedDir, { recursive: true })
  const squatter = join(l.archivedDir, 'rollout-2026-05-20T00-00-00-a.jsonl')
  await writeFile(squatter, 'PRE-EXISTING\n')
  const r = await archiveSession({ home, id: 'a' })
  assert.notEqual(r.path, squatter, '重名时换用不冲突的目的名')
  assert.equal(await readFile(squatter, 'utf8'), 'PRE-EXISTING\n', '已有文件未被覆盖')
  await stat(r.path)
})

test('活跃防护: 同一毫秒写入的文件也必须拒绝（审查修正：age 负值夹紧）', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'now', day: '2026-05-20' }) // mtime ≈ now，可能与 Date.now() 同毫秒
  await assert.rejects(() => archiveSession({ home, id: 'now' }), (e) => e.code === 'active')
})

test('备份完整性: 软删除后备份与 trash 内文件字节均与原文件一致（审查测试缺口 1）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  const original = await readFile(p)
  const r = await deleteSession({ home, id: 'a' })
  const backups = await readdir(layout(home).backupsDir)
  assert.equal(backups.length, 1)
  const backupFiles = await readdir(join(layout(home).backupsDir, backups[0]))
  const bf = backupFiles.find((f) => f.includes('rollout-'))
  assert.ok(bf, '备份目录内有 rollout 文件')
  assert.deepEqual(await readFile(join(layout(home).backupsDir, backups[0], bf)), original, '备份字节与原文件一致')
  assert.deepEqual(await readFile(r.path), original, 'trash 内文件字节与原文件一致')
})

test('冲突防护: expectedMtimeMs 相符 → 正常归档（审查测试缺口 2，正向路径）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  const st = await stat(p)
  const r = await archiveSession({ home, id: 'a', expectedMtimeMs: st.mtimeMs })
  assert.equal(r.location, 'archived')
})

test('delete: 跨 location 分片一并扫入 trash（审查 I1）', async () => {
  const home = await makeHome()
  const p1 = await writeSession(home, { id: 'm1', day: '2026-05-20', fork: 'orig' })
  await backdate(p1)
  await archiveSession({ home, id: 'm1' })
  // 模拟部分移动残留 / Desktop 侧又写：active 出现同 id 新分片
  const p2 = await writeSession(home, { id: 'm1', day: '2026-05-21', fork: 'new' })
  await backdate(p2)
  const r = await deleteSession({ home, id: 'm1' })
  assert.equal(r.location, 'trash')
  assert.equal((await listSessions({ home, includeArchived: true })).length, 0, 'active/archived 都不再残留分片')
  const names = await readdir(layout(home).trashDir)
  assert.equal(names.length, 2, '两个分片都进了 trash')
  assert.equal((await findSessionFile(home, 'm1')).location, 'trash')
})

test('rename: 索引末行无换行符也不粘连（审查 I2）', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'a', day: '2026-05-20' })
  await writeFile(layout(home).index, '{"id":"old","thread_name":"旧","updated_at":"2026-05-20T00:00:00Z"}') // 无尾换行
  await renameSession({ home, id: 'a', title: '新标题' })
  const idx = await readIndex(home)
  assert.equal(idx.get('a').title, '新标题', '新行独立可解析')
  assert.equal(idx.get('old').title, '旧', '原条目未被粘连吞掉')
})

test('冲突防护: expectedMtimeMs null 视为未提供、数值字符串被强转、垃圾值 → invalid（审查 I3）', async () => {
  const home = await makeHome()
  const pa = await writeSession(home, { id: 'sa', day: '2026-05-20' })
  await backdate(pa)
  assert.equal((await archiveSession({ home, id: 'sa', expectedMtimeMs: null })).location, 'archived', 'null → 视为未提供')
  const pb = await writeSession(home, { id: 'sb', day: '2026-05-20' })
  await backdate(pb)
  const stb = await stat(pb)
  assert.equal((await archiveSession({ home, id: 'sb', expectedMtimeMs: String(stb.mtimeMs) })).location, 'archived', '数值字符串被强转后相符')
  const pc = await writeSession(home, { id: 'sc', day: '2026-05-20' })
  await backdate(pc)
  await assert.rejects(() => archiveSession({ home, id: 'sc', expectedMtimeMs: 'abc' }), (e) => e.code === 'invalid', '非数值 → invalid')
})
```

**Step 2: 跑测试确认失败**

Run: `node --test packages/core/tests/mutate.test.js`
Expected: FAIL，`Cannot find module '.../src/mutate.js'`

**Step 3: 实现** `packages/core/src/mutate.js`（前置修订后完整实现）

```js
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, copyFile, mkdir, readFile, rename as fsRename, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { findSessionFiles } from './catalog.js'
import { CsmError } from './errors.js'
import { layout } from './paths.js'

/** 距上次写入不足该窗口的会话视为“正在使用”，默认拒绝变更。 */
const ACTIVE_WINDOW_MS = 30_000

/** 备份目录名：时间戳 + 随机后缀，避免同一毫秒内两次变更的备份互相覆盖（前置修订 3）。 */
function backupDirName() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`
}

/**
 * 把文件备份到 .csm-backups/<时间戳-随机>/ 下，返回备份路径。
 * COPYFILE_EXCL：备份目标已存在时拒绝覆盖——宁可响亮失败也不静默覆盖（审查 I7）。
 */
async function backupFile(home, filePath) {
  const dir = join(layout(home).backupsDir, backupDirName())
  await mkdir(dir, { recursive: true })
  const dest = join(dir, basename(filePath))
  await copyFile(filePath, dest, constants.COPYFILE_EXCL)
  return dest
}

/** 防碰撞目的名：目标已存在时在扩展名前插入 -<毫秒时间戳>-<序号>，绝不覆盖已有文件（前置修订 2）。 */
async function uniqueDest(dir, filePath) {
  const base = basename(filePath)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  let dest = join(dir, base)
  for (let i = 1; ; i++) {
    try {
      await stat(dest)
      dest = join(dir, `${stem}-${Date.now()}-${i}${ext}`)
    } catch {
      return dest
    }
  }
}

/** 移动前防护：mtime 与读取时不符 → conflict；30s 内活跃写入 → active（force 越过）。 */
async function guardMovable(filePath, { force, expectedMtimeMs } = {}) {
  const st = await stat(filePath)
  // 审查 I3：null/undefined 视为未提供；数值字符串强转；其余非数值 → invalid（避免 "expected X, got X" 式不可诊断假冲突）
  if (expectedMtimeMs != null) {
    const expected = Number(expectedMtimeMs)
    if (!Number.isFinite(expected)) {
      throw new CsmError('invalid', `expectedMtimeMs must be a finite number, got ${JSON.stringify(expectedMtimeMs)}`)
    }
    if (st.mtimeMs !== expected) {
      throw new CsmError('conflict', `session file changed since read (expected mtime ${expected}, got ${st.mtimeMs})`)
    }
  }
  // 审查修正：APFS mtime 带小数精度而 Date.now() 截断到整毫秒，同一毫秒内写入的文件 age 为微小负值；
  // 原 `age >= 0` 条件会放行最危险的“正在写入”场景。夹紧到 0：宁可误拒（force 可越过）不可漏放。
  const age = Math.max(0, Date.now() - st.mtimeMs)
  if (!force && age < ACTIVE_WINDOW_MS) {
    throw new CsmError('active', `会话 ${Math.round(age / 1000)} 秒前仍在写入，可能正被 Codex 使用；确认后可用 force=true 强制`)
  }
  return st
}

/**
 * 重命名：向 session_index.jsonl 追加新行（后行生效语义），追加前备份索引。
 * 审查 I2：索引末行缺换行符（写入中断产物）时先补 \n 再追加，避免粘连吞掉条目。
 * @returns {Promise<{id: string, title: string}>}
 */
export async function renameSession({ home, id, title }) {
  if (typeof id !== 'string' || id === '') throw new CsmError('invalid', 'id must be a non-empty string')
  const t = typeof title === 'string' ? title.trim() : ''
  if (!t) throw new CsmError('invalid', 'title is required')
  const matches = await findSessionFiles(home, id)
  if (matches.length === 0) throw new CsmError('not_found', `session ${id} not found`)
  const l = layout(home)
  let needsNewline = false
  try {
    const existing = await readFile(l.index)
    needsNewline = existing.length > 0 && existing[existing.length - 1] !== 0x0a
    await backupFile(home, l.index)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  await appendFile(l.index, (needsNewline ? '\n' : '') + JSON.stringify({ id, thread_name: t, updated_at: new Date().toISOString() }) + '\n')
  return { id, title: t }
}

/**
 * 归档：把会话 active 组的全部分片文件移入官方 archived_sessions/（与 Desktop 行为一致），逐个先备份。
 * @returns {Promise<{id: string, location: 'archived', path: string}>}
 */
export async function archiveSession({ home, id, force, expectedMtimeMs }) {
  return moveSession({ home, id, force, expectedMtimeMs, to: 'archived' })
}

/**
 * 删除：软删除，把会话的全部分片文件扫入 .csm-trash/（绝不物理删除），逐个先备份。
 * 审查 I1：跨 active/archived 一并扫走，保证“delete ⇒ 列表消失”契约成立。
 * @returns {Promise<{id: string, location: 'trash', path: string}>}
 */
export async function deleteSession({ home, id, force, expectedMtimeMs }) {
  return moveSession({ home, id, force, expectedMtimeMs, to: 'trash' })
}

/**
 * 共享移动逻辑：定位全部匹配 → location 校验 → 两阶段执行（审查 I4）：
 * 先逐文件防护（conflict/active）——可预期失败全部发生在任何写盘之前；
 * 再逐文件备份/防碰撞移动。expectedMtimeMs 只约束主文件（UI/工具读到的那个）。
 * 移动中被外部并发删除（ENOENT）→ conflict（重试可完成剩余分片）。
 */
async function moveSession({ home, id, force, expectedMtimeMs, to }) {
  if (typeof id !== 'string' || id === '') throw new CsmError('invalid', 'id must be a non-empty string')
  const l = layout(home)
  const matches = await findSessionFiles(home, id)
  if (matches.length === 0) throw new CsmError('not_found', `session ${id} not found`)
  const primary = matches[0]
  if (to === 'archived' && primary.location !== 'active') {
    throw new CsmError('invalid', `session is already ${primary.location}`)
  }
  if (to === 'trash' && primary.location === 'trash') {
    throw new CsmError('invalid', 'session is already in trash')
  }
  // archive 只移动主 location 组；delete 扫走全部尚未入 trash 的分片（审查 I1）
  const group = to === 'trash'
    ? matches.filter((m) => m.location !== 'trash')
    : matches.filter((m) => m.location === primary.location)
  const destDir = to === 'archived' ? l.archivedDir : l.trashDir
  await mkdir(destDir, { recursive: true })
  for (const m of group) {
    const isPrimary = m.path === primary.path
    await guardMovable(m.path, { force, expectedMtimeMs: isPrimary ? expectedMtimeMs : undefined })
  }
  let dest = null
  for (const m of group) {
    const d = await uniqueDest(destDir, m.path)
    try {
      await backupFile(home, m.path)
      await fsRename(m.path, d)
    } catch (e) {
      if (e?.code === 'ENOENT') {
        throw new CsmError('conflict', `session file vanished during operation, retry to finish: ${m.path}`)
      }
      throw e
    }
    if (m.path === primary.path) dest = d
  }
  return { id, location: to, path: dest }
}
```

**Step 4: 跑测试确认通过**

Run: `node --test packages/core/tests/mutate.test.js`
Expected: PASS（14 tests；连跑 5 次无不稳定——审查修正后活跃防护测试不再依赖同毫秒竞态）

Run: `node --test "packages/core/tests/*.test.js"`
Expected: PASS（40 tests：paths 6 + reader 11 + catalog 9 + mutate 14）

**审查修正（2026-09-26，规格审查实证）**：原 `guardMovable` 的 `age >= 0` 条件存在同毫秒旁路——APFS mtime 带小数、`Date.now()` 截断整毫秒，刚写入的文件 age 为微小负值被直接放行（实测 190/200 新文件负 age；独立运行 mutate 测试约 4/10 概率失败，全量套件因并行负载拉长写-读间隔而掩盖）。修正：age 夹紧为 `Math.max(0, …)`（宁可误拒，force 可越过）；「活跃防护」测试改用固定 5 秒偏移去竞态；新增同毫秒回归测试（第 9 用例）。上文 Step 1/Step 3 代码块已同步修订。

**质量审查修订（2026-09-26）**：质量审查对抗探查确认无字节丢失路径后，门控以下修复（上文 Step 1/Step 3 代码块已同步修订）：
- **I1**：`deleteSession` 跨 location 扫走全部非 trash 分片（原实现只移主 location 组，混合状态下返回 `{location:'trash'}` 但会话仍在列表——契约说谎）；`archiveSession` 保持只移 active 组。
- **I2**：`renameSession` 追加前检查索引末字节，缺 `\n` 先补（防止粘连吞掉既有条目且静默 no-op）。
- **I3**：`expectedMtimeMs` `!= null` 判定 + `Number()` 强转 + 非有限数 → `invalid`（原严格 `!==` 使 JSON body 的 `null`、数值字符串产生 "expected X, got X" 式假冲突）。
- **I4**：`moveSession` 改两阶段（先全部防护后全部移动）——把审查实证涌现的"可预期失败先于任何写盘"原子性变成结构性保证；移动中 ENOENT（外部并发删除）包装为 `conflict`（可重试完成），不再泄漏原始 fs 错误（→ 500）。
- **I5**：三个入口对非字符串/空 `id` 抛 `invalid`（web 层可正确映射 400 而非 404）。
- **I7（采纳部分）**：备份 `copyFile` 加 `COPYFILE_EXCL`；导出函数补 `@returns` JSDoc。
- **I6（决策，Task 8/10 遵循）**：错误消息语言策略——面向用户可操作的防护消息（active）用中文；结构性错误（not_found/invalid/conflict，含移动中 ENOENT 的 vanished-retry 消息）用英文；web 前端可按 code 本地化展示，不依赖 message 原文。标题长度上限由 web/MCP 入口层约束（core 不设限）。
- 新增测试 5 个（备份字节完整性、冲突正向路径、跨 location 清扫、无尾换行索引、expectedMtimeMs 类型语义），mutate 共 14 tests。

**Step 5: Commit**

```bash
git add packages/core/src/mutate.js packages/core/src/catalog.js packages/core/tests/mutate.test.js docs/plans/2026-09-26-codex-session-manager.md
git commit -m "feat(core): 重命名/归档/软删除（备份 + 防护 + 分片整体移动 + 防碰撞目的名）"
```

---

### Task 6: core — export（MD/JSON 导出 + 恢复上下文）

**Files:**
- Create: `packages/core/src/export.js`
- Test: `packages/core/tests/export.test.js`

**Step 1: 写失败测试** `packages/core/tests/export.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildResumeContext, renderExport, toMarkdown } from '../src/export.js'
import { parseSessionContent } from '../src/reader.js'
import { rolloutLines } from './helpers/fixture.js'

function sample(overrides = {}) {
  const s = parseSessionContent(rolloutLines({ id: 'sid-1', userText: '目标A', assistantText: '完成A', ...overrides }))
  s.title = '测试会话'
  return s
}

/** 直接构造 Session 记录（export 为纯函数，接受任何该形状的对象），用于窗口化/回退/边界测试。 */
function synthSession(msgTexts, overrides = {}) {
  return {
    id: 'syn-1', title: null, cwd: '/proj/syn', originator: null, cliVersion: null,
    provider: 'openai', model: 'gpt-x', createdAt: null, updatedAt: null,
    messages: msgTexts.map((t, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: t, timestamp: null })),
    toolCalls: [], tokens: null, badLines: 0, ...overrides,
  }
}

test('toMarkdown: 含元信息头、用户/助手消息、工具统计', () => {
  const md = toMarkdown(sample())
  assert.ok(md.includes('# 测试会话'))
  assert.ok(md.includes('`sid-1`'))
  assert.ok(md.includes('/proj/alpha'))
  assert.ok(md.includes('目标A'))
  assert.ok(md.includes('完成A'))
  assert.ok(md.includes('exec_command'))
})

test('renderExport: json 可 round-trip；md 走 toMarkdown；未知格式抛 invalid', () => {
  const s = sample()
  const back = JSON.parse(renderExport(s, 'json'))
  assert.equal(back.id, 'sid-1')
  assert.equal(back.messages.length, s.messages.length)
  assert.ok(renderExport(s, 'md').startsWith('# 测试会话'), 'md 分支走 toMarkdown（Task 10 export 默认格式）')
  assert.throws(() => renderExport(s, 'xml'), (e) => e.code === 'invalid')
})

test('buildResumeContext: 含原目标 + 最近进展 + 截断', () => {
  const s = sample({ userText: '很'.repeat(3000) })
  const text = buildResumeContext(s, { goalChars: 100 })
  assert.ok(text.includes('# 请继续这个 Codex 会话：测试会话'))
  assert.ok(text.includes('原项目目录: /proj/alpha'))
  assert.ok(text.includes('…（已截断）'))
  assert.ok(text.includes('完成A'))
})

test('buildResumeContext: 默认窗口只取最近 6 条、排除更早消息，并按默认长度裁剪（审查缺口 #2）', () => {
  const texts = []
  for (let i = 0; i < 10; i++) texts.push(i === 9 ? 'x'.repeat(500) : `消息${i}号`)
  const s = synthSession(texts)
  const text = buildResumeContext(s) // 全默认 maxMessages=6 maxCharsPerMessage=400 goalChars=1500
  for (const i of [4, 5, 6, 7, 8]) assert.ok(text.includes(`消息${i}号`), `消息${i}号 应在最近窗口`)
  for (const i of [1, 2, 3]) assert.ok(!text.includes(`消息${i}号`), `消息${i}号 应被窗口排除`)
  assert.ok(text.includes('…（已截断）'), '500 字尾条应按默认 400 裁剪')
})

test('toMarkdown/buildResumeContext: title 为 null 时回退到 id（审查缺口 #3，真实语料 ~35% 无索引标题）', () => {
  const s = synthSession(['你好']) // title: null
  assert.ok(toMarkdown(s).startsWith('# syn-1'), 'toMarkdown 用 id 作标题')
  assert.ok(buildResumeContext(s).includes('会话：syn-1'), 'resume 上下文用 id 作标题')
})

test('clip: 截断边界不拆开代理对（审查 I2）', () => {
  const s = synthSession(['a😀b'], { title: 'T' })
  const text = buildResumeContext(s, { goalChars: 2 }) // 边界正落在 '😀' 中间
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), '输出不应含孤立高位代理')
  assert.ok(text.includes('…（已截断）'))
})

test('toJson: 白名单排除上层临时挂载字段（审查 I1，Task 10 持久化工件可复现）', () => {
  const s = sample()
  s.archived = true
  s.mtimeMs = 123456
  const back = JSON.parse(renderExport(s, 'json'))
  assert.equal(back.id, 'sid-1')
  assert.ok(Array.isArray(back.messages))
  assert.equal('archived' in back, false, 'archived 不应进入导出工件')
  assert.equal('mtimeMs' in back, false, 'mtimeMs 不应进入导出工件')
  assert.equal('badLines' in back, true, 'reader 保真字段保留')
})

test('buildResumeContext: maxMessages<=0 只保留原目标、不带最近进展（审查 I3）', () => {
  const s = synthSession(['目标消息', '进展一', '进展二'])
  const text = buildResumeContext(s, { maxMessages: 0 })
  assert.ok(text.includes('目标消息'), '原目标仍在')
  assert.ok(!text.includes('进展一'), 'maxMessages=0 不带最近进展')
})
```

**Step 2: 跑测试确认失败**

Run: `node --test packages/core/tests/export.test.js`
Expected: FAIL，`Cannot find module '.../src/export.js'`

**Step 3: 实现** `packages/core/src/export.js`

```js
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
  const recent = maxMessages > 0 ? session.messages.slice(-maxMessages) : []
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
```

**Step 4: 跑测试确认通过**

Run: `node --test packages/core/tests/export.test.js`
Expected: PASS（8 tests）

Run: `node --test "packages/core/tests/*.test.js"`
Expected: PASS（48 tests：paths 6 + reader 11 + catalog 9 + mutate 14 + export 8）

**Step 5: Commit**

```bash
git add packages/core/src/export.js packages/core/tests/export.test.js docs/plans/2026-09-26-codex-session-manager.md
git commit -m "fix(core): 导出质量审查修复（JSON 字段白名单、代理对边界、窗口下限 + 补测）"
```

**质量审查修订（2026-09-26）**：质量审查用真实语料全量扫描（650 文件 / 4.7GB，含 1GB·4228 消息极端会话）确认 export 四函数 0 崩溃、fallback/clip 契约在真实极值成立后，门控以下修复（上文 Step 1/Step 3 代码块已同步修订）：
- **I1（Important）**：`toJson` 原为 `JSON.stringify(session)`，会把上层（web/MCP loader）临时挂载的 `archived`/`mtimeMs` 一并写入 Task 10 持久化的 JSON 工件——机器本地 FS 状态使同一会话导出不可逐字节复现。修正：`EXPORT_FIELDS` 白名单（保留 reader 全保真字段含 badLines，排除一切临时挂载）。
- **I2（Minor）**：`clip` 按 UTF-16 code unit 切片会在代理对中间断开（真实语料字节级复现：🎉 前产生孤立高位代理，落盘成 U+FFFD）。修正：切点若落在高位代理则回退 1（保持 UTF-16 预算语义、O(1)）。
- **I3（Minor）**：`slice(-maxMessages)` 在 `maxMessages<=0` 时反转（0 → 取全部）。修正：`maxMessages>0 ? slice(-maxMessages) : []`。
- **I7（Minor）**：`buildResumeContext` 补 options JSDoc（单位=code unit、预算公式）。
- **测试缺口**：#2 窗口化/默认值（must——headline resume 特性核心契约此前零回归保护，唯一生产消费者 web `/resume` 只用默认值）；#1 `renderExport(s,'md')` 独立分支断言（Task 10 export 默认格式）；#3 `title??id` 回退（真实 ~35% 会话无索引标题）；#4 代理对回归。另为两处代码修复补判别性回归：I1 toJson 白名单（挂 `archived`/`mtimeMs` 后断言被排除、`badLines` 保留）、I3 `maxMessages<=0` 只留原目标。共 +5 tests、改 1 test → export 8 tests。
- **记录为可接受/延后**（不阻塞合并）：I4 消息原文含 `##`/``` 直嵌 markdown（人读工件、非安全边界；42% 会话有标题行、0.9% 有奇数围栏——转义会毁掉合法代码块，故接受）；I5 resume 被 `# Files mentioned by the user` 桌面脚手架挤占预算（根因在 reader 注入前缀未覆盖该 wrapper，**延后到 Task 9 UX pass 用真实 paste-heavy 会话验证**）；I6 最近进展条目间空行/短会话目标重复（Task 9 打磨）。renderExport 大小写敏感、100KB 消息直 dump 等经探查后 dismiss。

---

### Task 7: core — stats + index 汇总出口

**Files:**
- Create: `packages/core/src/stats.js`、`packages/core/src/index.js`
- Test: `packages/core/tests/stats.test.js`

**前置修订（2026-09-26，控制器预审）：**

1. **stats 测试的 mtime 覆盖 bug**（与 Task 4 排序测试同类）：原测试不 backdate 会话文件，`writeSession` 写的文件 mtime=now（2026-09-26），而 listSessions 的 `updatedAt = max(索引时间, mtime)`（Task 4 修订）会让 mtime 覆盖索引里 5 月的日期 → `byDay` 全部落在今天 → `byDay['2026-05-20']===2` 断言必失败。修正：三个会话各自 `backdate` 到目标日期（mtime ≈ 索引时间，日期桶正确）。
2. **recent7 数值化**：原 `(s.updatedAt ?? '') >= weekAgo` 字符串比较 ISO 时间，混合小数精度（索引 4/5/6 位 vs mtime 3 位）在边界可能误判——沿用 Task 4 I2 教训改为 `Date.parse(...) >= weekAgoMs` 数值比较。
3. **补 recent7 测试**：原测试完全不覆盖 recent7；新增第 2 用例（一个 mtime=now 命中、一个 backdate 到远期不命中）。
4. **Step 4 计数陈旧**：原写 25 tests，实际 core 全套为 paths 6 + reader 11 + catalog 9 + mutate 14 + export 8 + stats 2 = **50**。

**Step 1: 写失败测试** `packages/core/tests/stats.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildStats } from '../src/stats.js'
import { archiveSession } from '../src/mutate.js'
import { backdate, makeHome, writeIndex, writeSession } from './helpers/fixture.js'

test('buildStats: 按天/项目/模型/供应商聚合', async () => {
  const home = await makeHome()
  const pa = await writeSession(home, { id: 'a', day: '2026-05-20', cwd: '/p1', model: 'gpt-5.5' })
  const pb = await writeSession(home, { id: 'b', day: '2026-05-20', cwd: '/p1', model: 'gpt-5.6' })
  const pc = await writeSession(home, { id: 'c', day: '2026-05-21', cwd: '/p2', model: 'gpt-5.5' })
  // 关键：backdate 到目标日期，否则 mtime=now 会经 max() 覆盖索引时间，byDay 落到今天（前置修订 1）
  await backdate(pa, Date.now() - Date.parse('2026-05-20T12:00:00Z'))
  await backdate(pb, Date.now() - Date.parse('2026-05-20T13:00:00Z'))
  await backdate(pc, Date.now() - Date.parse('2026-05-21T13:00:00Z'))
  await writeIndex(home, [
    { id: 'a', thread_name: 'A', updated_at: '2026-05-20T12:00:00Z' },
    { id: 'b', thread_name: 'B', updated_at: '2026-05-20T13:00:00Z' },
    { id: 'c', thread_name: 'C', updated_at: '2026-05-21T13:00:00Z' },
  ])
  const s = await buildStats({ home })
  assert.equal(s.total, 3)
  assert.equal(s.archived, 0)
  assert.equal(s.byDay['2026-05-20'], 2)
  assert.equal(s.byDay['2026-05-21'], 1)
  assert.equal(s.byProject['/p1'], 2)
  assert.equal(s.byModel['gpt-5.5'], 2)
  assert.equal(s.byProvider['azure'], 3)
})

test('buildStats: recent7 只计近 7 天更新的会话（前置修订 3）', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'r', day: '2026-05-20' }) // mtime = now → 近 7 天内
  const pOld = await writeSession(home, { id: 'o', day: '2026-05-20' })
  await backdate(pOld, Date.now() - Date.parse('2026-05-20T12:00:00Z')) // 远期
  const s = await buildStats({ home })
  assert.equal(s.total, 2)
  assert.equal(s.recent7, 1, '仅未 backdate 者（mtime=now）在近 7 天内')
})

test('buildStats: archived 计入 archived、不进入 total 与 by* 分布（审查缺口 1）', async () => {
  const home = await makeHome()
  const pActive = await writeSession(home, { id: 'act', day: '2026-05-20', cwd: '/p1', model: 'gpt-5.5' })
  await backdate(pActive, Date.now() - Date.parse('2026-05-20T12:00:00Z'))
  const pArch = await writeSession(home, { id: 'arch', day: '2026-05-21', cwd: '/p2', model: 'gpt-9.9' })
  await backdate(pArch, Date.now() - Date.parse('2026-05-21T12:00:00Z'))
  await archiveSession({ home, id: 'arch' }) // 已 backdate，越过活跃防护
  const s = await buildStats({ home })
  assert.equal(s.total, 1, 'total 只计 active')
  assert.equal(s.archived, 1)
  assert.equal(s.byProject['/p1'], 1)
  assert.ok(!('/p2' in s.byProject), 'archived 的 cwd 不进入 byProject')
  assert.ok(!('gpt-9.9' in s.byModel), 'archived 的 model 不进入 byModel')
  assert.ok(!('2026-05-21' in s.byDay), 'archived 的日期不进入 byDay')
})

test('buildStats: model 缺失（无 turn_context）的会话被 byModel 跳过（审查 Issue 3/缺口 2）', async () => {
  const home = await makeHome()
  const pOk = await writeSession(home, { id: 'ok', day: '2026-05-20', model: 'gpt-5.5' })
  await backdate(pOk, Date.now() - Date.parse('2026-05-20T12:00:00Z'))
  // 手写一个无 turn_context 的会话文件 → fastMeta 读不到 model → null
  const dir = join(home, 'sessions', '2026', '05', '20')
  await mkdir(dir, { recursive: true })
  const pNoModel = join(dir, 'rollout-2026-05-20T00-00-00-nomodel.jsonl')
  await writeFile(pNoModel, JSON.stringify({ timestamp: '2026-05-20T12:00:00Z', ordinal: 0, type: 'session_meta', payload: { id: 'nomodel', session_id: 'nomodel', cwd: '/p1', model_provider: 'azure' } }) + '\n')
  await backdate(pNoModel, Date.now() - Date.parse('2026-05-20T12:00:00Z'))
  const s = await buildStats({ home })
  assert.equal(s.total, 2)
  assert.equal(s.byModel['gpt-5.5'], 1)
  assert.ok(!('nomodel' in s.byModel))
  assert.equal(Object.values(s.byModel).reduce((a, b) => a + b, 0), 1, 'byModel 之和 < total（null model 被跳过）')
  assert.equal(s.byProvider['azure'], 2, 'provider 仍计（session_meta 里有 model_provider）')
})

test('buildStats: 空 home 返回全零与空分布（审查缺口 3）', async () => {
  const home = await makeHome()
  const s = await buildStats({ home })
  assert.equal(s.total, 0)
  assert.equal(s.archived, 0)
  assert.equal(s.recent7, 0)
  for (const m of [s.byDay, s.byProject, s.byModel, s.byProvider]) {
    assert.equal(Object.keys(m).length, 0)
  }
})

test('buildStats: byDay 键按日期倒序（最近在前），供 Task 9 日期窗口渲染（审查缺口 4）', async () => {
  const home = await makeHome()
  const p1 = await writeSession(home, { id: 'd1', day: '2026-05-20' })
  await backdate(p1, Date.now() - Date.parse('2026-05-20T12:00:00Z'))
  const p2 = await writeSession(home, { id: 'd2', day: '2026-05-22' })
  await backdate(p2, Date.now() - Date.parse('2026-05-22T12:00:00Z'))
  const p3 = await writeSession(home, { id: 'd3', day: '2026-05-21' })
  await backdate(p3, Date.now() - Date.parse('2026-05-21T12:00:00Z'))
  const s = await buildStats({ home })
  assert.deepEqual(Object.keys(s.byDay), ['2026-05-22', '2026-05-21', '2026-05-20'], 'byDay 键最近在前')
})

test('buildStats: 对抗性键不污染计数（审查 Issue 2：null 原型）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'evil', day: '2026-05-20', cwd: 'constructor' })
  await backdate(p, Date.now() - Date.parse('2026-05-20T12:00:00Z'))
  const s = await buildStats({ home })
  assert.equal(s.byProject['constructor'], 1, 'constructor 作为普通键计 1，而非继承的函数')
  assert.equal(typeof s.byProject['constructor'], 'number')
})
```

**Step 2: 跑测试确认失败**

Run: `node --test packages/core/tests/stats.test.js`
Expected: FAIL，`Cannot find module '.../src/stats.js'`

**Step 3: 实现**

`packages/core/src/stats.js`:
```js
import { listSessions } from './catalog.js'

const MS_PER_DAY = 86_400_000

/**
 * 汇总统计（纯只读）：一律基于 ACTIVE 会话（archived 单列）。
 * @returns {Promise<{
 *   total: number,                      // 活跃会话数（不含 archived；总数 = total + archived）
 *   archived: number,                   // 归档会话数
 *   recent7: number,                    // 近 7 天内更新的活跃会话（数值时间戳比较）
 *   byDay: Record<string, number>,      // 键 = updatedAt 的 UTC 日期 YYYY-MM-DD；插入序 = listSessions 序（updatedAt 倒序，即最近在前）
 *   byProject: Record<string, number>,  // 键 = cwd
 *   byModel: Record<string, number>,    // 键 = model slug
 *   byProvider: Record<string, number>  // 键 = provider
 * }>}
 * 契约：falsy 的 cwd/model/provider 键被跳过，故对应 by* 之和可能 < total（如少量 model=null 的会话）。
 * by* 用 null 原型对象，杜绝 constructor/__proto__ 之类对抗键污染计数（审查 Issue 2）。
 */
export async function buildStats({ home }) {
  const all = await listSessions({ home, includeArchived: true })
  const active = all.filter((s) => !s.archived)
  const byDay = Object.create(null)
  const byProject = Object.create(null)
  const byModel = Object.create(null)
  const byProvider = Object.create(null)
  const bump = (obj, key) => {
    if (key) obj[key] = (obj[key] ?? 0) + 1
  }
  for (const s of active) {
    bump(byDay, (s.updatedAt ?? '').slice(0, 10))
    bump(byProject, s.cwd)
    bump(byModel, s.model)
    bump(byProvider, s.provider)
  }
  const weekAgoMs = Date.now() - 7 * MS_PER_DAY
  return {
    total: active.length,
    archived: all.length - active.length,
    // recent7 用数值时间戳比较（沿用 Task 4 I2 教训：ISO 混合小数精度下字符串比较会在边界误判）
    recent7: active.filter((s) => Date.parse(s.updatedAt ?? '') >= weekAgoMs).length,
    byDay,
    byProject,
    byModel,
    byProvider,
  }
}
```

`packages/core/src/index.js`:
```js
export * from './errors.js'
export * from './paths.js'
export * from './reader.js'
export * from './catalog.js'
export * from './mutate.js'
export * from './export.js'
export * from './stats.js'
```

**Step 4: 跑 core 全部测试确认通过**

Run: `node --test "packages/core/tests/*.test.js"`（Node 25 不接受裸目录参数）
Expected: PASS（55 tests：paths 6 + reader 11 + catalog 9 + mutate 14 + export 8 + stats 7）

Run: `node -e "import('@csm/core').then(m => console.log(Object.keys(m).length + ' exports'))"`
Expected: 输出 exports 数量 ≥ 15（实际应约 19：CsmError + codexHome/layout/anchor + parseSessionContent/readSessionFile/fastMeta + readIndex/listSessions/findSessionFile/findSessionFiles + renameSession/archiveSession/deleteSession + toMarkdown/toJson/buildResumeContext/renderExport + buildStats；验证 workspace 链接与汇总出口）

**Step 5: Commit**

```bash
git add packages/core/src/stats.js packages/core/src/index.js packages/core/tests/stats.test.js docs/plans/2026-09-26-codex-session-manager.md
git commit -m "feat(core): 统计聚合与包出口，core 完成"
```

**Task 7 质量审查修订（2026-09-26，判定"With fixes"——全部加法式，无语义变更）：**

规格审查已过（SHA-256 逐字节一致、50/50×3、真实语料 smoke total 640/archived 59/recent7 30 且证明确为只读）。质量审查的设计裁决全部**支持现实现**：`total` 活跃语义正确（看板标"活跃会话"，Task 9 勿改名）、raw map + 前端排序的分工正确（勿改成排序数组/top-N）、null 键省略可接受（记录+测试，勿加 '(unknown)' 桶）、barrel `export *` 19 名皆公开 API 的正确务实选择（勿收窄）。需落地的加法式修复：

- **Issue 2（Minor，改代码）**：`bump` 的四个分布图原为普通 `{}`，对抗性 cwd/model（如 `constructor`/`__proto__`）会读到 `Object.prototype` 继承值 → 计数被污染成字符串拼接（`byProject['constructor']` 变 `"function Object(){…}1"`）或静默丢弃。改 `Object.create(null)`（1 行、零下游代价：null 原型不过 JSON、属性访问/`Object.keys`/`in` 均正常）。真实可达性≈0（cwd 恒为绝对路径），但一行堵死整类 bug。**判别性回归**：cwd=`constructor` 的会话 → 旧代码 `typeof byProject['constructor']` 为 string（RED），新代码为 number 且值 1（GREEN）。
- **Issue 3/4/5（Minor，补 JSDoc）**：`buildStats` 原只有一行 JSDoc，返回体契约未记录。补 `@returns` 记录：`total`=活跃数（不含归档，总数=total+archived）、`byDay` 键为 **UTC** 日期（机器在 UTC+8 时凌晨会话会落前一天——文档化而非改本地时区，否则跨机器不可比）、falsy 键跳过致 **by\* 之和可能 < total**（真实语料 byModel 之和 637<640，3 个 model=null）、byDay 插入序=最近在前。另加 `MS_PER_DAY` 常量自文档化魔数。
- **测试缺口（+5 tests → stats 7、套件 55）**：① archived 排除（1 active+1 archived → total 1/archived 1，archived 的 cwd/model/day 不进 by\*）；② null-model 省略（手写无 turn_context 会话 → byModel 跳过、byModel 之和<total、provider 仍计）；③ 空 home 全零（用 `Object.keys(m).length===0` 断言，避开 null 原型的 deepEqual 原型比较）；④ byDay 倒序（钉住"最近在前"契约供 Task 9）；⑤ 原型污染回归（Issue 2）。
- **Issue 1（Important，但属 Task 9 计划前端代码，非本 diff）**：byDay 是时间序列，而 Task 9 计划的通用 `rows(obj,limit)` 按**计数**排序 → "最近 14 天"框会渲染**最忙的** 14 天（真实语料为 7/8 月）而非**最近** 14 天（9/12–26），与标签自相矛盾。**已记入下方 Task 9 待办**：byDay 必须按日期键切片 `Object.entries(s.byDay).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,14)`，不能走计数排序的 `rows()`。
- **Issue 6（Info，已改设计文档）**：`docs/plans/2026-09-26-codex-session-manager-design.md` 原承诺"统计消息数与字符量估算"，实现只做会话计数（正确 YAGNI：消息/字符统计需全量解析 4.7GB、单文件达 1GB，违背只读轻扫原则）。已订正设计文档该行，注明 v0.1 范围裁剪 + 补 byProvider 维度。

**Task 9 待办（由 Task 7 Issue 1 记录，实施 Task 9 时必须处理）：** 看板"最近 N 天"图必须对 `byDay` 按**日期键**排序切片（最近在前），不可套用按计数排序的通用 `rows()`；其余三个 by\*（project/model/provider）按计数排序取 top-N 是对的。

修复提交：`git add packages/core/src/stats.js packages/core/tests/stats.test.js docs/plans/2026-09-26-codex-session-manager.md docs/plans/2026-09-26-codex-session-manager-design.md && git commit -m "fix(core): 统计质量审查修复（null 原型防污染、@returns 契约、补测）"`（index.js 无需改，barrel 已含 stats）。

---

### Task 8: web — REST 服务

**Files:**
- Create: `packages/web/server.mjs`
- Test: `packages/web/tests/api.test.js`

**前置修订（2026-09-26，控制器预审——逐一核验 server 对 core 的真实签名后）：**

核验结论：`readIndex(home)` 位置参数、返回 `Map<id,{title,updatedAt}>`（`.title` 存在）；`findSessionFile(home,id)`/`readSessionFile(path)`/`renderExport(session,fmt)`/`buildResumeContext(session)` 位置参数；`listSessions({home,q,cwd,model,includeArchived})`/`buildStats({home})`/`renameSession({home,id,title})`/`archiveSession({home,id,force,expectedMtimeMs})`/`deleteSession({home,id,force,expectedMtimeMs})` 对象参数——server 调用点全部匹配。发现并修正 4 处：

1. **阻断性 bug（静态文件 ENOENT → 500）**：原静态处理 `const content = await readFile(p)` 未捕获 ENOENT，缺失文件落到外层 catch → `STATUS_BY_CODE['ENOENT'] ?? 500` = **500**。而穿越测试 `raw('/../../etc/passwd')` 经 fetch/URL 规范化为 `/etc/passwd`（在 PUBLIC_DIR 内、不存在）→ ENOENT → 500，但断言要求 `[403,404]` → **计划自带测试跑不过计划自带 server**。修正：静态 readFile 包 try/catch，ENOENT → 404 not_found。
2. **缺口（expectedMtimeMs 未透传）**：`archiveSession`/`deleteSession` 的 core 签名支持 `expectedMtimeMs`（Task 5 乐观并发：mtime 与读取时不符 → conflict），但原 server 只传 `force`，导致陈旧检测在 web 层形同虚设。修正：archive/delete 端点透传 `expectedMtimeMs: body.expectedMtimeMs`（前端 Task 9 从详情 `mtimeMs` 回填）。`renameSession` 仅追加索引、无文件移动，不接受 expectedMtimeMs（设计如此）。
3. **缺口（title 无长度上限，违 I6）**：I6 决定"core 不限长度，web/MCP 层封顶"。原 PATCH 直接把 `body.title` 交给 renameSession（core 无上限）。修正：web 层 `MAX_TITLE=200`，超长 → 400 invalid。
4. **健壮性（malformed JSON → 500、头部注入面）**：① `readBody` 的 `JSON.parse` 失败原会落到外层 catch 成 500；改为抛 `CsmError('invalid')` → 400。② export 的 `content-disposition: filename="${id}..."` 用裸 id（理论头部注入面，尽管 id 恒为 UUID 且需先通过 loadFull）；改为 `id.replace(/[^a-zA-Z0-9._-]/g,'_')` 消毒。

测试相应 +3（陈旧 expectedMtimeMs → 409 conflict 且正确值 → 200、title 超长 → 400、malformed JSON → 400），api.test.js 共 **7 tests**。

5. **实施期发现的原计划 bug（已修正）**：server.mjs 块原第 2 行 import 把 `dirname` 误归到 `node:url`（`dirname` 恒为 `node:path` 导出，任何 Node 版本皆然），会在模块链接期抛 `SyntaxError: The requested module 'node:url' does not provide an export named 'dirname'`。实施 subagent 按规则 STOP（未改字节、未提交），off-repo 镜像证实仅此一行阻断、其余（4 处控制器修复 + 全部 core 调用点 + 陈旧 expectedMtimeMs 往返）均如预审工作。修正：`dirname` 移到 `node:path` 那行，`node:url` 只留 `fileURLToPath, pathToFileURL`。（控制器预审核验了 core 签名但漏了 Node 内置 import——记此为教训。）

**Step 1: 写失败测试** `packages/web/tests/api.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createApp } from '../server.mjs'
import { backdate, makeHome, writeIndex, writeSession } from '../../core/tests/helpers/fixture.js'

async function withServer(home, fn) {
  const { server, token } = createApp({ home, token: 'test-token' })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const api = (path, opts = {}) =>
    fetch(base + path, { ...opts, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...opts.headers } })
  try {
    return await fn({ base, api, raw: (path) => fetch(base + path) })
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('health 无需鉴权；API 无 token 返回 401', async () => {
  const home = await makeHome()
  await withServer(home, async ({ base, raw }) => {
    assert.equal((await raw('/api/health')).status, 200)
    assert.equal((await raw('/api/sessions')).status, 401)
  })
})

test('列表 + 详情 + 重命名 + 归档 + 删除 + 导出 + resume + stats 全链路', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20', userText: '目标A' })
  await backdate(p)
  await writeIndex(home, [{ id: 'a', thread_name: '原名', updated_at: '2026-05-20T12:00:00Z' }])
  await withServer(home, async ({ api }) => {
    // 列表
    let res = await api('/api/sessions')
    assert.equal(res.status, 200)
    let body = await res.json()
    assert.equal(body.sessions.length, 1)
    assert.equal(body.sessions[0].title, '原名')
    // 详情
    res = await api('/api/sessions/a')
    body = await res.json()
    assert.equal(body.session.messages.find((m) => m.role === 'user').text, '目标A')
    // 重命名
    res = await api('/api/sessions/a', { method: 'PATCH', body: JSON.stringify({ title: '新名' }) })
    assert.equal(res.status, 200)
    assert.equal((await (await api('/api/sessions')).json()).sessions[0].title, '新名')
    // 导出
    res = await api('/api/sessions/a/export?fmt=md')
    assert.ok((await res.text()).includes('# 新名'))
    // resume
    res = await api('/api/sessions/a/resume')
    assert.ok((await res.json()).text.includes('目标A'))
    // stats
    res = await api('/api/stats')
    assert.equal((await res.json()).total, 1)
    // 归档 → 活跃列表为空
    res = await api('/api/sessions/a/archive', { method: 'POST', body: '{}' })
    assert.equal(res.status, 200)
    assert.equal((await (await api('/api/sessions')).json()).sessions.length, 0)
    // 删除（对已归档会话）→ 进回收站
    res = await api('/api/sessions/a/delete', { method: 'POST', body: '{}' })
    assert.equal(res.status, 200)
    // 404
    assert.equal((await api('/api/sessions/nope')).status, 404)
  })
})

test('静态页: / 返回 index.html；路径穿越被拒', async () => {
  const home = await makeHome()
  await withServer(home, async ({ raw }) => {
    const res = await raw('/')
    assert.equal(res.status, 200)
    assert.ok((res.headers.get('content-type') ?? '').includes('text/html'))
    const evil = await raw('/../../etc/passwd')
    assert.ok([403, 404].includes(evil.status))
  })
})

test('活跃会话变更返回 409 active', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'fresh', day: '2026-05-20' }) // mtime = now
  await withServer(home, async ({ api }) => {
    const res = await api('/api/sessions/fresh/archive', { method: 'POST', body: '{}' })
    assert.equal(res.status, 409)
    assert.equal((await res.json()).error.code, 'active')
  })
})

test('陈旧 expectedMtimeMs 返回 409 conflict，正确值放行（前置修订 2：乐观并发透传）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 's', day: '2026-05-20' })
  await backdate(p) // 越过活跃窗口，只剩陈旧检测
  await withServer(home, async ({ api }) => {
    const detail = await (await api('/api/sessions/s')).json()
    const realMtime = detail.session.mtimeMs // loadFull 透出的 mtimeMs
    assert.equal(typeof realMtime, 'number')
    // 错误的 expectedMtimeMs → 陈旧冲突
    let res = await api('/api/sessions/s/archive', { method: 'POST', body: JSON.stringify({ expectedMtimeMs: realMtime + 1 }) })
    assert.equal(res.status, 409)
    assert.equal((await res.json()).error.code, 'conflict')
    // 正确的 expectedMtimeMs → 放行
    res = await api('/api/sessions/s/archive', { method: 'POST', body: JSON.stringify({ expectedMtimeMs: realMtime }) })
    assert.equal(res.status, 200)
  })
})

test('title 超长返回 400 invalid（前置修订 3：web 层封顶 MAX_TITLE）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 't', day: '2026-05-20' })
  await backdate(p)
  await withServer(home, async ({ api }) => {
    const res = await api('/api/sessions/t', { method: 'PATCH', body: JSON.stringify({ title: 'x'.repeat(201) }) })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.code, 'invalid')
  })
})

test('malformed JSON body 返回 400 invalid 而非 500（前置修订 4）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'j', day: '2026-05-20' })
  await backdate(p)
  await withServer(home, async ({ api }) => {
    const res = await api('/api/sessions/j', { method: 'PATCH', body: '{not json' })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.code, 'invalid')
  })
})

test('畸形请求目标不致服务崩溃（审查 I1：new URL 入 try）', async () => {
  const home = await makeHome()
  await withServer(home, async ({ base, raw }) => {
    const port = Number(new URL(base).port)
    // 裸 socket 发送畸形绝对形式请求目标：llhttp 接受，但 new URL('http://[::1') 会抛（未闭合 IPv6）
    await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET http://[::1 HTTP/1.1\r\nHost: x\r\n\r\n')
      })
      sock.on('data', () => {}) // 读取（可能是 400 响应）后丢弃
      sock.on('close', resolve)
      sock.on('error', resolve)
      setTimeout(resolve, 500)
    })
    // 服务必须仍存活：后续正常请求 200（修复前该畸形请求会让进程崩溃 → 此处连接被拒）
    const health = await raw('/api/health')
    assert.equal(health.status, 200, '服务未因畸形请求目标崩溃')
  })
})

test('null body（合法 JSON）返回 400 invalid 而非 500（审查 I2）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'n', day: '2026-05-20' })
  await backdate(p)
  await withServer(home, async ({ api }) => {
    const res = await api('/api/sessions/n', { method: 'PATCH', body: 'null' })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.code, 'invalid')
  })
})

test('非法百分号编码 id 返回 400 invalid 而非 500（审查 I3）', async () => {
  const home = await makeHome()
  await withServer(home, async ({ api }) => {
    const res = await api('/api/sessions/%zz')
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.code, 'invalid')
  })
})

test('无标题会话 detail title=null（与 list 的 (未命名) 对齐，审查 I6）', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'notitle', day: '2026-05-20' })
  await backdate(p)
  // 不写 index → 无标题
  await withServer(home, async ({ api }) => {
    const detail = await (await api('/api/sessions/notitle')).json()
    assert.equal(detail.session.title, null, 'detail 对无标题返回 null，Task 9 统一渲染 (未命名)')
    const list = await (await api('/api/sessions')).json()
    assert.equal(list.sessions[0].title, '(未命名)', 'list 用 (未命名)')
  })
})
```

> 注意：静态页测试要求 `packages/web/public/index.html` 已存在——本 Task 先创建最小占位 `public/index.html`（内容 `<title>CSM</title>` 即可），Task 9 再写完整前端。

**Step 2: 跑测试确认失败**

Run: `node --test packages/web/tests/api.test.js`
Expected: FAIL，`Cannot find module '.../server.mjs'`

**Step 3: 实现** `packages/web/server.mjs`

```js
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
```

同时创建占位 `packages/web/public/index.html`:
```html
<!doctype html><meta charset="utf-8"><title>CSM</title>
```

**Step 4: 跑测试确认通过**

Run: `node --test packages/web/tests/api.test.js`
Expected: PASS（11 tests：health/auth、全链路、静态+穿越、活跃防护、陈旧 expectedMtimeMs、title 超长、malformed JSON、畸形请求目标不崩溃、null body→400、非法编码 id→400、无标题 detail=null）

Run: `node --test 'packages/*/tests/*.test.js'`
Expected: PASS（66 tests：core 55 + web 11）

**Step 5: Commit**

```bash
git add packages/web/server.mjs packages/web/public/index.html packages/web/tests/api.test.js docs/plans/2026-09-26-codex-session-manager.md
git commit -m "feat(web): REST API 服务（bearer 鉴权、错误映射、静态托管、穿越防护）"
```

**Task 8 质量审查修订（2026-09-26，判定"With fixes"）：**

规格审查已过（逐字节一致、7/7+62/62×3、51/51 行为探针、6 控制器修复行为级证实、真实语料只读 smoke 零变更）。质量审查证实安全基本面稳固（loopback 绑定、每次运行 128-bit token、auth-before-body 兼作 CSRF 防御、17 变体裸 socket 穿越零泄漏、expectedMtimeMs 精确往返小数 mtime、72 轮并发变更零文件系统损坏），但发现规格审查看不到的**阻断性 bug** 及一批同类/打磨项：

- **I1（Important，阻断，已修）**：`new URL(req.url,…)` 原在 try 之外。llhttp 接受畸形绝对形式请求目标（如 `GET http://[::1 HTTP/1.1`），`new URL` 抛 TypeError 逃逸 async handler → 未处理拒绝 → **进程崩溃**。浏览器 fetch 会规范化故无法触发，但 loopback 跨用户——多用户机上**任一本地进程可单包打挂面板**，且违背本项目"客户端输入绝不逃逸为崩溃/500"既定策略（前置修订 a/d 同类）。修：`new URL` 入独立 try → 400 `invalid` 'malformed request target'。**判别性回归**：裸 socket 发畸形目标后，服务须存活并响应后续 health 200（修复前进程崩溃 → 连接被拒）。
- **I2（Important，已修）**：`null` 是合法 JSON，原 readBody 不校验 → PATCH/POST 在 `body.title`/`body.force` 处对 null 取属性 → TypeError → 500 泄漏。前置修订 d 只挡了 malformed JSON，漏了 null。修：readBody 解析后校验 `parsed===null || typeof!=='object' || Array.isArray` → `CsmError('invalid')` → 400（数组也得精确 400）。回归：PATCH body `null` → 400 invalid。
- **I3（Important，已修）**：`decodeURIComponent(m[1])` 对非法百分号编码（`%zz`/`%E0%A4%A`）抛 URIError（无 .code）→ 500。修：入 try → 400 `invalid` 'malformed session id encoding'。回归：GET `/api/sessions/%zz` → 400 invalid。
- **I5（Minor，已修）**：外层 catch 原 `STATUS_BY_CODE[err.code] ?? 500` + `err.code ?? 'internal'` 把 **fs errno 原样当 API code**（如 `code:"EACCES"`）、message 泄漏绝对路径。修：`typeof status==='number'` 才走映射（已知 CsmError 4xx 消息按 I6 策略原样透出，用户可读）；未映射者 → `console.error` 服务端记录 + 对外只给 `code:'internal', message:'internal server error'`。`typeof number` 判定同时杜绝 `STATUS_BY_CODE['__proto__']` 取到 `Object.prototype` 真值再 `writeHead(Object.prototype)` 崩溃的潜在放大（审查 §7 演示）。
- **I6（Minor，已修）**：detail 的 `title ?? session.id` 与 list 的 `?? '(未命名)'` 不一致（真实语料证实：同一无标题会话 list 显示 `(未命名)`、detail 返回裸 UUID，Task 9 详情标题会与所点行不符）。修：loadFull `title = index.get(id)?.title ?? null`（API 诚实：null=无标题；export/resume 内部仍 `?? session.id` 保留信息量 UUID 标题；Task 9 由单点把 null 渲染成 `(未命名)`）。回归：无 index 的会话 → detail title=null、list title='(未命名)'。
- **I8/I9/I10/I11（Minor/nit，已修）**：I8 sendJson 加 `cache-control: no-store`（防 Task 9 在 rename/archive 后读到陈旧列表）；I9 catch 入口 `if (res.headersSent) return res.end()`（防 headers 已发后二次 writeHead 抛 ERR_HTTP_HEADERS_SENT 崩溃——当前不可达但一次未来编辑之遥）；I10 死 403 分支加注释（WHATWG URL 已解析 dot-segments，合法 HTTP 到不了，保留为防未来重构的纵深防御）；I11 静态处理限 GET/HEAD（其他方法 → 404，原 TRACE/POST 也会回 index.html）。另 CSM_PORT 非法值（NaN）回退 4173（原会静默用随机端口）。
- **I4（Minor，延后 Task 13）**：readBody 无界缓冲（无大小上限）。审查实测 RSS 随发送线性增长，但 **token 门禁**（未鉴权 401 在 readBody 之前、不缓冲一字节）+ loopback + 单用户 → 唯一现实受害者是用户自己/Task 9 bug，属卫生非漏洞。建议 ~6 行加 10MB 上限（Content-Length 预检 + 累加计数 → 413 `too_large`），但测试笨重（fetch 的 content-length 覆盖不可靠、真发 11MB  body 太重），延后到 Task 13 遗留 Minor 包统一处理（届时同时考虑 null-proto 化 MIME/STATUS_BY_CODE，尽管 typeof-number 检查已使其 moot）。
- **判定（不改）**：① token 非常量时间比较——loopback 绑定 + 每次运行随机 token 已足够，远程逐字节计时攻击在异步 HTTP 抖动下不成立，本地同用户进程可直接读堆/lsof，timingSafeEqual 属过度工程（若未来非 loopback 绑定再加）；② token 置于 URL（`?token=`）——这是 Task 9 前端取 token 的设计交接（app.js 读 `params.get('token')`→sessionStorage），默认 referrer 策略跨源剥离 query、页面无外部资源、无访问日志，且改用 cookie 会更糟（自动附带 → 变更端点开 CSRF，而必需的 Authorization 头正是让 drive-by 失败的原因）；③ 无分页——640 会话=261.5KB 对 loopback 传输/渲染皆轻量，但**每次 list ~0.9–1.3s**（全语料 fastMeta 扫描，服务端 q/cwd/model 过滤不减扫描成本）→ 记为 Task 9 待办（一次拉取 + 客户端过滤，字段已全在 payload）；④ 并发安全——72 轮竞争变更零损坏，无需 web 侧改动（core 两阶段设计已足够；guard 阶段 stat ENOENT→500 的理论残余竞争 72 轮未触发，记为未来 core pass）。

**Task 9 待办（由 Task 8 审查记录，实施 Task 9 时必须处理）：**
- **I7**：前端 archive/delete **必须回填 `expectedMtimeMs`**（从 detail 的 `session.mtimeMs`），否则 Task 5 的陈旧守卫在 UI 路径形同虚设——计划 Task 9 的 app.js 现写 `body:'{}'`，需改为带 expectedMtimeMs（server 侧已就绪，200/409 双向验证通过）。
- **I6**：detail 返回的 `title` 可能为 `null`，前端在列表与详情**单点**渲染为 `(未命名)`（export/resume 内部已 `?? session.id`，无需前端处理）。
- **延迟**：list 每次 ~1s 全语料扫描 → 前端**一次拉取 + 客户端过滤**（q/cwd/model 字段已在 payload），勿每次按键/切换都重拉；或后续加 mtime-keyed 服务端缓存。
- **byDay 排序**（Task 7 Issue 1 已记）：看板"最近 N 天"按日期键排序切片，勿套计数排序的 `rows()`。

修复提交：`git add packages/web/server.mjs packages/web/tests/api.test.js docs/plans/2026-09-26-codex-session-manager.md && git commit -m "fix(web): 质量审查修复（畸形请求目标崩溃、null body/非法编码→400、错误脱敏、title 对齐）"`（index.html 未改）。

---

### Task 9: web — 前端面板（原生 HTML/CSS/JS）

**Files:**
- Modify: `packages/web/public/index.html`（替换占位）
- Create: `packages/web/public/app.js`、`packages/web/public/style.css`

> 前端无自动化测试（无构建、无框架）；用 Step 5 的手动验证清单代替。UI 文案用中文。

**前置修订（2026-09-26，控制器预审——对照已定稿的 Task 8 API 契约 + Task 6/7/8 携带待办）：**

1. **I7（expectedMtimeMs 回填，必修）**：原 archive/delete 发 `body:'{}'`，未带 `expectedMtimeMs` → Task 5 的陈旧守卫（mtime 与读取时不符 → 409 conflict）在 UI 路径形同虚设。修：`selectSession` 存 `state.detailMtime = s.mtimeMs`（Task 8 loadFull 已透出），archive/delete 发 `body: JSON.stringify({ expectedMtimeMs: state.detailMtime })`。
2. **I6（title null 渲染，必修）**：Task 8 的 I6 修复后，无索引标题的会话 detail 返回 `title=null`；原 `<h2>${esc(s.title)}</h2>` → `esc(null)`='null' → 详情页标题显示字面 "null"。修：`esc(s.title ?? '(未命名)')`（list 侧用 listSessions 的 '(未命名)' 兜底、永不为 null，无需改）。
3. **Task 7 Issue 1（byDay 排序，必修）**：原 `rows(s.byDay,14)` 按**计数**降序 → "最近 14 天"实际渲染**最忙的** 14 天（真实语料为 7/8 月），与标签矛盾。修：新增 `dayRows`（按**日期键** `b[0].localeCompare(a[0])` 降序取最近 N 天），byDay 用它；其余三个 by\* 仍按计数 `rows()`。
4. **Task 8 判定（延迟 → 客户端过滤）+ 现存下拉 bug**：list 每次需全语料 fastMeta 扫描（真实 ~0.9–1.3s），原实现每次按键/切换都服务端往返 → 迟滞。且原 `loadList` 从**过滤后结果**重填模型下拉 → 选中某模型后下拉只剩该模型、无法切换（现存 bug）。修：拆 `refresh()`（一次拉取 `?archived=1` 全量、缓存 `state.all`、从全量填模型下拉）+ `renderList()`（纯客户端过滤，瞬时）；过滤输入直接调 `renderList()`（去掉 250ms debounce 与服务端 query）；变更后 `refresh().then(renderList)`。客户端过滤语义与 core `listSessions` 一致（q=标题/ID/项目小写子串、cwd=小写子串、model=精确、archived=含归档）；resume 分片同 id 共享元数据，服务端先去重再客户端过滤 ≡ 服务端过滤，边缘差异可忽略。
5. **F（conflict 友好提示，小）**：catch 原只特判 `active`；补 `conflict` → "会话自读取后已变化，请重新选择后再试"（配合 I7 的陈旧守卫）。
6. **延后/已验证**：Task 6 的 I6 打磨（resume 上下文 `\n\n` 间距、<6 消息时 goal 与窗口重叠）属 **core/export.js 内容**、Task 6 已批准，不在前端任务里改 → 归 Task 13 遗留 Minor 包；Task 6 的 I5（resume 预算被 `# Files mentioned by the user` 挤占）已在 Task 6 质量审查用真实 427 消息会话验证"可续"，本任务 Step 5 再顺带目测。

**Step 1: 写 `packages/web/public/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CSM · Codex 会话管理器</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header>
  <h1>🗂️ Codex 会话管理器</h1>
  <nav>
    <button id="tab-sessions" class="tab active">会话</button>
    <button id="tab-stats" class="tab">统计</button>
  </nav>
</header>
<main>
  <section id="view-sessions">
    <div class="toolbar">
      <input id="q" type="search" placeholder="搜索标题 / ID / 项目目录…">
      <input id="cwd" type="text" placeholder="项目目录包含…">
      <select id="model"><option value="">全部模型</option></select>
      <label class="chk"><input id="archived" type="checkbox"> 含归档</label>
      <span id="count" class="count"></span>
    </div>
    <div class="layout">
      <ul id="list"></ul>
      <aside id="detail"><p class="empty">选择左侧会话查看详情</p></aside>
    </div>
  </section>
  <section id="view-stats" hidden></section>
</main>
<div id="toast"></div>
<script src="app.js"></script>
</body>
</html>
```

**Step 2: 写 `packages/web/public/style.css`**

```css
:root {
  --bg: #0f1115; --panel: #171a21; --border: #262b36; --text: #e6e8ee;
  --muted: #8b93a5; --accent: #4f8cff; --danger: #ff5d5d; --ok: #3ddc84;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
header { display: flex; align-items: center; gap: 16px; padding: 10px 18px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 5; }
header h1 { font-size: 16px; margin: 0; }
.tab { background: none; border: 1px solid var(--border); color: var(--muted); padding: 5px 14px; border-radius: 8px; cursor: pointer; }
.tab.active { color: var(--text); border-color: var(--accent); }
main { padding: 14px 18px; }
.toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.toolbar input[type="search"], .toolbar input[type="text"], .toolbar select {
  background: var(--panel); border: 1px solid var(--border); color: var(--text); padding: 7px 10px; border-radius: 8px; min-width: 180px;
}
.chk { color: var(--muted); display: flex; gap: 5px; align-items: center; }
.count { color: var(--muted); margin-left: auto; }
.layout { display: grid; grid-template-columns: minmax(320px, 420px) 1fr; gap: 14px; align-items: start; }
#list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; max-height: calc(100vh - 150px); overflow: auto; }
#list li { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; cursor: pointer; }
#list li:hover { border-color: var(--accent); }
#list li.sel { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
#list .t { font-weight: 600; }
#list .m { color: var(--muted); font-size: 12px; margin-top: 3px; display: flex; gap: 8px; flex-wrap: wrap; }
.badge { border: 1px solid var(--border); border-radius: 6px; padding: 0 6px; font-size: 11px; }
.badge.arch { color: var(--ok); }
#detail { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px; max-height: calc(100vh - 150px); overflow: auto; }
#detail .empty { color: var(--muted); }
#detail h2 { font-size: 15px; margin: 0 0 8px; }
#detail .meta { color: var(--muted); font-size: 12px; margin-bottom: 10px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.actions button { background: var(--panel); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 6px 12px; cursor: pointer; }
.actions button:hover { border-color: var(--accent); }
.actions button.danger:hover { border-color: var(--danger); color: var(--danger); }
.msg { border-top: 1px solid var(--border); padding: 10px 2px; }
.msg .who { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.msg pre { white-space: pre-wrap; word-break: break-word; margin: 0; font: inherit; }
.msg.user .who { color: var(--accent); }
#view-stats .cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
#view-stats .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 12px 18px; min-width: 130px; }
#view-stats .card b { font-size: 22px; display: block; }
#view-stats .card span { color: var(--muted); font-size: 12px; }
#view-stats .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
#view-stats .box { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 12px; }
#view-stats .box h3 { margin: 0 0 8px; font-size: 13px; color: var(--muted); }
#view-stats .row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px dashed var(--border); font-size: 13px; }
#toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--panel); border: 1px solid var(--accent); padding: 8px 18px; border-radius: 10px; opacity: 0; pointer-events: none; transition: opacity .25s; z-index: 9; }
#toast.show { opacity: 1; }
#toast.err { border-color: var(--danger); color: var(--danger); }
```

**Step 3: 写 `packages/web/public/app.js`**

```js
const params = new URLSearchParams(location.search)
const token = params.get('token') ?? sessionStorage.getItem('csm-token') // N1：URL 新 token 优先于 sessionStorage 旧 token（服务重启后旧标签打开新 ?token= URL 不再首屏 401）
if (params.get('token')) sessionStorage.setItem('csm-token', params.get('token'))

const $ = (sel) => document.querySelector(sel)
const state = { sessions: [], selected: null, view: 'sessions', all: [], detailMtime: null }

function toast(msg, isErr = false) {
  const el = $('#toast')
  el.textContent = msg
  el.className = `show${isErr ? ' err' : ''}`
  setTimeout(() => (el.className = ''), 2200)
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...opts.headers },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error?.message ?? `HTTP ${res.status}`)
    err.code = data.error?.code
    throw err
  }
  return data
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtTime = (iso) => esc(iso ? String(iso).replace('T', ' ').slice(0, 16) : '?') // I-1：输出转义，杜绝构造 timestamp 注入 <svg onload>/<iframe srcdoc> 的存储型 XSS；String() 兼修数字 timestamp（N2）
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)

// 一次拉全量（含归档）缓存到客户端；模型下拉从全量填一次（修复旧版从过滤结果重填、选中某模型后下拉只剩该模型的 bug）。
// 列表需全语料 fastMeta 扫描（真实 ~0.9–1.3s，见 Task 8 审查），故过滤一律走客户端、瞬时完成，不再每次往返服务端。
async function refresh() {
  const { sessions } = await api('/api/sessions?archived=1')
  state.all = sessions
  const models = [...new Set(sessions.map((s) => s.model).filter(Boolean))].sort()
  const sel = $('#model')
  const cur = sel.value
  sel.innerHTML = '<option value="">全部模型</option>' + models.map((m) => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('')
}

// 客户端过滤（语义与 core listSessions 一致：q=标题/ID/项目小写子串、cwd=小写子串、model=精确、archived=含归档）。
function renderList() {
  const q = $('#q').value.trim().toLowerCase()
  const cwd = $('#cwd').value.trim().toLowerCase()
  const model = $('#model').value
  const showArchived = $('#archived').checked
  const sessions = state.all.filter((s) => {
    if (!showArchived && s.archived) return false
    if (model && s.model !== model) return false
    if (cwd && !(s.cwd ?? '').toLowerCase().includes(cwd)) return false
    if (q && ![s.title, s.id, s.cwd ?? ''].some((f) => String(f).toLowerCase().includes(q))) return false
    return true
  })
  state.sessions = sessions
  $('#count').textContent = `${sessions.length} 个会话`
  $('#list').innerHTML = sessions.map((s) => `
    <li data-id="${esc(s.id)}" class="${state.selected === s.id ? 'sel' : ''}">
      <div class="t">${esc(s.title)}</div>
      <div class="m">
        <span>${fmtTime(s.updatedAt)}</span>
        <span>${esc(s.model ?? '?')}</span>
        <span>${esc(s.cwd ?? '')}</span>
        <span>${fmtSize(s.size)}</span>
        ${s.archived ? '<span class="badge arch">已归档</span>' : ''}
      </div>
    </li>`).join('') || '<li>无匹配会话</li>'
}

async function selectSession(id) {
  state.selected = id
  document.querySelectorAll('#list li').forEach((li) => li.classList.toggle('sel', li.dataset.id === id))
  const { session: s } = await api(`/api/sessions/${encodeURIComponent(id)}`)
  state.detailMtime = s.mtimeMs // 乐观并发：archive/delete 回填 expectedMtimeMs（Task 8 I7）
  $('#detail').innerHTML = `
    <h2>${esc(s.title ?? '(未命名)')}</h2>
    <div class="meta">ID: ${esc(s.id)} · ${esc(s.cwd ?? '?')} · ${esc(s.model ?? '?')} (${esc(s.provider ?? '?')}) · ${fmtTime(s.createdAt)} → ${fmtTime(s.updatedAt)} · tokens: ${s.tokens ?? '?'}</div>
    <div class="actions">
      <button data-act="rename">✏️ 重命名</button>
      <button data-act="resume">📋 复制恢复上下文</button>
      <button data-act="export-md">⬇️ 导出 MD</button>
      <button data-act="export-json">⬇️ 导出 JSON</button>
      ${s.archived ? '' : '<button data-act="archive">📦 归档</button>'}
      <button data-act="delete" class="danger">🗑️ 删除（进回收站）</button>
    </div>
    ${s.messages.map((m) => `<div class="msg ${m.role}"><div class="who">${m.role === 'user' ? '🧑 用户' : '🤖 助手'} · ${fmtTime(m.timestamp)}</div><pre>${esc(m.text)}</pre></div>`).join('')}`
}

async function download(path, filename) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const blob = await res.blob()
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename })
  a.click()
  URL.revokeObjectURL(a.href)
}

$('#detail').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]')
  if (!btn) return
  const id = state.selected
  const act = btn.dataset.act
  try {
    if (act === 'rename') {
      const title = prompt('新标题：')
      if (!title) return
      await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) })
      toast('已重命名')
      await refresh()
      renderList()
      await selectSession(id)
    } else if (act === 'resume') {
      const { text } = await api(`/api/sessions/${encodeURIComponent(id)}/resume`)
      await navigator.clipboard.writeText(text)
      toast('恢复上下文已复制，去 Codex 新建对话粘贴即可')
    } else if (act === 'export-md') {
      await download(`/api/sessions/${encodeURIComponent(id)}/export?fmt=md`, `${id}.md`)
    } else if (act === 'export-json') {
      await download(`/api/sessions/${encodeURIComponent(id)}/export?fmt=json`, `${id}.json`)
    } else if (act === 'archive') {
      if (!confirm('归档该会话？（移入 archived_sessions，可手动移回）')) return
      await api(`/api/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify({ expectedMtimeMs: state.detailMtime }) })
      toast('已归档')
      state.selected = null
      $('#detail').innerHTML = '<p class="empty">选择左侧会话查看详情</p>'
      await refresh()
      renderList()
    } else if (act === 'delete') {
      if (!confirm('删除该会话？（软删除：移入 .csm-trash 并先备份，不会物理删除）')) return
      await api(`/api/sessions/${encodeURIComponent(id)}/delete`, { method: 'POST', body: JSON.stringify({ expectedMtimeMs: state.detailMtime }) })
      toast('已移入回收站')
      state.selected = null
      $('#detail').innerHTML = '<p class="empty">选择左侧会话查看详情</p>'
      await refresh()
      renderList()
    }
  } catch (e) {
    const msg = e.code === 'active' ? '会话正被 Codex 使用中，稍后再试'
      : e.code === 'conflict' ? '会话自读取后已变化，请重新选择后再试'
      : `失败：${e.message}`
    toast(msg, true)
  }
})

$('#list').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-id]')
  if (li) selectSession(li.dataset.id).catch((e) => toast(e.message, true))
})

// 过滤一律客户端（renderList 同步瞬时），不再 debounce/服务端往返
for (const sel of ['#q', '#cwd', '#model', '#archived']) {
  $(sel).addEventListener(sel === '#model' || sel === '#archived' ? 'change' : 'input', () => renderList())
}

async function loadStats() {
  const s = await api('/api/stats')
  const rows = (obj, limit = 10) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, limit)
      .map(([k, v]) => `<div class="row"><span>${esc(k)}</span><b>${v}</b></div>`).join('')
  // byDay 是时间序列：按日期键降序取最近 N 天（勿按计数排序，否则"最近 14 天"变成"最忙 14 天"——Task 7 Issue 1）
  const dayRows = (obj, limit = 14) =>
    Object.entries(obj).sort((a, b) => b[0].localeCompare(a[0])).slice(0, limit)
      .map(([k, v]) => `<div class="row"><span>${esc(k)}</span><b>${v}</b></div>`).join('')
  $('#view-stats').innerHTML = `
    <div class="cards">
      <div class="card"><b>${s.total}</b><span>活跃会话</span></div>
      <div class="card"><b>${s.archived}</b><span>已归档</span></div>
      <div class="card"><b>${s.recent7}</b><span>近 7 天活跃</span></div>
    </div>
    <div class="grid">
      <div class="box"><h3>按项目目录</h3>${rows(s.byProject)}</div>
      <div class="box"><h3>按模型</h3>${rows(s.byModel)}</div>
      <div class="box"><h3>按供应商</h3>${rows(s.byProvider)}</div>
      <div class="box"><h3>按日期（最近 14 天）</h3>${dayRows(s.byDay, 14)}</div>
    </div>`
}

function switchView(view) {
  state.view = view
  $('#tab-sessions').classList.toggle('active', view === 'sessions')
  $('#tab-stats').classList.toggle('active', view === 'stats')
  $('#view-sessions').hidden = view !== 'sessions'
  $('#view-stats').hidden = view !== 'stats'
  if (view === 'stats') loadStats().catch((e) => toast(e.message, true))
}
$('#tab-sessions').addEventListener('click', () => switchView('sessions'))
$('#tab-stats').addEventListener('click', () => switchView('stats'))

if (!token) {
  toast('URL 缺少 ?token=，请使用服务启动时打印的完整地址', true)
} else {
  refresh().then(renderList).catch((e) => toast(e.message, true))
}
```

**Step 4: 跑 web 测试回归**

Run: `node --test packages/web/tests/api.test.js`
Expected: PASS（11/11；本任务只改前端三件套，api.test.js 不动。静态页测试断言 `/` → 200 text/html，完整 index.html 仍按 text/html 服务故通过；app.js/style.css 由静态处理按 MIME 服务，测试不断言其内容）

Run: `node --test 'packages/*/tests/*.test.js'`
Expected: PASS（66/66：core 55 + web 11）

**Step 5: 手动验证（真实数据只读操作）**

Run: `cd /Users/xuxianxian/Documents/test/codex-session-manager && (CODEX_HOME=$HOME/.codex node packages/web/server.mjs &); sleep 1`
然后从 stdout 拿 `http://127.0.0.1:4173/?token=...` 用浏览器打开，核对清单：
- [ ] 会话列表显示真实会话（标题/时间/项目/模型）
- [ ] 搜索关键字、项目目录、模型过滤都生效且**瞬时响应**（客户端过滤，无 ~1s 迟滞——前置修订 4）
- [ ] **选中某模型后，模型下拉仍列出其它模型、可切换**（修复旧版从过滤结果重填导致下拉收缩的 bug——前置修订 4）
- [ ] 点开详情能看到消息流；**无标题会话详情标题显示「(未命名)」而非「null」**（前置修订 2）
- [ ] 「复制恢复上下文」提示成功，粘贴可见 Markdown（顺带目测 resume 上下文可读、未被 `# Files mentioned by the user` 挤占——Task 6 I5）
- [ ] 「导出 MD」下载的文件内容正确
- [ ] 统计页数字与列表总数一致；**「按日期（最近 14 天）」显示最近的日期（按日期降序）而非最忙的日期**（前置修订 3）
- [ ] ⚠️ 本步骤**不要**在真实数据上点归档/删除（留给验收阶段用测试会话验证，含 I7 expectedMtimeMs 冲突路径）
验证完 `kill %1` 关掉服务。

**Step 6: Commit**

```bash
git add packages/web/public/ docs/plans/2026-09-26-codex-session-manager.md
git commit -m "feat(web): 会话面板前端（列表/搜索/详情/统计/操作按钮，原生无构建；客户端过滤+expectedMtimeMs 回填+title/byDay 修正）"
```

**Task 9 质量审查修订（2026-09-26，判定"With fixes"，1 项阻断）：**

规格审查已过（3 文件逐字节一致、node --check、11/11+66/66、HTTP 服务+API 接线 60 检、过滤等价 9/9、真实语料只读探针 699 会话）。质量审查用 parse5（Node HTML 解析器，无需浏览器）+ 活体探针**推翻了规格审查对唯一 sink 的评级**，发现一个**阻断性存储型 XSS**：

- **I-1（Important，阻断，已修）**：`fmtTime` 实为 `(iso) => (iso ? iso.replace('T',' ').slice(0,16) : '?')`——**零校验、输出永不转义**（规格审查误称其含 `new Date`/Invalid-Date 兜底、且断言"list 侧受 Date.parse 门保护"，**两处均被实证推翻**）。真实机制：① **detail 侧单击执行**——构造一行 JSONL，`timestamp:"<svg onload=\"1/*"` + 同会话某条消息文本 `*/;alert(1);//`，拼进 innerHTML 后 `<svg>` 的 onload 值经 parse5+`new Function` 验证**可编译执行**（innerHTML 只拦 `<script>`，不拦 `<svg onload>`；闭合引号来自下一条消息的 `class="msg…"`）；② **list 侧零点击执行/信标**——catalog 的 `Number.isFinite(Date.parse(idx.updatedAt)) && idxMs>st.mtimeMs` 门被 V8 宽松解析绕过：`'<iframe srcdoc=" 2027-01-01'`、`'<img src=//evil> 2027-01-01'` 均算**有限未来日期**而通过门，list 渲染出 `<iframe srcdoc="`（16 字符）打开引号属性吞掉后续标记，属性值内字符引用会解码 → 被 esc 的 model 字段 `&lt;script&gt;…` 在 srcdoc 内还原成活 `<script>`（无 sandbox 的 srcdoc iframe 在面板源内执行）；`<img src=//evil>` 则是零点击网络信标。**影响**：脚本运行在面板源（`sessionStorage['csm-token']` 所在）→ 持 token 全量 API 访问 → 可外泄整个会话语料（源码、粘贴的密钥）/批量删除归档；触发只需**一个共享/下载/恢复来的构造 rollout 文件**。本项目处处以敌对语料设防（stats null-proto、错误脱敏、`COPYFILE_EXCL` 备份、header 注入剥离），唯独此 sink 未转义是**阻断性不一致**。修：`fmtTime` 内部 `esc(...)` 包裹（**必须在 fmtTime 内、非调用点**——list 侧也经此 sink，且未来调用点自动继承安全）；`String(iso)` 转型同时修 **N2**（数字 timestamp 触发 `iso.replace is not a function` 致整个详情面板崩）。正常 ISO 日期经 esc 后逐字节不变（零视觉回归）。**parse5 复验**：三类 payload 经修复后均渲染为惰性 `&lt;…` 文本。
- **N1（Minor，已修，随修复提交）**：token 优先级 bug——原 `sessionStorage.getItem('csm-token') ?? params.get('token')` 让**陈旧**存储 token 压过**新鲜** URL token（服务重启换 token 后，旧标签打开新 `?token=` URL 首屏全 401 且无指引，需手动刷新才自愈）。修：`params.get('token') ?? sessionStorage.getItem('csm-token')`（URL 优先）。
- **延后 Task 13（非阻断，质量审查判定）**：obs#2 `download()` 的 `revokeObjectURL` 时序（Chromium 安全、FF/Safari 历史有取消风险 → 改 `appendChild`+`setTimeout(revoke,0)`）；obs#3 `selectSession` 无在途守卫（快速点击竞态，I7 的 expectedMtimeMs 已把 archive/delete 危险路径转成安全 409，残余仅 rename 错标题、极低概率 → 加 3 行序号令牌 `detailSeq`）；N3 详情拉取失败时 selected/高亮已前移而面板仍旧（rename 会指向新 id 读旧面板 → catch 里回滚）；N4 变更成功后 refresh 失败弹误导性"失败"toast；N5 死状态字段 `state.sessions`/`state.view`（写而不读，loadList→renderList 重构遗留）；N6 `download()` 丢弃服务端错误体（只报 `HTTP 500`）；N7 无加载态（首屏 ~1s、详情 ~1.26s 期间空白；过滤重渲染滚动复位）；N8 a11y（toast 无 aria-live、输入仅 placeholder 标注、无 :focus-visible）；N9 每次切统计页全语料重扫（本地可接受）；N10 clipboard 依赖安全上下文（127.0.0.1 满足，可加 textarea 兜底）；**I-2（core 侧纵深防御）**——catalog 的 `Date.parse` 门收紧为 ISO 形状校验 + reader 的 `createdAt`(L62)/`timestamp`(L70) 补 `typeof==='string'` 守卫（客户端 fmtTime 修复已完全中和面板渲染，core 收紧是为 export/resume 等其它消费者的纵深防御；export/resume 是人类可读产物，按计划 L2166 先例可接受原始 timestamp）。

修复提交：`git add packages/web/public/app.js docs/plans/2026-09-26-codex-session-manager.md && git commit -m "fix(web): 质量审查修复（fmtTime 输出转义堵存储型 XSS、token 优先级）"`（仅 app.js 两行 + 计划文档；index.html/style.css 未改）。修复后须复验：node --check、66/66、parse5 确认 payload 惰性、逐字节一致。

---

### Task 10: plugin — MCP 工具逻辑（与传输层解耦）

**Files:**
- Create: `packages/plugin/src/tools.js`
- Test: `packages/plugin/tests/tools.test.js`

> 设计要点：工具逻辑写成普通 async 函数（`createSessionTools`），`server.mjs` 只做 MCP 接线。测试直接调函数，不经 stdio。

> **Task 10 前置修订（2026-09-26，控制器预审，派发前）**——对照已装 core 契约（catalog/reader/paths/export）与设计文档核验 Step 1/3，两处应修已直接改入下方代码块：
> 1. **countBy 空原型（与 Task 7 stats I2 同款）**：原 `const o = {}` 用 Object 原型对象计数。工具名（`toolCalls`）来自语料 `function_call.name`，reader 不校验——构造的 `'constructor'` 会读到 `Object.prototype.constructor`（函数）再字符串拼接成脏值 `'function Object()…1'`，`'__proto__'` 的赋值则被 `__proto__` setter 吞掉（计数静默丢失）。改为 `Object.create(null)` 后两者都能正确计数；**无全局原型污染**（脏值只是 own property），但为与 Task 7 已确立的标准一致、避免质量审查按同一尺度打回，现在就修。MCP 出口是 `JSON.stringify`，null-proto 序列化结果与普通对象逐字节相同，Task 11 接线不受影响。
> 2. **连带改 Step 1 测试 1 的断言**：`node:assert/strict` 下 `assert.deepEqual` 即 `deepStrictEqual`，**会校验原型**——null-proto 的 `toolCallCounts` 直接 deepEqual 普通字面量 `{exec_command:1}` 会因原型不符而失败。改为 `assert.deepEqual({ ...detail.toolCallCounts }, { exec_command: 1 })`（展开成 Object 原型副本再比），语义不变（仍断言"恰一个 exec_command 计数 1"）。
> 3. **load() 标题兜底 `?? session.id` → `?? null`（对齐 web detail / Task 8 I6）**：`get_session` 已单独返回 `id` 字段，标题再兜底成 UUID 属冗余；改 `?? null` 后 (a) `get_session` 的 `title=null` 诚实表示"无标题"、与 web `/api/sessions/:id` 一致；(b) `export_session format=json` 的 `title=null` 与 web JSON 导出一致（数据保真，不把 id 冒充 title）；(c) **MD 导出标题不受影响**——`renderExport→toMarkdown` 内部是 `session.title ?? session.id`，null 会再次兜底成 UUID（`# a`），信息量不减。测试 1 有 index 标题（`'会话A'`）、测试 3 不断言 title，故两处测试均不破。
>
> **已核实无需改动的事实**（预审验证，避免实现者误判）：
> - `readIndex` 对缺失 `session_index.jsonl` 返回**空 Map**（catalog.js:13 `ENOENT→return map`），故测试 3 不写 index 时 `load()` 不抛、`index.get('a')?.title` 为 `undefined`→兜底 `null`。
> - `anchor(root,p)`（paths.js:31）对**相对路径** `resolve(root,p)` 解析进 home、对 home 外**绝对路径**经 `assertInside` 抛 `CsmError('invalid')`——精确匹配测试 3 的三条断言（默认 `exports/a.md`、相对 `rel.md`→`home/rel.md`、`/etc/evil.md`→invalid）。`export_session` 中 `renderExport(s,format)` 在构造 dest **之前**调用，非法 format 先抛 invalid，`${id}.${format}` 不会拿到非法扩展名；非法 id 则先被 `load()` 的 not_found 挡住。
> - **6 个工具面与设计文档逐条一致**（design line 105-110：list/get/rename/archive/delete/export）；`resume`/`stats` 是 **web 专属**端点（design line 100-101），MCP 不暴露属**有意设计**，非遗漏。`archive_session`/`delete_session` 只透传 `force`、不带 `expectedMtimeMs`——陈旧防护是 web UI 的乐观并发特性，MCP 侧由 core 的 30s 活跃写入防护兜底，符合设计。
>
> **给 Task 11（SKILL.md）的待办**：`get_session` 返回**完整 messages**（无截断），真实语料存在 640+ 消息的会话，单次响应可能很大（token 成本 / MCP 帧）。SKILL.md 应引导：浏览用 `list_sessions`、续接理解用 `get_session`（注意大会话）、归档/全量用 `export_session`；如需紧凑续接上下文，web 侧的 resume 才是该形态（MCP v0.1 不提供 resume 工具）。

**Step 1: 写失败测试** `packages/plugin/tests/tools.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionTools } from '../src/tools.js'
import { backdate, makeHome, writeIndex, writeSession } from '../../core/tests/helpers/fixture.js'

test('list_sessions / get_session', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'a', day: '2026-05-20', userText: '目标A' })
  await writeIndex(home, [{ id: 'a', thread_name: '会话A', updated_at: '2026-05-20T12:00:00Z' }])
  const tools = createSessionTools({ home })
  const list = await tools.list_sessions({})
  assert.equal(list.count, 1)
  assert.equal(list.sessions[0].title, '会话A')
  assert.equal((await tools.list_sessions({ query: 'zzz' })).count, 0)
  const detail = await tools.get_session({ id: 'a' })
  assert.equal(detail.title, '会话A')
  assert.ok(detail.messages.some((m) => m.text === '目标A'))
  assert.deepEqual({ ...detail.toolCallCounts }, { exec_command: 1 }) // countBy 返回 null-proto 对象，展开成普通对象再比（node:assert/strict 的 deepEqual 即 deepStrictEqual，会查原型）
  await assert.rejects(() => tools.get_session({ id: 'nope' }), (e) => e.code === 'not_found')
})

test('rename / archive / delete 透传 core 语义', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  const tools = createSessionTools({ home })
  assert.equal((await tools.rename_session({ id: 'a', title: 'T2' })).title, 'T2')
  assert.equal((await tools.archive_session({ id: 'a' })).location, 'archived')
  assert.equal((await tools.delete_session({ id: 'a' })).location, 'trash')
})

test('export_session: 默认 CODEX_HOME/exports；outputPath 锚定在 CODEX_HOME 内', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  const tools = createSessionTools({ home })
  const r = await tools.export_session({ id: 'a', format: 'md' })
  assert.equal(r.path, join(home, 'exports', 'a.md'))
  assert.ok((await readFile(r.path, 'utf8')).includes('会话'))
  await stat(r.path)
  const r2 = await tools.export_session({ id: 'a', outputPath: 'rel.md' })
  assert.equal(r2.path, join(home, 'rel.md'), '相对路径解析进 CODEX_HOME')
  await assert.rejects(() => tools.export_session({ id: 'a', outputPath: '/etc/evil.md' }), (e) => e.code === 'invalid')
  // I-3：export_session 的工具专属组合属性——json 默认命名 + 非法 format 在任何 fs 写入前抛 invalid（零副作用）
  const rj = await tools.export_session({ id: 'a', format: 'json' })
  assert.equal(rj.path, join(home, 'exports', 'a.json'))
  assert.equal(JSON.parse(await readFile(rj.path, 'utf8')).id, 'a')
  await assert.rejects(() => tools.export_session({ id: 'a', format: '../../evil' }), (e) => e.code === 'invalid')
  assert.deepEqual((await readdir(home)).sort(), ['exports', 'rel.md', 'sessions'], '非法 format ⇒ 零 fs 副作用')
})

test('安全护栏：export 拒绝覆盖 exports/ 外文件、rename 标题封顶', async () => {
  const home = await makeHome()
  const p = await writeSession(home, { id: 'a', day: '2026-05-20' })
  await backdate(p)
  const tools = createSessionTools({ home })
  // I-1：outputPath 指向 exports/ 外的既有文件 → conflict 且原文件完好（皇冠明珠防护，全产品唯一不可逆写）
  await writeFile(join(home, 'precious.txt'), 'ORIGINAL')
  await assert.rejects(() => tools.export_session({ id: 'a', outputPath: 'precious.txt' }), (e) => e.code === 'conflict')
  assert.equal(await readFile(join(home, 'precious.txt'), 'utf8'), 'ORIGINAL')
  // exports/ 内同名文件允许幂等重导（不 conflict）
  const e1 = await tools.export_session({ id: 'a', format: 'md' })
  const e2 = await tools.export_session({ id: 'a', format: 'md' })
  assert.equal(e1.path, e2.path)
  // I-2：rename 标题超过 200 → invalid（镜像 web MAX_TITLE）
  await assert.rejects(() => tools.rename_session({ id: 'a', title: 'x'.repeat(201) }), (e) => e.code === 'invalid')
})
```

**Step 2: 跑测试确认失败**

Run: `node --test packages/plugin/tests/tools.test.js`
Expected: FAIL，`Cannot find module '.../src/tools.js'`

**Step 3: 实现** `packages/plugin/src/tools.js`

```js
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import * as core from '@csm/core'

function countBy(arr) {
  // 空原型：工具名来自语料，构造的 'constructor'/'__proto__' 若落到 Object 原型对象上会产生脏值或丢计数
  // （与 Task 7 stats I2 同款）；null-proto 下两者都能正确计数，且 JSON 序列化（MCP 出口）不受影响。
  const o = Object.create(null)
  for (const x of arr) o[x] = (o[x] ?? 0) + 1
  return o
}

/** 标题长度上限（I6 决策：core 不限，web/MCP 入口层封顶；镜像 web server.mjs 的 MAX_TITLE=200）。 */
const MAX_TITLE = 200

/** 创建 6 个 MCP 工具的实现函数（home 缺省用 CODEX_HOME）。 */
export function createSessionTools({ home } = {}) {
  const H = home ?? core.codexHome()

  async function load(id) {
    const found = await core.findSessionFile(H, id)
    if (!found) throw new core.CsmError('not_found', `session ${id} not found`)
    const session = await core.readSessionFile(found.path)
    const index = await core.readIndex(H)
    session.title = index.get(id)?.title ?? null // 对齐 web detail（Task 8 I6）：null=无标题；get_session 已单独返回 id，无需 UUID 兜底；renderExport 内部仍 ?? session.id 故 MD 标题保留 UUID
    session.archived = found.location !== 'active'
    return session
  }

  return {
    async list_sessions({ query, cwd, model } = {}) {
      const sessions = await core.listSessions({ home: H, q: query, cwd, model })
      return {
        count: sessions.length,
        sessions: sessions.map((s) => ({
          id: s.id, title: s.title, cwd: s.cwd, model: s.model,
          provider: s.provider, updatedAt: s.updatedAt, archived: s.archived,
        })),
      }
    },
    async get_session({ id } = {}) {
      const s = await load(id)
      return {
        id: s.id, title: s.title, cwd: s.cwd, model: s.model, provider: s.provider,
        createdAt: s.createdAt, updatedAt: s.updatedAt, tokens: s.tokens, archived: s.archived,
        messages: s.messages, toolCallCounts: countBy(s.toolCalls), badLines: s.badLines, // M-3：对齐 web detail/JSON 导出，对抗语料下透出不可解析行数
      }
    },
    async rename_session({ id, title } = {}) {
      // I-2（镜像 web MAX_TITLE=200）：入口层封顶，防一次 LLM 调用用超长标题永久污染 append-only 索引（此后每次 list/get 都 token 爆炸）
      if (typeof title === 'string' && title.length > MAX_TITLE) {
        throw new core.CsmError('invalid', `title too long (max ${MAX_TITLE} characters)`)
      }
      return core.renameSession({ home: H, id, title })
    },
    async archive_session({ id, force } = {}) {
      return core.archiveSession({ home: H, id, force })
    },
    async delete_session({ id, force } = {}) {
      return core.deleteSession({ home: H, id, force })
    },
    async export_session({ id, format = 'md', outputPath } = {}) {
      const s = await load(id)
      const text = core.renderExport(s, format) // 非法 format 在此抛 invalid，早于任何 fs 副作用（I-3 顺序保证）
      const exportsDir = join(H, 'exports')
      let dest
      try {
        // anchor 保证 outputPath 只能落在 CODEX_HOME 内：相对路径解析进 home，home 外绝对路径抛 invalid
        dest = core.anchor(H, outputPath ?? join(exportsDir, `${id}.${format}`))
        await mkdir(dirname(dest), { recursive: true })
        // I-1：拒绝覆盖 exports/ 之外的既有文件——session_index/rollout 是产品皇冠明珠，此为全产品唯一不可逆无备份写；
        //      exports/ 内同名文件允许幂等重导（wx 独占创建，EEXIST → conflict）。
        const insideExports = dest === exportsDir || dest.startsWith(exportsDir + sep)
        await writeFile(dest, text, { flag: insideExports ? 'w' : 'wx' })
      } catch (e) {
        if (e instanceof core.CsmError) throw e // anchor 的路径逃逸 invalid 原样透出（测试 3 依赖）
        // M-1：其余 fs/参数错误（EISDIR/EACCES/ENAMETOOLONG/NUL TypeError…）脱敏成域错误码，只暴露 errno 不泄漏绝对路径
        if (e?.code === 'EEXIST') throw new core.CsmError('conflict', 'target file already exists; refusing to overwrite outside exports/')
        throw new core.CsmError('invalid', `cannot write export: ${e?.code ?? 'unknown error'}`)
      }
      return { path: dest, bytes: Buffer.byteLength(text) }
    },
  }
}
```

**Step 4: 跑测试确认通过**

Run: `node --test packages/plugin/tests/tools.test.js`
Expected: PASS（4 tests）

**Step 5: Commit**

```bash
git add packages/plugin/src/tools.js packages/plugin/tests/tools.test.js
git commit -m "feat(plugin): 会话管理 MCP 工具逻辑（list/get/rename/archive/delete/export）"
```

> **Task 10 质量审查修订（2026-09-26，判定"With fixes"：0 阻断 / 3 Important / 若干 Minor）**
>
> **两阶审查再次印证（继 Task 9 之后第二次）**：规格审查判 **YES**（代码与计划逐字节一致、契约逐行对照 core 源证明、RED 实证、69/69），但质量审查用实证探针（~15 个 mkdtemp home + 真实 ~/.codex 只读）发现 **3 个 Important 全是"计划级 bug"**——代码忠实实现了一个有缺陷的计划，故规格审查（只验"代码==计划"）结构上抓不到，只有质量审查（验"代码好不好"）能抓。其中 **I-2 直接违背本计划自己的 I6 决策**（line 1940「标题长度上限由 web/MCP 入口层约束」明确绑定 Task 8/10），**I-1 违背代码库自身「绝不覆盖已有文件」「宁可响亮失败也不静默覆盖」不变量**（mutate.js uniqueDest / COPYFILE_EXCL 备份）。
>
> **I-1（Important，Task 11 接线后即变 Blocking）— export_session 静默覆盖 CODEX_HOME 内任意既有文件、无备份**：原 `writeFile(dest, text)` 默认 `'w'` 旗标。`dest` 经 anchor 限制在 CODEX_HOME 内，但 **anchor 只护"不逃出 home"，不护"home 内的内容"**——而 home 内正是产品皇冠明珠（session_index.jsonl、活跃 rollout）。实证：`export_session({id, outputPath:'session_index.jsonl'})` → 索引被导出内容覆盖、**全部标题永久丢失且无 .csm-backups**；`outputPath` 指向会话自身 rollout → 1839B→290B、随后 `list_sessions` 计数 1→0、`get_session`→not_found（**彻底不可恢复**）。这是全产品唯一不可逆、无备份的写，由 LLM 一个自由字符串触发（威胁模型明确：LLM 可传任意 outputPath、语料视为对抗）。**修复**：`exports/` 外用 `wx` 独占创建（命中既有文件 EEXIST → `CsmError('conflict')`，拒绝覆盖）；`exports/` 内用 `'w'`（允许幂等重导同名导出文件）。（**注意 Node API 陷阱**：`fsPromises.writeFile(file, data, options)` 的第三参若为**纯字符串**表示的是 **encoding 而非 flag**——`'w'`/`'wx'` 会抛 `ERR_INVALID_ARG_VALUE: invalid encoding`；必须传对象 `{ flag: 'w'|'wx' }`。控制器初稿正踩此坑、且被 M-1 的 catch 吞成 `cannot write export: ERR_INVALID_ARG_VALUE`，连默认 `exports/a.md` 路径都写不出、把本已通过的测试 3 也带崩；fixer 在 RED→GREEN 的 GREEN 阶段抓到并 STOP，改成 `{ flag: insideExports ? 'w' : 'wx' }` 后才重派——TDD 强制 GREEN 正是为暴露这类计划级 bug。）
> **I-2（Important）— rename_session 无标题长度上限，违背计划 I6 决策**：web 在 server.mjs 封顶 `MAX_TITLE=200`（超长→400 invalid），MCP 层不封，且 Task 11 计划的 zod（`title: z.string()`）也无 `.max()`——整个 MCP 栈缺失该上限。实证：一次 100 万字符标题被接受 → append-only 索引行涨到 1,000,067B → **此后每次 list_sessions 响应 ~1MB（~250K tokens）、web 列表也被毒化**，且索引追加语义使膨胀永久（改回标题后索引仍 1,000,416B，每次后续 rename 还要备份这坨）。**修复**：`rename_session` 入口镜像 web——`if (typeof title === 'string' && title.length > MAX_TITLE) throw new core.CsmError('invalid', \`title too long (max ${MAX_TITLE} characters)\`)`（core 仍负责非字符串/空校验）；`MAX_TITLE=200` 常量置于 tools.js（I6 决策：core 不限、入口层各自封顶，故与 web 各持一份是有意为之）。Task 11 zod 可再加 `.max(200)` 双保险。
> **I-3（Important）— export_session 工具专属组合属性无回归测试**：计划的安全论证（「非法 format 先抛 invalid，`${id}.${format}` 不会拿到非法扩展名」）与 json 默认命名（`exports/<id>.json`）是**只存在于 tools.js 的组合逻辑**，core 的 renderExport 测试证明了"抛 invalid"但证明不了"抛在任何 fs 副作用之前的顺序"，也无任何测试覆盖 json 默认文件名。一次未来重构（如"先构造 dest 好让错误消息带上它"）会静默打破该顺序，之后 `format:'../../../etc/evil'` 式输入就能在校验前于 home 内 mkdir/写入受攻击者影响的名字。**修复**：测试 3 追加 json 默认路径 + 非法 format 零 fs 副作用断言（`readdir(home)` 仍为 `['exports','rel.md','sessions']`）。
>
> **控制器补强（质量审查 I-3 提案的缺口）**：质量审查建议的 I-3 测试只覆盖"组合属性"（json 路径 + 非法 format 顺序），而这些**在旧代码上也通过**（既有正确行为），不是 RED→GREEN 判别器；**I-1（覆盖→conflict）、I-2（超长→invalid）才是真正的行为变更，却没有判别测试**——没有它们，修复无回归保护、fixer 也无法展示真 RED→GREEN。故控制器新增**第 4 个测试块「安全护栏」**：(a) 在 home 根写 `precious.txt`，`export_session({outputPath:'precious.txt'})` 须 reject `conflict` 且原文件完好（I-1 判别器：旧码静默覆盖→不 reject→RED）；(b) `exports/` 内同名 md 连导两次须都成功且同路径（幂等重导回归保护）；(c) `rename_session({title:'x'.repeat(201)})` 须 reject `invalid`（I-2 判别器：旧码无封顶→接受→不 reject→RED）。**plugin 测试由 3 增至 4，全套由 69 增至 70**（core 55 + web 11 + plugin 4）。
>
> **Minor 顺修（随本次 fix commit）**：
> - **M-1 错误脱敏**：原 `export_session` 的 mkdir/writeFile/anchor 会逃逸原始非-CsmError（实证清单：`outputPath:''`→EISDIR、父路径是文件→mkdir EEXIST、NUL 字节→realpathSafe 抛 ERR_INVALID_ARG_VALUE TypeError、5000 字符组件→ENAMETOOLONG、chmod000→EACCES、零参调用→解构 TypeError）。修复：把 anchor+mkdir+writeFile 包进 try——`e instanceof core.CsmError` 原样透出（anchor 路径逃逸的 invalid，测试 3 依赖）、`EEXIST`→conflict、其余→`CsmError('invalid', \`cannot write export: ${e.code}\`)`（只暴露 errno、不泄漏绝对路径，对齐 web I5 脱敏姿态）；并给 get/rename/archive/delete 补 `= {}` 默认参（list/export 本就有），消除零调解构 TypeError、保持 6 工具签名对称。
> - **M-3 badLines**：`get_session` 原丢弃 `badLines`（web detail 与 JSON 导出都带）。对抗语料姿态下 LLM 应知道有不可解析行。修复：返回体加 `badLines: s.badLines`（一字段）。
>
> **实证正确、不改**：`countBy` 空原型（质量审查用含 `function_call name:'__proto__'×2/'constructor'/'toString'/'hasOwnProperty'` 的真实 rollout 验证：原型为 null、`__proto__`=2 为 own property、`constructor`=1、全局未污染、`JSON.stringify` 上线 `{"__proto__":2,...}` 经 `JSON.parse` 往返定义 own `__proto__` 无污染；naive-`{}` 复刻则重现两个文档化 bug）；`title ?? null`（无索引会话 get_session.title=null ≡ web detail、MD 标题 `# <uuid>`、JSON 导出 title=null 且不泄漏 archived/mtimeMs）。
>
> **延后**：**M-2**（list_sessions 的 `archived` 恒 false 字段 + archive 后无 MCP 工具能重新发现该会话、`archived:true` 混淆 archived_sessions/ 与 .csm-trash/）与 **M-4**（载荷体积：实测真实语料 list_sessions 141KB/~35K tokens、最坏 get_session 0.71MB/~190K tokens）→ **Task 11 SKILL.md 必须明文引导**（list 永远带过滤、大会话优先 export 而非 get_session、archived/trashed 会话从 list 消失但仍可按 id 操作），v0.2 再考虑 maxMessages/分页；**M-5**（写失败时 mkdir 残留目录树）+ **M-6**（anchor-realpath 与 writeFile 间的 TOCTOU；wx 已收窄；同用户进程无提权）→ 信息性，归 Task 13 遗留包。
>
> **修复 commit**：`git add packages/plugin/src/tools.js packages/plugin/tests/tools.test.js docs/plans/2026-09-26-codex-session-manager.md && git commit -m "fix(plugin): 质量审查修复（export 覆盖防护、rename 标题封顶、错误脱敏、badLines、安全护栏测试）"`（计划文档的质量修复修订随代码一并提交，匹配 Task 9 模式）
> **复审要求**：fixer 须先覆盖测试（新 4 块）跑旧 tools.js 展示 **RED**（第 4 块 I-1/I-2 判别器失败），再覆盖 tools.js 跑 **GREEN（4/4 + 全套 70/70）**；复审须实证：I-1（导出到既有 session_index.jsonl / rollout / precious.txt → conflict 且原文件逐字节不变；exports/ 内重导幂等）、I-2（201 字符 → invalid、200 字符通过、与 web 一致）、I-3（新测试通过、非法 format 零副作用）、M-1（各 errno → 域错误码、无绝对路径泄漏、anchor 路径逃逸仍 invalid）、M-3（badLines 透出）、与计划逐字节一致、无回归。

---

### Task 11: plugin — MCP server 接线 + 插件清单 + SKILL.md

**Files:**
- Create: `packages/plugin/server.mjs`、`packages/plugin/.codex-plugin/plugin.json`、`packages/plugin/.mcp.json`（模板）、`packages/plugin/skills/session-manager/SKILL.md`

**Step 1: 写 `packages/plugin/server.mjs`**

```js
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
  description: '列出/搜索 Codex 历史会话（返回 id、标题、项目 cwd、模型、更新时间）。仅列活跃会话——归档/删除后不再出现（按 id 仍可操作，见 SKILL.md）。大语料下响应可达上百 KB，务必用 query/cwd/model 过滤。',
  inputSchema: {
    query: z.string().optional().describe('关键字（标题/ID/目录，包含匹配）'),
    cwd: z.string().optional().describe('项目目录过滤（包含匹配）'),
    model: z.string().optional().describe('模型过滤（精确匹配）'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, wrap(tools.list_sessions))

server.registerTool('get_session', {
  title: '读取会话全文',
  description: '读取一个会话的完整内容（消息流、toolCallCounts、tokens、badLines）。大会话输出最坏可达 ~0.7MB（数十万 tokens）——若只为回顾/迁移，优先用 export_session 落地文件再按需读片段，别把全文灌进上下文。',
  inputSchema: {
    id: z.string().describe('会话 ID'),
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
```

**Step 2: 写插件清单 `packages/plugin/.codex-plugin/plugin.json`**

```json
{
  "name": "session-manager",
  "version": "0.1.0",
  "description": "Search, read, rename, archive, soft-delete and export Codex sessions from within any conversation.",
  "author": { "name": "LanguidAI" },
  "license": "MIT",
  "keywords": ["session", "history", "manager", "export", "archive"],
  "mcpServers": "./.mcp.json",
  "skills": "./skills/",
  "interface": {
    "displayName": "Session Manager",
    "shortDescription": "搜索与管理 Codex 历史会话",
    "longDescription": "在对话中直接查询、读取、重命名、归档、软删除和导出 Codex 会话历史。",
    "developerName": "LanguidAI",
    "category": "Productivity",
    "capabilities": ["Read", "Write"]
  }
}
```

**Step 3: 写 `.mcp.json` 模板 `packages/plugin/.mcp.json`**（安装时由 install.mjs 用绝对路径重写，此模板仅供文档/独立使用）

```json
{
  "mcpServers": {
    "session_manager": {
      "command": "node",
      "args": ["./server.mjs"],
      "cwd": "{{PLUGIN_REPO_DIR}}",
      "default_tools_approval_mode": "approve",
      "tools": {
        "rename_session": { "approval_mode": "prompt" },
        "archive_session": { "approval_mode": "prompt" },
        "delete_session": { "approval_mode": "prompt" }
      }
    }
  }
}
```

**Step 4: 写 `packages/plugin/skills/session-manager/SKILL.md`**

```markdown
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
```

**Step 5: 冒烟验证 MCP server 能启动**

Run:
```bash
cd /Users/xuxianxian/Documents/test/codex-session-manager
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
| CODEX_HOME=/tmp/csm-smoke node packages/plugin/server.mjs 2>/dev/null > /tmp/csm-smoke-out.jsonl
echo "node 退出码=$?（stdin EOF 后应为 0，非挂起）"
grep -q 'session-manager' /tmp/csm-smoke-out.jsonl && echo "✓ initialize 响应含 serverInfo name=session-manager" || echo "✗ 无 serverInfo"
n=0; for t in list_sessions get_session rename_session archive_session delete_session export_session; do grep -q "\"name\":\"$t\"" /tmp/csm-smoke-out.jsonl && n=$((n+1)) || echo "✗ 缺工具 $t"; done; echo "✓ 已注册工具数=$n/6"
grep -q '"destructiveHint":true' /tmp/csm-smoke-out.jsonl && echo "✓ delete_session 的 destructiveHint:true 上线（annotations 生效）" || echo "✗ 无 destructiveHint"
rm -f /tmp/csm-smoke-out.jsonl
```
Expected: `node 退出码=0`（进程在 stdin EOF 后正常退出、不挂起）；`✓ serverInfo name=session-manager`；`✓ 已注册工具数=6/6`；`✓ destructiveHint:true 上线`。（控制器已用同款最小 server 探针实证：registerTool+annotations 正确上线 tools/list、raw-shape inputSchema 生效、stdin EOF→exit 0、protocolVersion 2024-11-05 被接受，故此冒烟不会挂起、无需 timeout。）

**Step 6: Commit**

```bash
git add packages/plugin/server.mjs packages/plugin/.codex-plugin packages/plugin/.mcp.json packages/plugin/skills
git commit -m "feat(plugin): MCP server 接线、插件清单与 session-manager SKILL.md"
```

> **Task 11 预审修订（2026-09-27，控制器对照已装 @modelcontextprotocol/sdk 1.30.1 + zod 3.25.76 + mcp-builder 技能 + 设计文档，派发前修订；amendments 以 docs(plan) 单独提交后再派 implementer）**
>
> **修订 1 — `server.tool` → `registerTool`（废弃 API 修正）**：计划初稿用 `server.tool(name, desc, schema, cb)` 注册 6 工具。对照已装 SDK 1.30.1 的 `mcp.d.ts`（L110–146）发现 **`tool()` 全部 6 个 overload 均标 `@deprecated Use registerTool instead`**；mcp-builder 技能亦明令「DO use `registerTool` / DO NOT use `server.tool()`」。已改为现代 API `registerTool(name, {title, description, inputSchema, annotations}, cb)`。**控制器已实证**（同款结构最小 server 探针，跑完即删、树净）：registerTool 注册成功、annotations 正确上线 tools/list、raw-shape `inputSchema`（`{q:z.string().optional()}`）生效、**stdin EOF 后进程 exit 0（Step 5 冒烟不挂起）**、protocolVersion `2024-11-05` 被接受、initialize 响应 serverInfo 含 name/version。
> **修订 2 — annotations（安全语义上线）**：每工具加 ToolAnnotations，向客户端/模型传达只读/破坏性语义（便于对破坏性工具做审批门控）：`list_sessions`/`get_session`=`readOnlyHint:true`；`rename`/`archive`/`export`=`readOnlyHint:false, destructiveHint:false`；**`delete_session`=`destructiveHint:true`**；`idempotentHint`：读类+rename+export=true、archive/delete=false（二次调用会 already-archived/trashed→invalid）；全部 `openWorldHint:false`（操作本地语料、封闭世界）。
> **修订 3 — M-2/M-4 延后项落实（Task 10 质量审查明确要求 SKILL.md 承载）**：(a) **工具 description 内嵌**（tools/list 即对模型可见，无需先加载技能）：list_sessions「大语料响应可达上百 KB，务必用 query/cwd/model 过滤」+「仅列活跃会话」；get_session「大会话最坏 ~0.7MB，回顾/迁移优先 export_session 落地文件」；archive/delete「之后从 list 消失、按 id 仍可操作、无 restore 工具」。(b) **SKILL.md 新增两专节**：「体积与性能」（M-4）+「归档/删除后的可见性」（M-2：从 list 消失、无工具可重列归档/回收站、按 id 仍可 get/rename/export、无 restore/undelete 需手动移回、get_session 的 `archived` 字段对已归档与在回收站都为 true 不区分）。
> **修订 4 — rename 标题 zod `.max(200)`（双保险）**：`title: z.string().max(200)` 与 Task 10 tools.js 的 `MAX_TITLE=200` 封顶形成两层——zod 层在 handler 前即拒 >200（SDK 返回校验错误，不经 wrap），tools.js 层兜底且已被 Task 10 测试直接覆盖（该测试直调 `tools.rename_session`、绕过 zod，故两层不冲突、各有验证）。
> **修订 5 — Step 5 冒烟增强**：原版只发 initialize（无法验证工具是否真注册）。改为发 initialize + `notifications/initialized` + tools/list，断言 serverInfo name=session-manager、**6/6 工具注册**、delete_session 的 `destructiveHint:true` 上线、node 退出码=0（EOF 退出、非挂起）。
>
> **已核实无需改**：import 路径 `@modelcontextprotocol/sdk/server/mcp.js`、`.../server/stdio.js` 经 exports `./*` 通配解析（→ `dist/esm/server/{mcp,stdio}.js`，两文件实存）；zod 3.25.76 标准 API（`.optional()/.describe()/.max()/.enum()/.boolean()`）；`ok/fail/wrap`（领域错误→isError 结果而非协议异常）模式正确——wrap 只捕 handler 内错误，zod 校验错误由 SDK 自行返回（预期行为）。**Task 11 不新增单元测试**（server.mjs 是 stdio 接线层；6 工具的输入/输出契约已由 Task 10 的 tools.test.js 进程内测 4 个覆盖，符合设计文档 L137「进程内直调、不经 stdio」），验证靠 Step 5 冒烟 + Task 13 真实安装；**全套测试维持 70/70**。
>
> **清单 schema 暂定、Task 13 真实安装为权威校验点**：`plugin.json` / `.mcp.json` 字段取自设计文档（L32–33、L60–64）+ Codex 惯例。联网核实**部分成功**：`PluginMcpServerConfig` 确存在于 openai/codex `codex-rs/core/config.schema.json`、`default_tools_approval_mode` 确为真实 Codex 字段（GitHub issue #29857 标题佐证）；但字段级完整 schema 未能核验（网络不稳：developers.openai.com 返 403、raw config.schema.json 30s 超时）。→ **Task 13（装入真实 Codex Desktop 验证插件加载、工具出现）是清单的权威校验**；在此之前清单按暂定处理，若 Task 13 发现字段出入（如 `mcpServers` vs `mcp_servers`、interface 块字段名、approval_mode 取值）就在 Task 13 修正。`.mcp.json` 模板的 `{{PLUGIN_REPO_DIR}}` 占位符由 Task 12 install.mjs 用绝对路径重写。
> **SKILL.md 放置 — 设计↔计划不一致（取计划）**：设计文档目录树（L63）画 `plugin/SKILL.md`（顶层），计划放 `plugin/skills/session-manager/SKILL.md`——后者与 plugin.json 的 `"skills":"./skills/"` 引用 + Codex 技能惯例（`skills/<name>/SKILL.md`）自洽，设计文档树是简化画法。**保留计划放置**；Task 13 可顺带把设计文档树更新一致（非必须）。

---

### Task 12: plugin — 本地安装脚本（marketplace + config.toml）

**Files:**
- Create: `packages/plugin/install.mjs`
- Test: `packages/plugin/tests/install.test.js`

**Step 1: 写失败测试** `packages/plugin/tests/install.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installPlugin, removeTomlSection, uninstallPlugin, upsertTomlSection } from '../install.mjs'
import { makeHome } from '../../core/tests/helpers/fixture.js'

async function fakePluginDir() {
  const dir = join(await makeHome(), 'plugin-src')
  await mkdir(join(dir, '.codex-plugin'), { recursive: true })
  await mkdir(join(dir, 'skills', 'session-manager'), { recursive: true })
  await writeFile(join(dir, '.codex-plugin', 'plugin.json'), '{"name":"session-manager"}')
  await writeFile(join(dir, 'skills', 'session-manager', 'SKILL.md'), '---\nname: session-manager\n---\n')
  await writeFile(join(dir, 'server.mjs'), '// stub')
  return dir
}

const BASE_CONFIG = `model = "x"\n\n[desktop]\nlocaleOverride = "zh-CN"\n\n[marketplaces.openai-bundled]\nsource_type = "local"\nsource = "/some/where"\n`

test('upsertTomlSection: 追加新节 / 原地更新 / 不动其他节', () => {
  let t = upsertTomlSection(BASE_CONFIG, '[marketplaces.csm]', ['source_type = "local"', 'source = "/m"'])
  assert.ok(t.includes('[marketplaces.csm]'))
  assert.ok(t.includes('source = "/m"'))
  assert.ok(t.includes('[desktop]'), '原有节保留')
  assert.ok(t.includes('[marketplaces.openai-bundled]'), '原有市场节保留')
  const again = upsertTomlSection(t, '[marketplaces.csm]', ['source_type = "local"', 'source = "/m2"'])
  assert.equal(again.split('[marketplaces.csm]').length, 2, '不重复追加')
  assert.ok(again.includes('source = "/m2"'))
  assert.ok(!again.includes('source = "/m"\n'), '旧值被替换')
})

test('removeTomlSection: 只删目标节', () => {
  const t = removeTomlSection(BASE_CONFIG, '[desktop]')
  assert.ok(!t.includes('[desktop]'))
  assert.ok(!t.includes('localeOverride'))
  assert.ok(t.includes('[marketplaces.openai-bundled]'))
})

test('installPlugin: 市场目录 + 清单 + config 条目 + 备份 + 幂等', async () => {
  const home = await makeHome()
  await writeFile(join(home, 'config.toml'), BASE_CONFIG)
  const pluginDir = await fakePluginDir()
  await installPlugin({ home, pluginDir })
  const market = join(home, 'marketplaces', 'csm')
  await stat(join(market, '.agents', 'plugins', 'marketplace.json'))
  await stat(join(market, 'plugins', 'session-manager', '.codex-plugin', 'plugin.json'))
  const mcp = JSON.parse(await readFile(join(market, 'plugins', 'session-manager', '.mcp.json'), 'utf8'))
  assert.equal(mcp.mcpServers.session_manager.cwd, pluginDir, 'MCP 指向仓库内 server（依赖解析可用）')
  assert.ok(mcp.mcpServers.session_manager.args[0].endsWith('server.mjs'))
  const cfg = await readFile(join(home, 'config.toml'), 'utf8')
  assert.ok(cfg.includes('[marketplaces.csm]'))
  assert.ok(cfg.includes('[plugins."session-manager@csm"]'))
  assert.ok(cfg.includes('enabled = true'))
  assert.ok(cfg.includes('localeOverride'), '用户原配置未破坏')
  const bakFiles = (await readdir(home)).filter((f) => f.startsWith('config.toml.bak-csm-'))
  assert.ok(bakFiles.length >= 1, 'config.toml 修改前已备份')
  await installPlugin({ home, pluginDir }) // 幂等
  const cfg2 = await readFile(join(home, 'config.toml'), 'utf8')
  assert.equal(cfg2.split('[marketplaces.csm]').length, 2)
})

test('uninstallPlugin: 移除条目与市场目录，保留其他配置', async () => {
  const home = await makeHome()
  await writeFile(join(home, 'config.toml'), BASE_CONFIG)
  const pluginDir = await fakePluginDir()
  await installPlugin({ home, pluginDir })
  await uninstallPlugin({ home })
  const cfg = await readFile(join(home, 'config.toml'), 'utf8')
  assert.ok(!cfg.includes('[marketplaces.csm]'))
  assert.ok(!cfg.includes('[plugins."session-manager@csm"]'))
  assert.ok(cfg.includes('localeOverride'))
  await assert.rejects(() => stat(join(home, 'marketplaces', 'csm')))
})
```

**Step 2: 跑测试确认失败**

Run: `node --test packages/plugin/tests/install.test.js`
Expected: FAIL，`Cannot find module '.../install.mjs'`

**Step 3: 实现** `packages/plugin/install.mjs`

```js
#!/usr/bin/env node
/**
 * 把 session-manager 插件安装为 Codex 本地 marketplace 插件：
 * 1) 复制插件到 $CODEX_HOME/marketplaces/csm/plugins/session-manager（.mcp.json 用仓库绝对路径物化）
 * 2) 备份并更新 $CODEX_HOME/config.toml（[marketplaces.csm] + [plugins."session-manager@csm"]）
 * --uninstall 反向移除。
 */
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexHome } from '@csm/core'

const MARKET_NAME = 'csm'
const PLUGIN_NAME = 'session-manager'
const HERE = dirname(fileURLToPath(import.meta.url))

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 在 TOML 文本中插入或原地替换一个节（节内容到下一个 [ 或文件尾为止）。 */
export function upsertTomlSection(text, header, lines) {
  const block = [header, ...lines].join('\n')
  const re = new RegExp(`^${escapeRe(header)}[ \\t]*$`, 'm')
  const m = re.exec(text)
  if (!m) {
    const gap = text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
    return `${text}${gap}${block}\n`
  }
  const afterHeader = m.index + m[0].length
  const rest = text.slice(afterHeader)
  const next = rest.search(/^\[/m)
  const end = next === -1 ? text.length : afterHeader + next
  return `${text.slice(0, m.index)}${block}\n\n${text.slice(end).replace(/^\n+/, '')}`
}

/** 从 TOML 文本中删除一个节（含其键值行）。 */
export function removeTomlSection(text, header) {
  const re = new RegExp(`^${escapeRe(header)}[ \\t]*$`, 'm')
  const m = re.exec(text)
  if (!m) return text
  const afterHeader = m.index + m[0].length
  const rest = text.slice(afterHeader)
  const next = rest.search(/^\[/m)
  const end = next === -1 ? text.length : afterHeader + next
  return `${text.slice(0, m.index)}${text.slice(end).replace(/^\n+/, '')}`
}

async function readConfig(home) {
  try {
    return await readFile(join(home, 'config.toml'), 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return ''
    throw e
  }
}

async function writeConfigWithBackup(home, text) {
  const cfgPath = join(home, 'config.toml')
  try {
    await stat(cfgPath)
    await copyFile(cfgPath, `${cfgPath}.bak-csm-${Date.now()}`)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  await writeFile(cfgPath, text)
}

/** 安装插件到本地 marketplace 并登记 config.toml。 */
export async function installPlugin({ home = codexHome(), pluginDir = HERE } = {}) {
  const marketDir = join(home, 'marketplaces', MARKET_NAME)
  const dest = join(marketDir, 'plugins', PLUGIN_NAME)
  await rm(dest, { recursive: true, force: true })
  await cp(pluginDir, dest, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes(`${join('tests', '')}`),
  })
  // .mcp.json 物化：MCP server 从仓库目录运行（保证 @csm/core 与 sdk 依赖可解析）
  const mcp = {
    mcpServers: {
      session_manager: {
        command: process.execPath,
        args: [join(pluginDir, 'server.mjs')],
        cwd: pluginDir,
        default_tools_approval_mode: 'approve',
        tools: {
          rename_session: { approval_mode: 'prompt' },
          archive_session: { approval_mode: 'prompt' },
          delete_session: { approval_mode: 'prompt' },
        },
      },
    },
  }
  await writeFile(join(dest, '.mcp.json'), JSON.stringify(mcp, null, 2) + '\n')
  // marketplace 清单
  await mkdir(join(marketDir, '.agents', 'plugins'), { recursive: true })
  await writeFile(join(marketDir, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
    name: MARKET_NAME,
    interface: { displayName: 'CSM Local' },
    plugins: [{
      name: PLUGIN_NAME,
      source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    }],
  }, null, 2) + '\n')
  // config.toml 登记
  let cfg = await readConfig(home)
  cfg = upsertTomlSection(cfg, `[marketplaces.${MARKET_NAME}]`, ['source_type = "local"', `source = ${JSON.stringify(marketDir)}`])
  cfg = upsertTomlSection(cfg, `[plugins."${PLUGIN_NAME}@${MARKET_NAME}"]`, ['enabled = true'])
  await writeConfigWithBackup(home, cfg)
  return { marketDir, configPath: join(home, 'config.toml') }
}

/** 卸载：移除 config 条目与市场目录（仓库本身不动）。 */
export async function uninstallPlugin({ home = codexHome() } = {}) {
  let cfg = await readConfig(home)
  cfg = removeTomlSection(cfg, `[plugins."${PLUGIN_NAME}@${MARKET_NAME}"]`)
  cfg = removeTomlSection(cfg, `[marketplaces.${MARKET_NAME}]`)
  await writeConfigWithBackup(home, cfg)
  await rm(join(home, 'marketplaces', MARKET_NAME), { recursive: true, force: true })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const uninstall = process.argv.includes('--uninstall')
  const r = uninstall ? await uninstallPlugin() : await installPlugin()
  console.log(uninstall
    ? '已卸载 session-manager 插件（config.toml 已备份，市场目录已移除）。重启 Codex Desktop 生效。'
    : `已安装 session-manager 插件 → ${r.marketDir}\nconfig.toml 已更新并备份。重启 Codex Desktop 后在插件列表启用即可。`)
}
```

**Step 4: 跑测试确认通过**

Run: `node --test packages/plugin/tests/install.test.js`
Expected: PASS（4 tests）

> 控制器已实证 Step 3 的 `cp` filter 正确（详见本节末「Task 12 控制器预审修订」核验 1）：`node_modules/` 与 `tests/` 整棵子树被排除、其余文件全保留，故本步应直接 PASS、**无需调整 filter**。若意外 FAIL，**STOP 并附证据上报**（勿擅自改 filter 或计划）。测试核心断言：marketplace.json 与 plugin.json 被复制入市场、.mcp.json 物化内容（cwd=仓库 pluginDir、args 末位 server.mjs）、config.toml 变更（两节新增 + 原配置保留 + 备份创建 + 幂等不重复）。

**Step 5: Commit**

```bash
git add packages/plugin/install.mjs packages/plugin/tests/install.test.js
git commit -m "feat(plugin): 本地 marketplace 安装/卸载脚本（config.toml 安全 upsert + 备份）"
```

> **Task 12 控制器预审修订（2026-09-27，控制器派发前实证：cp filter 语义、cp 父目录自动创建、TOML 正则 LF/CRLF/边界、CLI is-main 守卫；发现 1 处占位测试断言并强化——install.mjs 本体经实证正确、无需改；amendments 以 docs(plan) 单独提交后再派 implementer）**
>
> **修订 1 — install.test.js 备份断言强化（占位 bug 修正）**：原测试「备份」断言为 `const backups = (await readFile(join(home,'config.toml'),'utf8')).length; assert.ok(backups > 0)`——这是**占位/错误**：它读 config.toml 的字节长度、变量却命名「backups」、断言 >0（恒真），**根本没验证备份文件是否创建**，与测试名「…+ 备份 + 幂等」不符。已强化为 `const bakFiles = (await readdir(home)).filter(f=>f.startsWith('config.toml.bak-csm-')); assert.ok(bakFiles.length >= 1, 'config.toml 修改前已备份')`，真正覆盖「修改 config.toml 前先备份」这一安全特性；测试 import 相应加 `readdir`。**install.mjs 无需改**（writeConfigWithBackup 已正确 `copyFile` 到 `config.toml.bak-csm-<ts>`，现被测试真实验证）。
> **核验 1 — `cp` filter + cp/rm 行为（Step 3，实证正确、无需改）**：探针（临时树含 node_modules/tests/src/.codex-plugin/server.mjs/.mcp.json）证实 filter `(src)=>!src.includes('node_modules') && !src.includes(join('tests',''))` 正确排除 `node_modules/` 与 `tests/` 整棵子树、保留其余全部文件。注意 `join('tests','')==='tests'`（**非 'tests/'**；path.join 对空段丢弃尾分隔符、只剩 'tests'），故 `.includes('tests')` 偏宽——但插件目录里唯一含 'tests' 子串的路径就是 tests/ 目录（server.mjs/install.mjs/package.json/.codex-plugin/.mcp.json/skills/src/tools.js 均不含 'tests'；'tools'≠'tests'），安全无误伤；偏宽恰好匹配 tests 目录**本身**（不只其内容），cp 对目录返回 false 即跳过整棵子树（不留空 tests/）。**补充探针**：`cp(src,dest,{recursive:true})` 会**自动创建 dest 的全部父目录**（首次安装 `home/marketplaces/csm/plugins/session-manager` 不存在 → cp 创建整棵树、无需先 mkdir）；`rm(dest,{recursive:true,force:true})` 对不存在的 dest 不报错（force 兜底），install.mjs「先 rm 再 cp」序列安全。**结论：复制逻辑 byte-exact、勿改**（原 Step 4 酌情 note 已改为「已验证 + 失败即 STOP」）。
> **核验 2 — TOML 正则（upsertTomlSection/removeTomlSection，健壮、无需改）**：探针复现计划两函数，测 LF/CRLF/幂等/相似前缀/中间节/节内注释/带引号 header：① LF 追加新节（csm 加入、desktop+openai-bundled 保留）；② LF 幂等（二次 upsert 同节原地替换、节数仍 1、旧值 /m 被 /m2 取代无残留）；③ 相似前缀（upsert `[marketplaces.csm]` 不动 `[marketplaces.csm-foo]`——escapeRe + `^…[ \t]*$` 锚定完整 header 行）；④ **CRLF 二次 upsert 节数仍=1（无重复追加 bug**——首次对 CRLF 文件追加 LF 节、二次找到该 LF 节原地替换）；⑤ remove 中间节（删 [desktop] 连带其 localeOverride、保留 openai-bundled）；⑥ 节内注释连带删（remove [a] 连节内 # cmt 一并删）；⑦ 带引号 header `[plugins."session-manager@csm"]` 删净（escapeRe 对引号/@ 处理正确）。**全部通过，TOML 逻辑勿改**。
> **核验 3 — CLI is-main 守卫（line 3855，npm run 生效、无需改）**：`fileURLToPath(import.meta.url)===process.argv[1]` 实证：**相对路径调用（`node sub/install.mjs`，即 `npm run install:plugin` 的方式）→ Node 把 argv[1] 解析为真实绝对路径、与 import.meta.url 一致、守卫触发 ✓**；npm run 场景同样触发 ✓。仅「绝对路径调用且路径经 symlink」（如 `node /tmp/…`，/tmp→/private/tmp）会因 argv[1] 保留未解析而守卫失败——但真实仓库路径无 symlink 组件、Task 13 走 npm run（相对），非真实路径（信息性记录）。
>
> **信息性（记录，不改）**：① `writeConfigWithBackup` 备份名仅 `Date.now()`（无随机后缀），同毫秒内两次写会碰撞致第二个备份覆盖第一个（对比 core mutate.js 用 `<ts>-<rand>/`）——真实安装单次运行不会触发，Task 13 可视需要加随机后缀；② TOML 正则假定「节头是行首未缩进 `[`、多行数组值缩进」（标准 TOML 风格），Codex config.toml 符合，Task 13 真实安装验证；③ `join('tests','')==='tests'` 写法略反直觉（作者本意或为 'tests/'），功能如上正确；④ marketplace.json/plugin.json 为 Codex marketplace schema、**暂定**（`PluginMcpServerConfig`/`default_tools_approval_mode` 已确认是真实 Codex 字段；marketplace 清单结构待 Task 13 真实安装核验）。
> **依赖/契约已核实**：`cp`/`rm`/`copyFile`/`mkdir`/`readFile`/`readdir`/`stat`/`writeFile` 均在 node:fs/promises（cp 需 Node≥16.7、rm≥14.14，本仓 engines≥22）；`codexHome` 由 @csm/core barrel 导出；测试 import `makeHome` 自 core fixture（临时 home，绝不碰真实 ~/.codex）；install.test.js 的 4 测试与既有 tools.test.js 4 测试并存，**全套测试 70 → 74**。

---

### Task 13: 收尾 — README、全量测试、真实安装、推送

**Files:**
- Modify: `README.md`

**Step 1: 全量测试**

Run: `cd /Users/xuxianxian/Documents/test/codex-session-manager && npm test`
Expected: 三个包全部 PASS，0 fail

**Step 2: 写完整 README.md**

```markdown
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
npm run install:plugin  # 安装 Codex 插件（自动备份 config.toml），重启 Codex Desktop
npm run uninstall:plugin
```

## 安全设计
- 只监听 127.0.0.1 + 随机 bearer token
- 所有写操作先备份到 `~/.codex/.csm-backups/`
- 删除 = 移入回收站，绝不物理删除；归档 = 移入官方归档目录
- 30 秒内活跃写入的会话默认拒绝变更（`force` 可越过）
- 读后写前 mtime 校验（冲突返回 409）

## 结构
`packages/core`（数据读写）· `packages/web`（面板）· `packages/plugin`（Codex 插件）
设计文档与实施计划见 `docs/plans/`。
```

**Step 3: 真实安装插件（作用于真实 ~/.codex，config 自动备份）**

Run: `npm run install:plugin`
Expected: 打印「已安装 … → /Users/xuxianxian/.codex/marketplaces/csm」

Run: `grep -A2 'marketplaces.csm' ~/.codex/config.toml && grep -A1 'session-manager@csm' ~/.codex/config.toml`
Expected: 能看到两个新节；`ls ~/.codex/config.toml.bak-csm-*` 有备份文件

**Step 4: 手动验收（重启 Codex Desktop 后）**
- [ ] Desktop 插件列表出现 Session Manager，可启用
- [ ] 对话里说「列出我最近的会话」→ 模型调用 list_sessions 返回真实列表
- [ ] 对话里重命名一个测试会话 → Web 面板刷新可见新标题
- [ ] Web 面板上对一个**测试**会话执行归档、删除 → 文件分别出现在 `~/.codex/archived_sessions/` 与 `~/.codex/.csm-trash/`，且 `.csm-backups/` 有备份

**Step 5: 最终提交并推送**

```bash
git add -A
git commit -m "docs: 完善 README；CSM v0.1.0 完成"
git push
```
Expected: 推送到 `LanguidAI/codex-session-manager`（走 ssh.github.com:443，勿改 HTTPS）

---

## 验收标准（整体）

1. `npm test` 全绿（core 22+ / web 4 / plugin 7）
2. Web 面板对真实 `~/.codex` 只读浏览正常；写操作只在用户确认的测试会话上验证
3. Codex Desktop 中插件可启用，6 个工具全部可用，写操作触发 approval prompt
4. 任何写操作后 `~/.codex/.csm-backups/` 都能找到对应备份；无文件被物理删除
5. 远端仓库 `LanguidAI/codex-session-manager`（私有）包含全部代码与文档

## 明确不做（YAGNI，与设计文档一致）

- 不做自动 resume（复制粘贴上下文即可）
- 不做全文倒排索引（顺序 fastMeta 过滤够用）
- 不做多用户/远程部署
- 不做物理删除与回收站 UI（回收站文件可手动恢复）
