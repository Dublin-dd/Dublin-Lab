/** Unbound conversations use private execution directories and ordinary durable Sessions. */
import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import { SessionId } from '@deepseek-ai/dsh-session'
import { dublinProjectDirectory } from './simin-proposals.ts'

/** Host-owned creation, restoration and project continuation of temporary conversations. */
export class DublinTemporarySessions {
  /** @param ctx - existing Session/Workspace owners. @param root - workbench project root. */
  constructor(private readonly ctx: Context, private readonly root: string) {}
  /** Read temporary chat history.
   * @returns retained ordinary temporary sessions; reads do not activate them.
    */
  async list(): Promise<unknown> {
    const controller: Context['sessionController'] | undefined = this.ctx.get('sessionController')
    if (controller === undefined) throw new Error('temporaryUnavailable')
    const { items } = await controller.list({}, new AbortController().signal)
    const sessions = []
    for (const item of items) {
      if (item.cwd === undefined || item.origin === 'subagent') continue
      const cwd = await dublinProjectDirectory(item.cwd, this.root)
      if (cwd !== undefined && basename(dirname(cwd)) === '.dublin-chats') sessions.push(item)
    }
    return { sessions }
  }
  /**
   * Create an unbound chat, validate reopening, or continue an idle chat in a project.
   * @param value - fixed action, optional retained session identity and project name.
   * @returns the durable Session identity and optional destination project.
   */
  async invoke(value: unknown): Promise<{ sessionId: string; project?: string; path?: string }> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('temporaryInvalid')
    const data = value as Record<string, unknown>
    if (!['create', 'open', 'transfer'].includes(String(data.action))
      || Object.keys(data).some(key => !['action', 'sessionId', 'project'].includes(key))) throw new Error('temporaryInvalid')
    const controller: Context['sessionController'] | undefined = this.ctx.get('sessionController')
    if (controller === undefined) throw new Error('temporaryUnavailable')
    if (data.action === 'create') {
      if (data.sessionId !== undefined || data.project !== undefined) throw new Error('temporaryInvalid')
      const privateRoot = join(this.root, '.dublin-chats')
      await mkdir(privateRoot, { recursive: true, mode: 0o700 })
      if (await realpath(privateRoot) !== join(await realpath(this.root), '.dublin-chats')) throw new Error('temporaryInvalid')
      const cwd = join(privateRoot, randomUUID())
      await mkdir(cwd, { mode: 0o700 })
      return controller.create({ cwd, agentPreset: 'standard' })
    }
    if (typeof data.sessionId !== 'string') throw new Error('temporaryInvalid')
    const sessionId = SessionId(data.sessionId)
    const { items } = await controller.list({}, new AbortController().signal)
    const source = items.find(item => item.sessionId === sessionId && item.origin !== 'subagent')
    const cwd = source?.cwd === undefined ? undefined : await dublinProjectDirectory(source.cwd, this.root)
    if (cwd === undefined || basename(dirname(cwd)) !== '.dublin-chats') throw new Error('temporaryMissing')
    if (data.action === 'open') {
      if (data.project !== undefined) throw new Error('temporaryInvalid')
      return { sessionId }
    }
    if (source?.running || source?.blank) throw new Error('temporaryBusy')
    if (typeof data.project !== 'string' || data.project.startsWith('.') || basename(data.project) !== data.project
      || /[\\/]/u.test(data.project) || !data.project) throw new Error('temporaryInvalid')
    const target = await realpath(join(this.root, data.project))
    if (dirname(target) !== await realpath(this.root)) throw new Error('temporaryInvalid')
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) throw new Error('temporaryUnavailable')
    const workspace = await registry.create(target)
    const result = await controller.fork({ sessionId, workspaceId: workspace.id })
    return { sessionId: result.sessionId, project: data.project, path: target }
  }
}
