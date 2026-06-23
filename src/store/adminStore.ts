/**
 * Admin PIN gate.
 *
 * UX intent: dispatchers/drivers can see WHEN they work, but the totals
 * pills and editing controls are admin-only. Anyone with the bundle can
 * grep out the PIN — this is UX-level, not security-level. For real
 * access control move the data behind an authenticated API.
 *
 * Set VITE_ADMIN_PIN in .env.local / Vercel to enable the gate. Leave
 * it unset and the app behaves as fully unlocked (current behaviour).
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

const ADMIN_PIN = (import.meta.env.VITE_ADMIN_PIN as string | undefined)?.trim()

/** True when a PIN is configured — the rest of the UI shows the Lock
 *  button only in that case. */
export const adminGateEnabled = !!ADMIN_PIN && ADMIN_PIN.length > 0

interface AdminStore {
  /** Raw persisted unlock state. Prefer the `useIsAdmin()` hook in
   *  components — it always returns `true` when the gate is disabled,
   *  regardless of what's persisted. */
  unlocked: boolean
  /** Returns true if the PIN matched (and the store is now unlocked). */
  unlock: (pin: string) => boolean
  lock: () => void
}

export const useAdminStore = create<AdminStore>()(persist(
  (set) => ({
    unlocked: false,
    unlock: (pin) => {
      if (!adminGateEnabled) {
        set({ unlocked: true })
        return true
      }
      if (pin === ADMIN_PIN) {
        set({ unlocked: true })
        return true
      }
      return false
    },
    lock: () => set({ unlocked: false }),
  }),
  {
    name: 'admin-unlock',
    storage: createJSONStorage(() => localStorage),
    partialize: (s) => ({ unlocked: s.unlocked }),
  },
))

/** True when the user can see hours + edit. Always true when the
 *  gate is disabled (no VITE_ADMIN_PIN). */
export function useIsAdmin(): boolean {
  const unlocked = useAdminStore((s) => s.unlocked)
  return adminGateEnabled ? unlocked : true
}
