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
- Test: `packages/core/tests/mutate.test.js`

**Step 1: 写失败测试** `packages/core/tests/mutate.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
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

test('rename: 未知 id → not_found；空标题 → invalid', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'a', day: '2026-05-20' })
  await assert.rejects(() => renameSession({ home, id: 'nope', title: 'x' }), (e) => e.code === 'not_found')
  await assert.rejects(() => renameSession({ home, id: 'a', title: '   ' }), (e) => e.code === 'invalid')
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
  await writeSession(home, { id: 'fresh', day: '2026-05-20' }) // mtime = now
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
```

**Step 2: 跑测试确认失败**

Run: `node --test packages/core/tests/mutate.test.js`
Expected: FAIL，`Cannot find module '.../src/mutate.js'`

**Step 3: 实现** `packages/core/src/mutate.js`

```js
import { appendFile, copyFile, mkdir, rename as fsRename, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { findSessionFile } from './catalog.js'
import { CsmError } from './errors.js'
import { layout } from './paths.js'

/** 距上次写入不足该窗口的会话视为“正在使用”，默认拒绝变更。 */
const ACTIVE_WINDOW_MS = 30_000

/** 把文件备份到 .csm-backups/<时间戳>/ 下，返回备份路径。 */
async function backupFile(home, filePath) {
  const dir = join(layout(home).backupsDir, new Date().toISOString().replace(/[:.]/g, '-'))
  await mkdir(dir, { recursive: true })
  const dest = join(dir, basename(filePath))
  await copyFile(filePath, dest)
  return dest
}

/** 移动前防护：mtime 与读取时不符 → conflict；30s 内活跃写入 → active（force 越过）。 */
async function guardMovable(filePath, { force, expectedMtimeMs } = {}) {
  const st = await stat(filePath)
  if (expectedMtimeMs !== undefined && st.mtimeMs !== expectedMtimeMs) {
    throw new CsmError('conflict', `session file changed since read (expected mtime ${expectedMtimeMs}, got ${st.mtimeMs})`)
  }
  const age = Date.now() - st.mtimeMs
  if (!force && age >= 0 && age < ACTIVE_WINDOW_MS) {
    throw new CsmError('active', `会话 ${Math.round(age / 1000)} 秒前仍在写入，可能正被 Codex 使用；确认后可用 force=true 强制`)
  }
  return st
}

/** 重命名：向 session_index.jsonl 追加新行（后行生效语义），追加前备份索引。 */
export async function renameSession({ home, id, title }) {
  const t = typeof title === 'string' ? title.trim() : ''
  if (!t) throw new CsmError('invalid', 'title is required')
  const found = await findSessionFile(home, id)
  if (!found) throw new CsmError('not_found', `session ${id} not found`)
  const l = layout(home)
  try {
    await stat(l.index)
    await backupFile(home, l.index)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  await appendFile(l.index, JSON.stringify({ id, thread_name: t, updated_at: new Date().toISOString() }) + '\n')
  return { id, title: t }
}

/** 归档：移入官方 archived_sessions/（与 Desktop 行为一致），先备份。 */
export async function archiveSession({ home, id, force, expectedMtimeMs }) {
  const l = layout(home)
  const found = await findSessionFile(home, id)
  if (!found) throw new CsmError('not_found', `session ${id} not found`)
  if (found.location !== 'active') throw new CsmError('invalid', `session is already ${found.location}`)
  await guardMovable(found.path, { force, expectedMtimeMs })
  await backupFile(home, found.path)
  await mkdir(l.archivedDir, { recursive: true })
  const dest = join(l.archivedDir, basename(found.path))
  await fsRename(found.path, dest)
  return { id, location: 'archived', path: dest }
}

/** 删除：软删除，移入 .csm-trash/（绝不物理删除），先备份。 */
export async function deleteSession({ home, id, force, expectedMtimeMs }) {
  const l = layout(home)
  const found = await findSessionFile(home, id)
  if (!found) throw new CsmError('not_found', `session ${id} not found`)
  if (found.location === 'trash') throw new CsmError('invalid', 'session is already in trash')
  await guardMovable(found.path, { force, expectedMtimeMs })
  await backupFile(home, found.path)
  await mkdir(l.trashDir, { recursive: true })
  const dest = join(l.trashDir, basename(found.path))
  await fsRename(found.path, dest)
  return { id, location: 'trash', path: dest }
}
```

