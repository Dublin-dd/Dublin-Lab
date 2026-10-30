/** Retain native reminder notifications until close and release them on quit. */
import { Notification } from 'electron'

/**
 * Own native notifications independently of visible application windows.
 * @param activate - bring the existing application window forward on click.
 * @param report - notification delivery failure sink; in-app notices remain durable.
 * @returns notification presentation and synchronous cleanup.
 */
export function createReminderNotifications(activate: () => void, report: (error: unknown) => void): {
  show: (reminder: { id: string; title: string; message: string }) => void
  dispose: () => void
} {
  const notices = new Map<string, Notification>()
  return {
    show(reminder) {
      if (!Notification.isSupported()) return
      try {
        notices.get(reminder.id)?.close()
        const notice = new Notification({ title: reminder.title, body: reminder.message })
        notices.set(reminder.id, notice)
        notice.once('click', activate)
        notice.once('close', () => { if (notices.get(reminder.id) === notice) notices.delete(reminder.id) })
        notice.once('failed', (_event, error) => { report(error); notices.delete(reminder.id) })
        notice.show()
      } catch (error) { report(error) }
    },
    dispose() {
      for (const notice of notices.values()) { notice.removeAllListeners(); notice.close() }
      notices.clear()
    },
  }
}
