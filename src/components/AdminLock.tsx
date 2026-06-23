import clsx from 'clsx'
import { Lock, LockOpen, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { adminGateEnabled, useAdminStore, useIsAdmin } from '@/store/adminStore'

/** Header button: shows "Unlock admin" when gated + locked, "Lock"
 *  when unlocked, nothing when no PIN is configured. */
export function AdminLock() {
  const isAdmin = useIsAdmin()
  const unlock = useAdminStore((s) => s.unlock)
  const lock = useAdminStore((s) => s.lock)
  const [open, setOpen] = useState(false)
  const [pin, setPin] = useState('')
  const [error, setError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      // Tick later so the input has time to mount before focus.
      const t = window.setTimeout(() => inputRef.current?.focus(), 30)
      return () => window.clearTimeout(t)
    }
  }, [open])

  if (!adminGateEnabled) return null

  if (isAdmin) {
    return (
      <button
        type="button"
        onClick={lock}
        className="inline-flex items-center gap-1.5 text-sm text-emerald-700 underline-offset-2 hover:underline"
        title="Lock — non-admins won't see hours or editing controls"
      >
        <LockOpen className="h-4 w-4" />
        Admin
      </button>
    )
  }

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (unlock(pin)) {
      setOpen(false)
      setPin('')
      setError(false)
    } else {
      setError(true)
      setPin('')
      inputRef.current?.focus()
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-sm text-slate-500 underline-offset-2 hover:underline"
        title="Unlock with the admin PIN to see hours and edit"
      >
        <Lock className="h-4 w-4" />
        Unlock admin
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 px-4"
          onClick={() => setOpen(false)}
        >
          <form
            onSubmit={submit}
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-xs flex-col gap-3 rounded-2xl bg-white p-5 shadow-xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-800">Admin unlock</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Enter the PIN to see hours and edit the schedule.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <input
              ref={inputRef}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => { setPin(e.target.value); setError(false) }}
              placeholder="PIN"
              className={clsx(
                'w-full rounded-xl border bg-white px-4 py-2.5 text-center text-lg tracking-widest text-slate-800 outline-none',
                error
                  ? 'border-red-300 focus:border-red-500 focus:ring-2 focus:ring-red-200'
                  : 'border-slate-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-200',
              )}
            />
            {error && (
              <p className="text-xs text-red-600">Incorrect PIN — try again.</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pin.length === 0}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Unlock
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}
