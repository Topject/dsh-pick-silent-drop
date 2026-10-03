/*
 * DSH navigation-abort probe — paste the whole file into the Web GUI's DevTools
 * Console, then reproduce the failure once (New Session -> pick a workspace).
 * Nothing is uploaded anywhere; results stay in the page and in localStorage.
 *
 * Why this exists: `UiWorkspaceService.openWorkspace` returns silently when its
 * navigation is aborted after the Host already created the Session
 * (packages/client/ui-workspace/src/client/navigation.ts,
 * `if (navigation.aborted) return`). Every layout navigation abort routes
 * through `AbortController.prototype.abort`, so wrapping it here captures the
 * exact stack of whatever superseded the pick — either a `selectPanel` (which
 * aborts the pending navigation by design, ui-layout/src/client/service.ts) or
 * a later `beginNavigation`.
 *
 * Usage:
 *   __dshAborts()        -> last 40 aborts, newest first (table)
 *   __dshAborts(true)    -> only aborts whose stack touches ui-workspace/ui-layout
 *   __dshAbortFrames(0)  -> full stack of the newest record
 *   __dshAbortDump()     -> one copyable text block (HEAD + records + stacks)
 *   __dshAbortClear()    -> empty the log before a fresh reproduction
 *   __dshAbortAuto()     -> print every matching abort as it happens
 *
 * The log is mirrored into localStorage under STORE_KEY, so it survives a page
 * reload (a reload would otherwise wipe the console and this wrapper).
 */
(() => {
  const KEY = '__dshAbortLog'
  const STORE_KEY = 'dsh.abortProbe.log'
  const MAX = 40
  const page = globalThis
  const noise = /client-modules|ApiGateway|gateway|WebSocket|fetch|eventsource|EventSource|ReadableStream|stream/i
  const interestingPattern = /ui-workspace|ui-layout|navigation\.ts|replaceMain|selectPanel|beginNavigation/

  const load = () => {
    if (Array.isArray(page[KEY])) return page[KEY]
    try {
      const stored = page.localStorage?.getItem(STORE_KEY)
      const parsed = stored === null || stored === undefined ? [] : JSON.parse(stored)
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }
  const log = load()
  page[KEY] = log
  const persist = () => {
    try { page.localStorage?.setItem(STORE_KEY, JSON.stringify(log.slice(0, MAX))) } catch { /* private mode */ }
  }

  if (page.__dshAbortsProbeInstalled !== true) {
    page.__dshAbortsProbeInstalled = true
    const nativeAbort = AbortController.prototype.abort
    AbortController.prototype.abort = function abort(reason) {
      try {
        const stack = new Error('abort').stack ?? ''
        if (!noise.test(stack)) {
          const entry = {
            at: new Date().toISOString(),
            elapsedMs: Math.round(performance.now()),
            reason: reason === undefined ? null : String(reason),
            interesting: interestingPattern.test(stack),
            stack,
          }
          log.unshift(entry)
          if (log.length > MAX) log.length = MAX
          persist()
          if (page.__dshAbortAutoOn === true && entry.interesting) {
            console.warn('[dsh-probe] abort', entry.reason, '\n' + entry.stack)
          }
        }
      } catch (error) {
        console.warn('[dsh-probe] could not record an abort', error)
      }
      return nativeAbort.call(this, reason)
    }
  }

  page.__dshAbortClear = () => { log.length = 0; persist(); return 'cleared' }
  page.__dshAbortAuto = (on = true) => { page.__dshAbortAutoOn = on === true; return page.__dshAbortAutoOn }
  page.__dshAborts = (onlyInteresting = false) => {
    const rows = onlyInteresting ? log.filter(entry => entry.interesting) : log
    console.table(rows.map((entry, index) => ({
      '#': index,
      at: entry.at,
      ms: entry.elapsedMs,
      interesting: entry.interesting,
      reason: entry.reason,
      topFrame: (entry.stack.split('\n')[2] ?? entry.stack.split('\n')[1] ?? '').trim(),
    })))
    return rows
  }
  page.__dshAbortFrames = (index = 0) => (log[index]?.stack ?? 'no entry at that index')
  /** One copyable block: header, compact rows, then each interesting stack. */
  page.__dshAbortDump = () => {
    const lines = [
      `# dsh abort probe dump`,
      `# ua: ${String(page.navigator?.userAgent ?? 'n/a')}`,
      `# records: ${log.length} (interesting: ${log.filter(e => e.interesting).length})`,
      '',
    ]
    log.forEach((entry, index) => {
      lines.push(`[${index}] ${entry.at} (+${entry.elapsedMs}ms) interesting=${entry.interesting} reason=${entry.reason ?? 'null'}`)
    })
    const interesting = log.filter(entry => entry.interesting)
    if (interesting.length > 0) {
      lines.push('', '## interesting stacks', '')
      interesting.forEach((entry, index) => {
        lines.push(`--- #${index} ${entry.at} reason=${entry.reason ?? 'null'}`)
        lines.push(entry.stack)
        lines.push('')
      })
    }
    return lines.join('\n')
  }

  return `dsh probe installed — reproduce the failure, then run copy(__dshAbortDump())`
})()
