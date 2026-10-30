/** Primary-frame IPC adapter: OS encryption, user presence, local audio and explicit cloud requests. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { app, desktopCapturer, dialog, ipcMain, safeStorage, session, systemPreferences, type IpcMainInvokeEvent } from 'electron'
import { DublinVault, field, identity, object } from './dublin-vault.ts'
import { DublinRecordings } from './dublin-recordings.ts'
import { DublinTranscription } from './dublin-transcription.ts'

import { DESKTOP_IPC } from './ipc.ts'
const execute = promisify(execFile)
/** Install exactly once after Electron is ready; only the primary top frame passes assertSender. */
export function installDublinTools(assertSender: (event: IpcMainInvokeEvent) => void) {
  const directory = join(app.getPath('userData'), 'dublin-tools')
  const auth = fileURLToPath(new URL('./dublin-auth', import.meta.url))
  let authenticating = false
  let copied: string | undefined
  let clearTimer: NodeJS.Timeout | undefined
  const pasteboard = (command: 'copy' | 'clear', value: string): Promise<void> => new Promise((resolve, reject) => {
    if (process.platform !== 'darwin' || !existsSync(auth)) { reject(new Error('toolsAuthenticationUnavailable')); return }
    // Secret bytes use stdin only, never argv, environment, output or an intermediate file.
    const child = execFile(auth, [command], { timeout: 10000 }, (error) => { if (error === null) resolve(); else reject(new Error('toolsOperationFailed')) })
    if (child.stdin === null) { child.kill(); reject(new Error('toolsOperationFailed')); return }
    child.stdin.on('error', () => { reject(new Error('toolsOperationFailed')) })
    child.stdin.end(value)
  })
  const clearCopy = async (): Promise<void> => {
    clearTimeout(clearTimer); clearTimer = undefined
    const value = copied; copied = undefined
    if (value !== undefined) await pasteboard('clear', value)
  }
  const authenticate = async (): Promise<void> => {
    if (authenticating) throw new Error('toolsBusy')
    authenticating = true
    try {
      if (process.platform !== 'darwin') throw new Error('toolsAuthenticationUnavailable')
      if (existsSync(auth)) await execute(auth, [], { timeout: 120000 })
      else if (systemPreferences.canPromptTouchID()) await systemPreferences.promptTouchID('访问 Dublin Lab 本机 API 密钥')
      else throw new Error('toolsAuthenticationUnavailable')
    } catch (error) {
      if (error instanceof Error && error.message === 'toolsAuthenticationUnavailable') throw error
      throw new Error('toolsAuthenticationCancelled')
    } finally { authenticating = false }
  }
  const vault = new DublinVault(directory, {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value), authenticate,
    async copy(value) {
      await pasteboard('copy', value)
      copied = value; clearTimeout(clearTimer)
      clearTimer = setTimeout(() => {
        void clearCopy().catch((_error: unknown) => { /* Clipboard access can be revoked after copying. */ })
      }, 30000)
      clearTimer.unref()
    },
  })
  const recordings = new DublinRecordings(join(directory, 'recordings'))
  const transcription = new DublinTranscription(recordings, vault)
  let releaseRecordingOwner: (() => void) | undefined
  let capture: { frame: Electron.WebFrameMain; expires: number } | undefined
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const authorization = capture; capture = undefined
    if (authorization === undefined || authorization.expires < Date.now() || request.frame !== authorization.frame
      || request.securityOrigin !== 'dsh-app://app' || !request.userGesture || !request.audioRequested) { callback({}); return }
    void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
      if (sources[0] === undefined) { callback({}); return }
      callback({ video: sources[0], audio: 'loopback' })
    }, () => { callback({}) })
  })
  ipcMain.handle(DESKTOP_IPC.personalTools, async (event, operation: unknown, input: unknown): Promise<unknown> => {
    assertSender(event)
    try {
      switch (operation) {
        case 'vaultList': return await vault.list()
        case 'vaultSave': return await vault.save(input)
        case 'vaultReveal': return await vault.reveal(identity(object(input).id))
        case 'vaultCopy': {  await vault.copy(identity(object(input).id)); return }
        case 'vaultDelete': {  await vault.remove(identity(object(input).id)); return }
        case 'transcriptionSettings': return await vault.settings()
        case 'transcriptionConfigure': return await vault.configure(input)
        case 'transcriptionDisconnect': {  await vault.disconnect(); return }
        case 'recordings': return await recordings.list()
        case 'recordingStart': {
          const source = object(input).source
          if (source !== 'microphone' && source !== 'mixed') throw new Error('toolsInvalid')
          const item = await recordings.start(source), owner = event.sender
          const lost = (): void => {
            releaseRecordingOwner?.(); releaseRecordingOwner = undefined
            void recordings.finish().catch((_error: unknown) => { /* The interrupted WAV remains recoverable on the next launch. */ })
          }
          releaseRecordingOwner = () => { owner.removeListener('render-process-gone', lost); owner.removeListener('destroyed', lost) }
          owner.once('render-process-gone', lost); owner.once('destroyed', lost)
          if (owner.isDestroyed()) lost()
          return item
        }
        case 'recordingAppend': { const data = object(input); return await recordings.append(identity(data.id), data.pcm) }
        case 'recordingStop': {
          const item = await recordings.stop(identity(object(input).id))
          releaseRecordingOwner?.(); releaseRecordingOwner = undefined
          return item
        }
        case 'recordingRename': {
          const data = object(input), id = identity(data.id)
          if (transcription.isBusy(id)) throw new Error('toolsBusy')
          return await recordings.rename(id, field(data.title, 200))
        }
        case 'recordingDelete': {
          const id = identity(object(input).id)
          if (transcription.isBusy(id)) throw new Error('toolsBusy')
          await recordings.remove(id); return
        }
        case 'recordingRead': {
          const id = identity(object(input).id); await recordings.get(id)
          const path = recordings.audioPath(id)
          if ((await stat(path)).size > 230400044) throw new Error('toolsRecordingLimit')
          return new Uint8Array(await readFile(path))
        }
        case 'recordingExport': {
          const id = identity(object(input).id), item = await recordings.get(id)
          const target = await dialog.showSaveDialog({ defaultPath: `${item.title.replace(/[\\/:*?"<>|]/gu, '-')}.wav`, filters: [{ name: 'WAV', extensions: ['wav'] }] })
          if (target.canceled) return false
          await copyFile(recordings.audioPath(id), target.filePath); return true
        }
        case 'transcribe': return await transcription.transcribe(identity(object(input).id))
        case 'summarize': {
          const data = object(input)
          if (data.kind !== 'idea' && data.kind !== 'meeting' && data.kind !== 'actions') throw new Error('toolsInvalid')
          return await transcription.summarize(identity(data.id), data.kind)
        }
        case 'captureAuthorize': {
          if (event.senderFrame === null) throw new Error('toolsInvalid')
          capture = { frame: event.senderFrame, expires: Date.now() + 15000 }; return
        }
        default: throw new Error('toolsInvalid')
      }
    } catch (error) {
      // Never forward API responses, key material, paths, or operating system diagnostics.
      throw new Error(error instanceof Error && /^tools[A-Za-z]+$/u.test(error.message) ? error.message : 'toolsOperationFailed')
    }
  })
  return {
    recordings,
    get busy(): boolean { return recordings.capturing || transcription.working },
    get capturing(): boolean { return recordings.capturing },
    async finish(): Promise<void> {
      await recordings.finish()
      releaseRecordingOwner?.(); releaseRecordingOwner = undefined
      await clearCopy().catch((_error: unknown) => { /* A revoked clipboard permission does not block quitting. */ })
    },
  }
}
