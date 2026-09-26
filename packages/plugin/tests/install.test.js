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
  await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true })
  await mkdir(join(dir, 'tests'), { recursive: true })
  await writeFile(join(dir, '.codex-plugin', 'plugin.json'), '{"name":"session-manager"}')
  await writeFile(join(dir, 'skills', 'session-manager', 'SKILL.md'), '---\nname: session-manager\n---\n')
  await writeFile(join(dir, 'server.mjs'), '// stub')
  await writeFile(join(dir, 'node_modules', 'dep', 'index.js'), '// dep')
  await writeFile(join(dir, 'tests', 'old.test.js'), '// old')
  await writeFile(join(dir, 'mytests.js'), '// 含 "tests" 子串但为合法根文件（cp filter 段级匹配的判别器）')
  return dir
}

const BASE_CONFIG = `model = "x"\n\n[desktop]\nlocaleOverride = "zh-CN"\n\n[marketplaces.openai-bundled]\nsource_type = "local"\nsource = "/some/where"\n`

test('upsertTomlSection: 追加新节 / 原地更新 / 不动其他节 / 尾随注释 / CRLF', () => {
  let t = upsertTomlSection(BASE_CONFIG, '[marketplaces.csm]', ['source_type = "local"', 'source = "/m"'])
  assert.ok(t.includes('[marketplaces.csm]'))
  assert.ok(t.includes('source = "/m"'))
  assert.ok(t.includes('[desktop]'), '原有节保留')
  assert.ok(t.includes('[marketplaces.openai-bundled]'), '原有市场节保留')
  const again = upsertTomlSection(t, '[marketplaces.csm]', ['source_type = "local"', 'source = "/m2"'])
  assert.equal(again.split('[marketplaces.csm]').length, 2, '不重复追加')
  assert.ok(again.includes('source = "/m2"'))
  assert.ok(!again.includes('source = "/m"\n'), '旧值被替换')
  // I1a：header 带尾随注释须被原地替换（旧正则不匹配 → 重复追加 → TOML 非法 "Cannot declare twice"）
  const commented = upsertTomlSection('[marketplaces.csm] # my market\nsource = "/old"\n', '[marketplaces.csm]', ['source = "/new"'])
  assert.equal(commented.split('[marketplaces.csm]').length, 2, '尾随注释 header：原地替换不重复')
  assert.ok(commented.includes('source = "/new"') && !commented.includes('source = "/old"'), '尾随注释 header：旧值被替换')
  // Info10：CRLF 配置二次 upsert 不得重复（ECMAScript m 标志 $ 匹配 \r 前）
  const crlf1 = upsertTomlSection(BASE_CONFIG.replace(/\n/g, '\r\n'), '[marketplaces.csm]', ['source = "/c"'])
  const crlf2 = upsertTomlSection(crlf1, '[marketplaces.csm]', ['source = "/c2"'])
  assert.equal(crlf2.split('[marketplaces.csm]').length, 2, 'CRLF：不重复')
})

test('removeTomlSection: 只删目标节 / 尾随注释 / CRLF', () => {
  const t = removeTomlSection(BASE_CONFIG, '[desktop]')
  assert.ok(!t.includes('[desktop]'))
  assert.ok(!t.includes('localeOverride'))
  assert.ok(t.includes('[marketplaces.openai-bundled]'))
  // I1a：header 带尾随注释须能正确删除
  const tc = removeTomlSection('[marketplaces.csm] # note\nsource = "/x"\n\n[desktop]\nk = 1\n', '[marketplaces.csm]')
  assert.ok(!tc.includes('[marketplaces.csm]') && !tc.includes('source = "/x"'), '尾随注释 header：节被删除')
  assert.ok(tc.includes('[desktop]'), '尾随注释 header：其他节保留')
  // Info10：CRLF 删除不留碎片
  const cr = removeTomlSection(BASE_CONFIG.replace(/\n/g, '\r\n'), '[desktop]')
  assert.ok(!cr.includes('[desktop]') && !cr.includes('localeOverride'), 'CRLF：节被删除')
  assert.ok(cr.includes('[marketplaces.openai-bundled]'), 'CRLF：其他节保留')
})