**Step 4: 跑测试确认通过**

Run: `node --test packages/core/tests/mutate.test.js`
Expected: PASS（6 tests）

**Step 5: Commit**

```bash
git add packages/core/src/mutate.js packages/core/tests/mutate.test.js
git commit -m "feat(core): 重命名/归档/软删除（备份 + 活跃防护 + 冲突检测）"
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

test('toMarkdown: 含元信息头、用户/助手消息、工具统计', () => {
  const md = toMarkdown(sample())
  assert.ok(md.includes('# 测试会话'))
  assert.ok(md.includes('`sid-1`'))
  assert.ok(md.includes('/proj/alpha'))
  assert.ok(md.includes('目标A'))
  assert.ok(md.includes('完成A'))
  assert.ok(md.includes('exec_command'))
})

test('renderExport: json 可 round-trip；未知格式抛 invalid', () => {
  const s = sample()
  const back = JSON.parse(renderExport(s, 'json'))
  assert.equal(back.id, 'sid-1')
  assert.equal(back.messages.length, s.messages.length)
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
```

**Step 4: 跑测试确认通过**

Run: `node --test packages/core/tests/export.test.js`
Expected: PASS（3 tests）

**Step 5: Commit**

```bash
git add packages/core/src/export.js packages/core/tests/export.test.js
git commit -m "feat(core): MD/JSON 导出与恢复上下文生成"
```

---

### Task 7: core — stats + index 汇总出口

**Files:**
- Create: `packages/core/src/stats.js`、`packages/core/src/index.js`
- Test: `packages/core/tests/stats.test.js`

**Step 1: 写失败测试** `packages/core/tests/stats.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStats } from '../src/stats.js'
import { makeHome, writeIndex, writeSession } from './helpers/fixture.js'

test('buildStats: 按天/项目/模型/供应商聚合', async () => {
  const home = await makeHome()
  await writeSession(home, { id: 'a', day: '2026-05-20', cwd: '/p1', model: 'gpt-5.5' })
  await writeSession(home, { id: 'b', day: '2026-05-20', cwd: '/p1', model: 'gpt-5.6' })
  await writeSession(home, { id: 'c', day: '2026-05-21', cwd: '/p2', model: 'gpt-5.5' })
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
```

**Step 2: 跑测试确认失败**

Run: `node --test packages/core/tests/stats.test.js`
Expected: FAIL，`Cannot find module '.../src/stats.js'`

**Step 3: 实现**

