import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// #14：get_session 的体积描述必须反映实测值，避免模型低估上下文风险。
// 实测依据（真实语料，最大会话）：
//   rollout 文件 1030.1MB，但 get_session 载荷（messages 全文 + 元数据）= 1.83MB
//   （文件中的 base_instructions 等超大字段不进载荷，故不可用文件大小当描述值）
//   另有 269.3MB→1.14MB、180.9MB→0.35MB 两例佐证。
const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = readFileSync(join(PLUGIN, 'server.mjs'), 'utf8')
const SKILL = readFileSync(join(PLUGIN, 'skills', 'session-manager', 'SKILL.md'), 'utf8')

test('#14 get_session 描述不再低估体积（旧值 0.7MB → 实测 1.8MB）', () => {
  assert.doesNotMatch(SERVER, /0\.7MB/, 'server.mjs 描述仍含过时的 0.7MB')
  assert.match(SERVER, /1\.8MB/, 'server.mjs 应更新为实测 ~1.8MB')
})

test('#14 SKILL.md 体积描述与 server.mjs 保持一致', () => {
  assert.doesNotMatch(SKILL, /0\.7MB/, 'SKILL.md 仍含过时的 0.7MB')
  assert.match(SKILL, /1\.8MB/, 'SKILL.md 应更新为实测 ~1.8MB')
})