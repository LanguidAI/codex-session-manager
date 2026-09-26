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