`packages/core/src/stats.js`:
```js
import { listSessions } from './catalog.js'

/** 汇总统计（纯只读）：总数/归档数/近7天 + 按天/项目/模型/供应商分布。 */
export async function buildStats({ home }) {
  const all = await listSessions({ home, includeArchived: true })
  const active = all.filter((s) => !s.archived)
  const byDay = {}
  const byProject = {}
  const byModel = {}
  const byProvider = {}
  const bump = (obj, key) => {
    if (key) obj[key] = (obj[key] ?? 0) + 1
  }
  for (const s of active) {
    bump(byDay, (s.updatedAt ?? '').slice(0, 10))
    bump(byProject, s.cwd)
    bump(byModel, s.model)
    bump(byProvider, s.provider)
  }
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  return {
    total: active.length,
    archived: all.length - active.length,
    recent7: active.filter((s) => (s.updatedAt ?? '') >= weekAgo).length,
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
Expected: PASS（25 tests：paths 6 + reader 3 + catalog 6 + mutate 6 + export 3 + stats 1，允许总数略有出入但必须全绿）

Run: `node -e "import('@csm/core').then(m => console.log(Object.keys(m).length + ' exports'))"`
Expected: 输出 exports 数量 ≥ 15（验证 workspace 链接与汇总出口）

**Step 5: Commit**

```bash
git add packages/core/src/stats.js packages/core/src/index.js packages/core/tests/stats.test.js
git commit -m "feat(core): 统计聚合与包出口，core 完成"
```

---

### Task 8: web — REST 服务

**Files:**
- Create: `packages/web/server.mjs`
- Test: `packages/web/tests/api.test.js`

**Step 1: 写失败测试** `packages/web/tests/api.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
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
import { extname, join, normalize, sep } from 'node:path'
import { dirname, fileURLToPath, pathToFileURL } from 'node:url'
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

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } })
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 创建面板 HTTP 服务（不监听）。home 缺省用 CODEX_HOME；token 缺省随机生成。 */
export function createApp({ home, token } = {}) {
  const H = home ?? core.codexHome()
  const T = token ?? process.env.CSM_TOKEN ?? randomBytes(16).toString('hex')

  async function loadFull(id) {
    const found = await core.findSessionFile(H, id)
    if (!found) return null
    const session = await core.readSessionFile(found.path)
    const index = await core.readIndex(H)
    session.title = index.get(id)?.title ?? session.id
    session.archived = found.location !== 'active'
    session.mtimeMs = found.mtimeMs
    return session
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
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
          const id = decodeURIComponent(m[1])
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
            res.writeHead(200, {
              'content-type': fmt === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
              'content-disposition': `attachment; filename="${id}.${fmt}"`,
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
            return sendJson(res, 200, await core.renameSession({ home: H, id, title: body.title }))
          }
          if (req.method === 'POST' && sub === '/archive') {
            return sendJson(res, 200, await core.archiveSession({ home: H, id, force: body.force }))
          }
          if (req.method === 'POST' && sub === '/delete') {
            return sendJson(res, 200, await core.deleteSession({ home: H, id, force: body.force }))
          }
        }
        return sendError(res, 404, 'not_found', `no route ${req.method} ${url.pathname}`)
      }

      // 静态文件（含路径穿越防护）
      const p = normalize(join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname))
      if (p !== PUBLIC_DIR && !p.startsWith(PUBLIC_DIR + sep)) return sendError(res, 403, 'invalid', 'forbidden')
      const content = await readFile(p)
      res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' })
      return res.end(content)
    } catch (err) {
      const status = STATUS_BY_CODE[err?.code] ?? 500
      return sendError(res, status, err?.code ?? 'internal', String(err?.message ?? err))
    }
  })
  return { server, token: T, home: H }
}

// 直接运行时启动面板
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, token } = createApp()
  const port = Number(process.env.CSM_PORT ?? 4173)
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
Expected: PASS（4 tests）

**Step 5: Commit**

```bash
git add packages/web/server.mjs packages/web/public/index.html packages/web/tests/api.test.js
git commit -m "feat(web): REST API 服务（bearer 鉴权、错误映射、静态托管、穿越防护）"
```

---

### Task 9: web — 前端面板（原生 HTML/CSS/JS）

**Files:**
- Modify: `packages/web/public/index.html`（替换占位）
- Create: `packages/web/public/app.js`、`packages/web/public/style.css`

> 前端无自动化测试（无构建、无框架）；用 Step 5 的手动验证清单代替。UI 文案用中文。

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
const token = sessionStorage.getItem('csm-token') ?? params.get('token')
if (params.get('token')) sessionStorage.setItem('csm-token', params.get('token'))

const $ = (sel) => document.querySelector(sel)
const state = { sessions: [], selected: null, view: 'sessions' }

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
const fmtTime = (iso) => (iso ? iso.replace('T', ' ').slice(0, 16) : '?')
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)

