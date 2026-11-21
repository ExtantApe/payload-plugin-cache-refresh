'use client'

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react'

export type CacheRefreshText = {
  button: string
  title: string
  explainStale: string
  explainExpire: string
  changed: (count: number | null) => string
  everything: string
  confirm: string
  cancel: string
  working: string
  done: (count: number) => string
  nothing: string
  warmFailed: (failed: number) => string
  warmTimedOut: (n: number) => string
  warmSkipped: (n: number) => string
  busy: string
  notAudited: string
  failed: string
}

export const defaultText: CacheRefreshText = {
  button: 'Refresh site cache',
  title: 'Refresh the site cache?',
  explainStale: 'Visitors keep seeing the current pages while they are rebuilt.',
  explainExpire: 'The next visitor to each page waits while it is rebuilt.',
  changed: (n) => (n === null ? 'Only what changed' : `Only what changed (${n})`),
  everything: 'Everything',
  confirm: 'Refresh now',
  cancel: 'Cancel',
  working: 'Refreshing...',
  done: (n) => `Refreshed ${n} ${n === 1 ? 'tag' : 'tags'}.`,
  nothing: 'Nothing had changed, so nothing was refreshed.',
  warmFailed: (n) => `${n} ${n === 1 ? 'page' : 'pages'} could not be warmed. The refresh itself went through.`,
  warmTimedOut: (n) => `${n} ${n === 1 ? 'page' : 'pages'} took too long to warm.`,
  warmSkipped: (n) => `${n} ${n === 1 ? 'page was' : 'pages were'} not warmed.`,
  busy: 'A refresh is running or just finished. Try again in a few seconds.',
  notAudited: 'The refresh went through, but the record of it could not be saved.',
  failed: 'The refresh did not happen. Nothing was changed.',
}

type Status = { allowed: boolean; mode: 'stale' | 'expire'; hasChanged: boolean; changedCount: number | null }

const v = (name: string, fallback: string) => `var(--cache-refresh-${name}, ${fallback})`
const ink = v('ink', 'currentColor')
const paper = v('paper', 'var(--theme-elevation-0, Canvas)')
const line = v('line', 'color-mix(in srgb, currentColor 45%, transparent)')
const focus = v('focus', '#b85c00')
const s = {
  wrap: { font: 'inherit', color: ink, margin: '0 0 1.5rem' } as CSSProperties,
  button: { font: 'inherit', color: ink, background: paper, border: `1px solid ${line}`, borderRadius: 6, minHeight: 36, padding: '6px 14px', cursor: 'pointer' } as CSSProperties,
  panel: { marginTop: 8, maxWidth: 440, background: paper, color: ink, border: `1px solid ${line}`, borderRadius: 8, padding: 14 } as CSSProperties,
  fieldset: { border: 0, margin: '8px 0', padding: 0 } as CSSProperties,
  row: { display: 'flex', gap: 8, alignItems: 'center', minHeight: 32 } as CSSProperties,
  actions: { display: 'flex', gap: 8, marginTop: 12 } as CSSProperties,
  note: { margin: '8px 0 0' } as CSSProperties,
}
const css = `.cache-refresh :focus-visible{outline:3px solid ${focus};outline-offset:2px}.cache-refresh button:disabled{cursor:progress;opacity:.7}`

/**
 * The dashboard button. Renders nothing for anyone the host does not allow. Pressing it opens a confirmation
 * panel; nothing is refreshed until "Refresh now". Escape or Cancel closes the panel and returns focus.
 */
export function CacheRefreshButton({ apiRoute = '/api', endpointPath = '/cache-refresh', text }: { apiRoute?: string; endpointPath?: string; text?: Partial<CacheRefreshText> }) {
  const t = { ...defaultText, ...text }
  const url = `${apiRoute}${endpointPath}`
  const [status, setStatus] = useState<Status | null>(null)
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<'changed' | 'all'>('changed')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const id = useId()

  useEffect(() => {
    let live = true
    fetch(url, { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<Status>) : null))
      .then((s2) => live && setStatus(s2))
      .catch(() => live && setStatus(null))
    return () => {
      live = false
    }
  }, [url])

  useEffect(() => {
    if (open) heading.current?.focus()
  }, [open])

  const close = useCallback(() => {
    setOpen(false)
    trigger.current?.focus()
  }, [])

  const run = async () => {
    setBusy(true)
    setMessage(t.working)
    try {
      const res = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, scope: status?.hasChanged ? scope : 'all' }) })
      if (res.status === 429) {
        setMessage(t.busy)
        return
      }
      if (!res.ok) throw new Error('refused')
      const out = (await res.json()) as { count: number; audited: boolean; warmed?: { failed: number; timedOut?: number; skipped?: number } }
      const parts = [out.count === 0 ? t.nothing : t.done(out.count)]
      const w = out.warmed
      if (w && w.failed > 0) parts.push(t.warmFailed(w.failed))
      if (w?.timedOut) parts.push(t.warmTimedOut(w.timedOut))
      if (w?.skipped) parts.push(t.warmSkipped(w.skipped))
      if (out.audited === false) parts.push(t.notAudited)
      setMessage(parts.join(' '))
      setOpen(false)
      trigger.current?.focus()
    } catch {
      setMessage(t.failed)
    } finally {
      setBusy(false)
    }
  }

  if (!status?.allowed) return null
  return (
    <div className="cache-refresh" style={s.wrap} onKeyDown={(e) => e.key === 'Escape' && open && !busy && close()}>
      <style>{css}</style>
      <button ref={trigger} type="button" style={s.button} aria-expanded={open} aria-controls={id} onClick={() => (open ? close() : setOpen(true))}>
        {t.button}
      </button>
      {open && (
        <div id={id} role="group" aria-labelledby={`${id}-h`} style={s.panel}>
          <h3 id={`${id}-h`} ref={heading} tabIndex={-1} style={{ margin: 0, fontSize: '1em' }}>
            {t.title}
          </h3>
          <p style={s.note}>{status.mode === 'expire' ? t.explainExpire : t.explainStale}</p>
          {status.hasChanged && (
            <fieldset style={s.fieldset}>
              <legend className="visually-hidden" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                {t.title}
              </legend>
              <label style={s.row}>
                <input type="radio" name={`${id}-scope`} checked={scope === 'changed'} onChange={() => setScope('changed')} /> {t.changed(status.changedCount)}
              </label>
              <label style={s.row}>
                <input type="radio" name={`${id}-scope`} checked={scope === 'all'} onChange={() => setScope('all')} /> {t.everything}
              </label>
            </fieldset>
          )}
          <div style={s.actions}>
            <button type="button" style={s.button} disabled={busy} onClick={() => void run()}>
              {t.confirm}
            </button>
            <button type="button" style={s.button} disabled={busy} onClick={close}>
              {t.cancel}
            </button>
          </div>
        </div>
      )}
      <p role="status" aria-live="polite" style={s.note}>
        {message}
      </p>
    </div>
  )
}
