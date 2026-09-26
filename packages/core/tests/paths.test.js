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