async function loadList() {
  const q = new URLSearchParams()
  if ($('#q').value) q.set('q', $('#q').value)
  if ($('#cwd').value) q.set('cwd', $('#cwd').value)
  if ($('#model').value) q.set('model', $('#model').value)
  if ($('#archived').checked) q.set('archived', '1')
  const { sessions } = await api(`/api/sessions?${q}`)
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
  // 填充模型下拉（保留当前选择）
  const models = [...new Set(sessions.map((s) => s.model).filter(Boolean))]
  const sel = $('#model')
  const cur = sel.value
  sel.innerHTML = '<option value="">全部模型</option>' + models.map((m) => `<option ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('')
}

async function selectSession(id) {
  state.selected = id
  document.querySelectorAll('#list li').forEach((li) => li.classList.toggle('sel', li.dataset.id === id))
  const { session: s } = await api(`/api/sessions/${encodeURIComponent(id)}`)
  $('#detail').innerHTML = `
    <h2>${esc(s.title)}</h2>
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
      await loadList()
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
      await api(`/api/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST', body: '{}' })
      toast('已归档')
      state.selected = null
      $('#detail').innerHTML = '<p class="empty">选择左侧会话查看详情</p>'
      await loadList()
    } else if (act === 'delete') {
      if (!confirm('删除该会话？（软删除：移入 .csm-trash 并先备份，不会物理删除）')) return
      await api(`/api/sessions/${encodeURIComponent(id)}/delete`, { method: 'POST', body: '{}' })
      toast('已移入回收站')
      state.selected = null
      $('#detail').innerHTML = '<p class="empty">选择左侧会话查看详情</p>'
      await loadList()
    }
  } catch (e) {
    toast(e.code === 'active' ? '会话正被 Codex 使用中，稍后再试' : `失败：${e.message}`, true)
  }
})

$('#list').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-id]')
  if (li) selectSession(li.dataset.id).catch((e) => toast(e.message, true))
})

let debounce
for (const sel of ['#q', '#cwd', '#model', '#archived']) {
  $(sel).addEventListener(sel === '#model' || sel === '#archived' ? 'change' : 'input', () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => loadList().catch((e) => toast(e.message, true)), 250)
  })
}

async function loadStats() {
  const s = await api('/api/stats')
  const rows = (obj, limit = 10) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, limit)
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
      <div class="box"><h3>按日期（最近 14 天）</h3>${rows(s.byDay, 14)}</div>
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
  loadList().catch((e) => toast(e.message, true))
}
```

**Step 4: 跑 web 测试回归**

Run: `node --test packages/web/tests/api.test.js`
Expected: PASS（静态页测试现在验证的是完整 index.html，仍应通过）

**Step 5: 手动验证（真实数据只读操作）**

Run: `cd /Users/xuxianxian/Documents/test/codex-session-manager && (CODEX_HOME=$HOME/.codex node packages/web/server.mjs &); sleep 1`
然后从 stdout 拿 `http://127.0.0.1:4173/?token=...` 用浏览器打开，核对清单：
- [ ] 会话列表显示真实会话（标题/时间/项目/模型）
- [ ] 搜索关键字能过滤
- [ ] 点开详情能看到消息流
- [ ] 「复制恢复上下文」提示成功，粘贴可见 Markdown
- [ ] 「导出 MD」下载的文件内容正确
- [ ] 统计页数字与列表总数一致
- [ ] ⚠️ 本步骤**不要**在真实数据上点归档/删除（那些留给验收阶段用测试会话验证）
验证完 `kill %1` 关掉服务。

**Step 6: Commit**

```bash
git add packages/web/public/
git commit -m "feat(web): 会话面板前端（列表/搜索/详情/统计/操作按钮，原生无构建）"
```

---

### Task 10: plugin — MCP 工具逻辑（与传输层解耦）

**Files:**
- Create: `packages/plugin/src/tools.js`
- Test: `packages/plugin/tests/tools.test.js`

> 设计要点：工具逻辑写成普通 async 函数（`createSessionTools`），`server.mjs` 只做 MCP 接线。测试直接调函数，不经 stdio。

**Step 1: 写失败测试** `packages/plugin/tests/tools.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
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
  assert.deepEqual(detail.toolCallCounts, { exec_command: 1 })
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
})
```

**Step 2: 跑测试确认失败**

Run: `node --test packages/plugin/tests/tools.test.js`
Expected: FAIL，`Cannot find module '.../src/tools.js'`

**Step 3: 实现** `packages/plugin/src/tools.js`

```js
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import * as core from '@csm/core'

function countBy(arr) {
  const o = {}
  for (const x of arr) o[x] = (o[x] ?? 0) + 1
  return o
}

/** 创建 6 个 MCP 工具的实现函数（home 缺省用 CODEX_HOME）。 */
export function createSessionTools({ home } = {}) {
  const H = home ?? core.codexHome()

  async function load(id) {
    const found = await core.findSessionFile(H, id)
    if (!found) throw new core.CsmError('not_found', `session ${id} not found`)
    const session = await core.readSessionFile(found.path)
    const index = await core.readIndex(H)
    session.title = index.get(id)?.title ?? session.id
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
    async get_session({ id }) {
      const s = await load(id)
      return {
        id: s.id, title: s.title, cwd: s.cwd, model: s.model, provider: s.provider,
        createdAt: s.createdAt, updatedAt: s.updatedAt, tokens: s.tokens, archived: s.archived,
        messages: s.messages, toolCallCounts: countBy(s.toolCalls),
      }
    },
    async rename_session({ id, title }) {
      return core.renameSession({ home: H, id, title })
    },
    async archive_session({ id, force }) {
      return core.archiveSession({ home: H, id, force })
    },
    async delete_session({ id, force }) {
      return core.deleteSession({ home: H, id, force })
    },
    async export_session({ id, format = 'md', outputPath } = {}) {
      const s = await load(id)
      const text = core.renderExport(s, format)
      // anchor 保证 outputPath 只能落在 CODEX_HOME 内：相对路径解析进 home，home 外绝对路径抛 invalid
      const dest = core.anchor(H, outputPath ?? join(H, 'exports', `${id}.${format}`))
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, text)
      return { path: dest, bytes: Buffer.byteLength(text) }
    },
  }
}
```

**Step 4: 跑测试确认通过**

Run: `node --test packages/plugin/tests/tools.test.js`
Expected: PASS（3 tests）

**Step 5: Commit**

```bash
git add packages/plugin/src/tools.js packages/plugin/tests/tools.test.js
git commit -m "feat(plugin): 会话管理 MCP 工具逻辑（list/get/rename/archive/delete/export）"
```

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

server.tool('list_sessions', '列出/搜索 Codex 历史会话（id、标题、项目、模型、时间）。', {
  query: z.string().optional().describe('关键字（标题/ID/目录）'),
  cwd: z.string().optional().describe('项目目录过滤（包含匹配）'),
  model: z.string().optional().describe('模型过滤（精确匹配）'),
}, wrap(tools.list_sessions))

server.tool('get_session', '读取一个会话的完整内容（消息流、工具调用统计、tokens）。', {
  id: z.string().describe('会话 ID'),
}, wrap(tools.get_session))

server.tool('rename_session', '重命名会话（更新标题索引，自动备份，不移动会话文件）。', {
  id: z.string(), title: z.string().describe('新标题'),
}, wrap(tools.rename_session))

server.tool('archive_session', '归档会话：移入官方 archived_sessions/ 目录（可逆，自动备份）。', {
  id: z.string(), force: z.boolean().optional().describe('会话 30 秒内仍被写入时强制'),
}, wrap(tools.archive_session))

server.tool('delete_session', '删除会话（软删除：先备份，再移入 .csm-trash/，不物理删除）。', {
  id: z.string(), force: z.boolean().optional(),
}, wrap(tools.delete_session))

server.tool('export_session', '导出会话为 Markdown 或 JSON 文件，返回文件路径。', {
  id: z.string(),
  format: z.enum(['md', 'json']).optional().describe('默认 md'),
  outputPath: z.string().optional().describe('绝对路径；缺省写到 CODEX_HOME/exports/'),
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
```

**Step 5: 冒烟验证 MCP server 能启动**

Run: `cd /Users/xuxianxian/Documents/test/codex-session-manager && echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | CODEX_HOME=/tmp/csm-smoke node packages/plugin/server.mjs 2>/dev/null | head -c 300`
Expected: 输出一段 JSON-RPC 响应（含 `"serverInfo"` 与 `session-manager`），进程正常退出

**Step 6: Commit**

```bash
git add packages/plugin/server.mjs packages/plugin/.codex-plugin packages/plugin/.mcp.json packages/plugin/skills
git commit -m "feat(plugin): MCP server 接线、插件清单与 session-manager SKILL.md"
```

---

### Task 12: plugin — 本地安装脚本（marketplace + config.toml）

**Files:**
- Create: `packages/plugin/install.mjs`
- Test: `packages/plugin/tests/install.test.js`

**Step 1: 写失败测试** `packages/plugin/tests/install.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
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
  const backups = (await readFile(join(home, 'config.toml'), 'utf8')).length
  assert.ok(backups > 0)
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

> 若 `cp` 的 filter 行为与断言冲突（tests 目录被复制等），按测试期望调整 filter；核心断言是 marketplace.json、plugin.json、.mcp.json 物化内容与 config.toml 变更。

**Step 5: Commit**

```bash
git add packages/plugin/install.mjs packages/plugin/tests/install.test.js
git commit -m "feat(plugin): 本地 marketplace 安装/卸载脚本（config.toml 安全 upsert + 备份）"
```

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
