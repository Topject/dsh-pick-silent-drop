/*
 * Probe self-test — proves abort-probe.console.js records the right aborts.
 * Run: node self-test.js [--verbose]
 *
 * The probe records an abort only when the call-site stack names UI frames
 * (`ui-workspace`, `ui-layout`, `selectPanel`, `beginNavigation`, ...) and skips
 * transport frames (`gateway`, `WebSocket`, `stream`, ...). A browser stack names
 * the bundle files themselves, so the fixtures below are named after the frames
 * a real bundle produces: `abortFromUiLayoutSelectPanel` stands in for
 * `LayoutController.selectPanel (ui-layout/lib/client.js)`, and
 * `abortFromGatewayReconnect` for a transport reconnect.
 */
const fs = require('node:fs')
const path = require('node:path')

const verbose = process.argv.includes('--verbose')
const code = fs.readFileSync(path.join(__dirname, 'abort-probe.console.js'), 'utf8')

class FakeAbortController {
  constructor() { this.signal = { aborted: false } }
  abort(reason) { this.signal.aborted = true; this.reason = reason }
}

const quiet = new Proxy(console, {
  get: (target, key) => (verbose || key === 'warn' || key === 'error' ? target[key] : () => {}),
})

// In-memory stand-in for the page localStorage the probe mirrors its log into.
const store = new Map()
globalThis.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)) },
  removeItem: key => { store.delete(key) },
}

/** Simulate a page reload: drop the global log, re-install, let it restore. */
function restoreFromStore() {
  delete globalThis.__dshAbortLog
  delete globalThis.__dshAbortsProbeInstalled
  install(globalThis, FakeAbortController, performance, quiet)
  return globalThis.__dshAborts()
}

const install = new Function(
  'globalThis', 'AbortController', 'performance', 'console',
  `return (${code})`,
)
const installMessage = install(globalThis, FakeAbortController, performance, quiet)
console.log('install ->', installMessage)

/** Mirrors `LayoutController.selectPanel` -> `ui-layout/lib/client.js`. */
function abortFromUiLayoutSelectPanel(reason) {
  new FakeAbortController().abort(reason)
}
/** Mirrors a transport reconnect frame -> matched by the noise gate. */
function abortFromGatewayReconnect(reason) {
  new FakeAbortController().abort(reason)
}

abortFromGatewayReconnect('transport reconnect')
const afterNoise = globalThis.__dshAborts().length
abortFromUiLayoutSelectPanel('layout navigation superseded')
abortFromUiLayoutSelectPanel('superseded before reveal')

const all = globalThis.__dshAborts()
const interesting = globalThis.__dshAborts(true)
const frames = globalThis.__dshAbortFrames(0)

const checks = [
  ['install returned the probe banner',
    typeof installMessage === 'string' && installMessage.includes('dsh probe installed')],
  ['readers are exposed on the page global',
    typeof globalThis.__dshAborts === 'function'
    && typeof globalThis.__dshAbortFrames === 'function'
    && typeof globalThis.__dshAbortClear === 'function'
    && typeof globalThis.__dshAbortDump === 'function'],
  ['transport frames are never recorded', afterNoise === 0],
  ['UI-framed aborts are recorded', all.length === 2],
  ['every record carries a boolean classification', all.every(entry => typeof entry.interesting === 'boolean')],
  ['the interesting reader is a filter over the full log',
    interesting.length === all.filter(entry => entry.interesting).length],
  ['newest record carries its reason', all[0]?.reason === 'superseded before reveal'],
  ['records are timestamped', typeof all[0]?.at === 'string' && Number.isFinite(all[0]?.elapsedMs)],
  ['frames reader returns the newest stack',
    typeof frames === 'string' && frames.includes('abortFromUiLayoutSelectPanel')],
  ['dump is copyable and names the record count',
    /records: 2/.test(globalThis.__dshAbortDump())
    && globalThis.__dshAbortDump().includes('superseded before reveal')],
  ['log is mirrored to localStorage',
    (globalThis.localStorage.getItem('dsh.abortProbe.log') ?? '').includes('superseded before reveal')],
  ['a fresh page reload restores the log from localStorage',
    restoreFromStore().length === 2],
  ['clear empties the log and the mirror',
    globalThis.__dshAbortClear() === 'cleared' && globalThis.__dshAborts().length === 0
    && (globalThis.localStorage.getItem('dsh.abortProbe.log') ?? '') === '[]'],
]

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failed++
}
console.log(failed === 0 ? 'probe self-test: all checks passed' : `probe self-test: ${failed} check(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
