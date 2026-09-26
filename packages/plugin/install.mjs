#!/usr/bin/env node
/**
 * 把 session-manager 插件安装为 Codex 本地 marketplace 插件：
 * 1) 复制插件到 $CODEX_HOME/marketplaces/csm/plugins/session-manager（.mcp.json 用仓库绝对路径物化）
 * 2) 备份并更新 $CODEX_HOME/config.toml（[marketplaces.csm] + [plugins."session-manager@csm"]）
 * --uninstall 反向移除。
 */
import { realpathSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexHome } from '@csm/core'

const MARKET_NAME = 'csm'
const PLUGIN_NAME = 'session-manager'
const HERE = dirname(fileURLToPath(import.meta.url))

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 不抛错的 realpath（is-main 守卫用：argv[1] 异常时退回原值，避免 import 期崩溃）。 */
function safeRealpath(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** 在 TOML 文本中插入或原地替换一个节（节内容到下一个 [ 或文件尾为止）。header 行允许尾随注释。 */
export function upsertTomlSection(text, header, lines) {
  const block = [header, ...lines].join('\n')
  const re = new RegExp(`^${escapeRe(header)}[ \\t]*(?:#.*)?$`, 'm')
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

/** 从 TOML 文本中删除一个节（含其键值行）。header 行允许尾随注释。 */
export function removeTomlSection(text, header) {
  const re = new RegExp(`^${escapeRe(header)}[ \\t]*(?:#.*)?$`, 'm')
  const m = re.exec(text)
  if (!m) return text
  const afterHeader = m.index + m[0].length
  const rest = text.slice(afterHeader)
  const next = rest.search(/^\[/m)
  const end = next === -1 ? text.length : afterHeader + next
  return `${text.slice(0, m.index)}${text.slice(end).replace(/^\n+/, '')}`
}

/** 写前自检：构造出的 config 不得含重复节 header（正则 TOML 编辑的安全网，拒绝写坏配置）。 */
function assertNoDuplicateSections(text) {
  for (const header of [`[marketplaces.${MARKET_NAME}]`, `[plugins."${PLUGIN_NAME}@${MARKET_NAME}"]`]) {
    const found = text.match(new RegExp(`^${escapeRe(header)}`, 'gm'))
    if (found && found.length > 1) {
      throw new Error(`config.toml self-check: duplicate section ${header} (${found.length}x), refusing to write (original config unchanged)`)
    }
  }
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
    // 段级匹配：仅当 node_modules/tests 作为 relative(pluginDir) 路径的完整一段时排除
    // （避免子串误伤：如 pluginDir 路径本身含 "tests"、或 mytests.js 这类合法文件）
    filter: (src) => {
      const segs = relative(pluginDir, src).split(sep)
      return !segs.includes('node_modules') && !segs.includes('tests')
    },
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
  assertNoDuplicateSections(cfg) // 写前自检：发现重复节即拒绝写入（保护用户 config）
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

if (process.argv[1] && safeRealpath(fileURLToPath(import.meta.url)) === safeRealpath(process.argv[1])) {
  const uninstall = process.argv.includes('--uninstall')
  const r = uninstall ? await uninstallPlugin() : await installPlugin()
  console.log(uninstall
    ? '已卸载 session-manager 插件（config.toml 已备份，市场目录已移除）。重启 Codex Desktop 生效。'
    : `已安装 session-manager 插件 → ${r.marketDir}\nconfig.toml 已更新（原文件存在时已备份）。重启 Codex Desktop 后在插件列表启用即可。`)
}
