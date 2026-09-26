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
