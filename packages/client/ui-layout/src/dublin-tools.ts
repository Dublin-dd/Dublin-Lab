/** Desktop-only, application-frame operations for private personal tools. No arbitrary paths or URLs. */
export interface VaultCard { id: string; provider: string; account: string; updatedAt: number }
/** One timestamped sentence with a service-provided anonymous speaker label. */
export interface TranscriptSegment { start: number; end: number; speaker: string; text: string }
/** Supported microphone and system-plus-microphone capture modes. */
export type RecordingSource = 'microphone' | 'mixed'
/** Explicit transcript organization choices. */
export type SummaryKind = 'idea' | 'meeting' | 'actions'
/** Saved organization text and individually reviewable action items. */
export interface RecordingSummary { kind: SummaryKind; text: string; actions: string[] }
/** Saved local recording metadata and any explicitly requested cloud results. */
export interface DublinRecording {
  id: string
  title: string
  createdAt: number
  duration: number
  source: RecordingSource
  interrupted: boolean
  segments: TranscriptSegment[]
  summaries: RecordingSummary[]
  job?: { taskId: string; region: 'beijing' | 'singapore' }
}
/** Non-secret transcription configuration; credentials remain with the native owner. */
export interface TranscriptionSettings {
  region: 'beijing' | 'singapore'
  model: string
  summaryModel: string
  configured: boolean
}
/** Fixed native operation inputs and outputs; no arbitrary paths or URLs. */
export interface DublinToolOperations {
  vaultList: { input: null; output: VaultCard[] }
  vaultSave: { input: { id?: string; provider: string; account: string; secret: string }; output: VaultCard }
  vaultReveal: { input: { id: string }; output: string }
  vaultCopy: { input: { id: string }; output: void }
  vaultDelete: { input: { id: string }; output: void }
  recordings: { input: null; output: DublinRecording[] }
  recordingStart: { input: { source: RecordingSource }; output: DublinRecording }
  recordingAppend: { input: { id: string; pcm: Uint8Array }; output: number }
  recordingStop: { input: { id: string }; output: DublinRecording }
  recordingRename: { input: { id: string; title: string }; output: DublinRecording }
  recordingDelete: { input: { id: string }; output: void }
  recordingRead: { input: { id: string }; output: Uint8Array }
  recordingExport: { input: { id: string }; output: boolean }
  transcriptionSettings: { input: null; output: TranscriptionSettings }
  transcriptionConfigure: { input: Omit<TranscriptionSettings, 'configured'> & { apiKey: string }; output: TranscriptionSettings }
  transcriptionDisconnect: { input: null; output: void }
  transcribe: { input: { id: string }; output: DublinRecording }
  summarize: { input: { id: string; kind: SummaryKind }; output: DublinRecording }
  captureAuthorize: { input: null; output: void }
}
/** Primary-frame desktop bridge for the fixed personal-tool operations. */
export interface DublinToolsApi {
  run<K extends keyof DublinToolOperations>(operation: K, input: DublinToolOperations[K]['input']): Promise<DublinToolOperations[K]['output']>
}
