/** Memory bodies, project isolation and deletion guards are exercised with private disposable directories. */
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DublinMemoryStore, memoryDefaults } from '../src/dublin-memory-store.ts'
const owners: DublinMemoryStore[] = [], directories: string[] = []
afterEach(async () => {
  await Promise.allSettled(owners.splice(0).map(owner => owner.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, {
    force: true,
    recursive: true,
  })))
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dublin-memory-'))
  directories.push(directory)
  const owner = new DublinMemoryStore(join(directory, 'memory'))
  owners.push(owner)
  await owner.snapshot()
  return {
    owner,
    directory,
  }
}
const fact = { text: '先确认需求，再修改源码', kind: 'personal', status: 'active', project: null, source: null }
it('keeps manual memory local by default and restores canonical Markdown across restarts', async () => {
  const { owner, directory } = await fixture()
  const entry = await owner.put(fact)
  expect((await owner.snapshot()).settings).toEqual(memoryDefaults)
  expect(await readFile(join(directory, 'memory/MEMORY.md'), 'utf8')).toContain(fact.text)
  await owner.dispose()
  owners.splice(owners.indexOf(owner), 1)
  const reopened = new DublinMemoryStore(join(directory, 'memory'))
  owners.push(reopened)
  expect((await reopened.snapshot()).items[0]?.id).toBe(entry?.id)
  const path = join(directory, 'memory/entries', entry!.id + '.md')
  await writeFile(path, (await readFile(path, 'utf8')).replace(fact.text, '默认使用中文回答'))
  expect((await reopened.search('中文', null))[0]?.text).toBe('默认使用中文回答')
})
it('requires review for extracted preferences and isolates project and temporary-chat events', async () => {
  const { owner } = await fixture()
  await owner.put(fact)
  await owner.put({ ...fact, text: '旅行助手第一版不做分享', kind: 'project', project: '旅行助手' })
  await owner.put({ ...fact, text: '日记：旅行产品访谈', kind: 'event', project: '旅行助手' })
  await owner.put({ ...fact, text: '日记：私有临时讨论', kind: 'event', project: '@chat/private' })
  await owner.put({ ...fact, text: '喜欢所有封面简洁', status: 'active' }, true)
  const privateChat = await owner.search('日记', '@chat/private')
  expect(privateChat.some(x => x.text.includes('临时'))).toBe(true)
  expect(privateChat.some(x => x.project === '旅行助手')).toBe(false)
  expect((await owner.search('封面', '旅行助手')).some(x => x.status === 'pending')).toBe(false)
  const candidate = (await owner.snapshot()).items.find(x => x.status === 'pending')!
  await owner.put({
    ...candidate,
    status: 'active',
  })
  expect((await owner.search('封面', null)).some(x => x.id === candidate.id)).toBe(true)
  await owner.put({
    ...candidate,
    status: 'paused',
  })
  expect((await owner.search('封面', null)).some(x => x.id === candidate.id)).toBe(false)
})
it('blocks deleted facts and their source range even after an index rebuild', async () => {
  const { owner, directory } = await fixture()
  const source = { sessionId: 'demo-chat', title: '演示讨论', from: 2, through: 8 }
  const entry = await owner.put({ ...fact, source })
  await owner.remove(entry!.id)
  expect(await owner.put({ ...fact, source }, true)).toBeNull()
  expect(await owner.put({ ...fact, text: '换一种措辞的同一条旧偏好', source }, true)).toBeNull()
  await owner.dispose()
  owners.splice(owners.indexOf(owner), 1)
  await rm(join(directory, 'memory/index.db'))
  const rebuilt = new DublinMemoryStore(join(directory, 'memory'))
  owners.push(rebuilt)
  await rebuilt.snapshot()
  expect(await rebuilt.put({ ...fact, source }, true)).toBeNull()
  expect((await rebuilt.snapshot()).items).toHaveLength(0)
})
it('exports and imports bodies without credentials and preserves deletion guards on old backups', async () => {
  const { owner } = await fixture()
  const entry = await owner.put(fact), backup = await owner.export()
  await owner.remove(entry!.id)
  expect(await owner.import(backup)).toBe(0)
  const other = (await fixture()).owner
  await other.import(await owner.export())
  expect(await other.put(fact, true)).toBeNull()
  expect(JSON.stringify(await owner.export())).not.toContain('credentialRef')
})
it('validates complete backups and rejects credentials and path-shaped identities', async () => {
  const { owner } = await fixture()
  await expect(owner.put({
    ...fact,
    text: 'api_key=sk-private-super-secret-not-a-real-token',
  })).rejects.toThrow('memorySensitive')
  await expect(owner.put({ ...fact, id: '../../elsewhere' })).rejects.toThrow('memoryInvalid')
  await expect(owner.import({ version: 1, items: [{ ...fact, id: 'bad' }] })).rejects.toThrow('memoryInvalid')
  expect((await owner.snapshot()).items).toHaveLength(0)
})
it('rejects symlinked storage directories', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dublin-memory-link-'))
  directories.push(base)
  const { directory } = await fixture()
  await symlink(join(directory, 'memory'), join(base, 'memory'))
  const owner = new DublinMemoryStore(join(base, 'memory'))
  await expect(owner.snapshot()).rejects.toThrow('memoryInvalid')
})
it('invalidates a cached embedding when the body or provider configuration changes', async () => {
  const { owner } = await fixture()
  const entry = (await owner.put(fact))!
  await owner.vector(entry.id, [.1, .2], 'provider-a')
  expect(await owner.vector(entry.id, undefined, 'provider-a')).toEqual([.1, .2])
  expect(await owner.vector(entry.id, undefined, 'provider-b')).toBeUndefined()
  await owner.put({ ...entry, text: '先验证需求，再修改源码' })
  expect(await owner.vector(entry.id, undefined, 'provider-a')).toBeUndefined()
})
it('validates every deletion guard before importing any of them', async () => {
  const { owner } = await fixture()
  const entry = await owner.put(fact)
  if (!entry) throw Error('Missing memory')
  const backup = await owner.export() as { version: number; items: unknown[]; deleted: unknown[] }
  await owner.remove(entry.id)
  const deleted = await owner.export() as { deleted: unknown[] }
  const other = await fixture()
  await expect(other.owner.import({ ...backup, deleted: [...deleted.deleted, { id: 'bad' }] })).rejects.toThrow('memoryInvalid')
  expect((await other.owner.export() as { deleted: unknown[] }).deleted).toEqual([])
  await other.owner.import(deleted)
})