test('installPlugin: 市场目录 + 清单 + config 条目 + 备份 + cp过滤 + 幂等', async () => {
  const home = await makeHome()
  await writeFile(join(home, 'config.toml'), BASE_CONFIG)
  const pluginDir = await fakePluginDir()
  await installPlugin({ home, pluginDir })
  const market = join(home, 'marketplaces', 'csm')
  const dest = join(market, 'plugins', 'session-manager')
  // M5c：marketplace.json 可解析且结构正确（不只是 stat 存在）
  const mj = JSON.parse(await readFile(join(market, '.agents', 'plugins', 'marketplace.json'), 'utf8'))
  assert.equal(mj.name, 'csm')
  assert.equal(mj.plugins[0].name, 'session-manager')
  assert.equal(mj.plugins[0].source.source, 'local')
  await stat(join(dest, '.codex-plugin', 'plugin.json'))
  const mcp = JSON.parse(await readFile(join(dest, '.mcp.json'), 'utf8'))
  assert.equal(mcp.mcpServers.session_manager.cwd, pluginDir, 'MCP 指向仓库内 server（依赖解析可用）')
  assert.ok(mcp.mcpServers.session_manager.args[0].endsWith('server.mjs'))
  // I2 + M5a：cp filter 段级匹配——node_modules/tests 排除，含 "tests" 子串的合法文件（mytests.js）保留
  const copied = await readdir(dest)
  assert.ok(!copied.includes('node_modules'), 'cp filter：node_modules 未复制')
  assert.ok(!copied.includes('tests'), 'cp filter：tests 未复制')
  assert.ok(copied.includes('mytests.js'), 'cp filter：段级匹配不误伤 mytests.js（旧子串匹配会丢弃）')
  assert.ok(copied.includes('server.mjs'), 'cp filter：所需文件保留')
  // config.toml 条目
  const cfg = await readFile(join(home, 'config.toml'), 'utf8')
  assert.ok(cfg.includes('[marketplaces.csm]'))
  assert.ok(cfg.includes('[plugins."session-manager@csm"]'))
  assert.ok(cfg.includes('enabled = true'))
  assert.ok(cfg.includes('localeOverride'), '用户原配置未破坏')
  // M5b：备份存在且内容 == 安装前原配置（不只是查存在）
  const bakFiles = (await readdir(home)).filter((f) => f.startsWith('config.toml.bak-csm-'))
  assert.ok(bakFiles.length >= 1, 'config.toml 修改前已备份')
  assert.equal(await readFile(join(home, bakFiles[0]), 'utf8'), BASE_CONFIG, '备份内容 == 安装前原配置')
  // 幂等
  await installPlugin({ home, pluginDir })
  const cfg2 = await readFile(join(home, 'config.toml'), 'utf8')
  assert.equal(cfg2.split('[marketplaces.csm]').length, 2)
})

test('installPlugin 自检：重复节配置拒绝写入（保护用户 config 不被损坏）', async () => {
  const home = await makeHome()
  // 构造已含重复 [marketplaces.csm] 的配置（模拟正则编辑可能产生的损坏）
  await writeFile(join(home, 'config.toml'), '[marketplaces.csm]\na = 1\n[marketplaces.csm]\nb = 2\n')
  const pluginDir = await fakePluginDir()
  await assert.rejects(() => installPlugin({ home, pluginDir }), /self-check|duplicate|重复/i, '重复节触发自检，拒绝写入')
  // 自检在写入前触发 → 原 config 未被覆盖（仍是 2 个重复节 = split 长度 3）
  const cfg = await readFile(join(home, 'config.toml'), 'utf8')
  assert.equal(cfg.split('[marketplaces.csm]').length, 3, '原 config 未被改动')
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
