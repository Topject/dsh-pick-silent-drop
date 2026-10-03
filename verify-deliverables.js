/*
 * Deliverable integrity check.
 *
 * Verifies:
 *   1. the modified ui-workspace spec still has balanced code delimiters and no
 *      encoding damage (a syntax/delimiter integrity check that needs no
 *      toolchain — TypeScript is deliberately optional below, because neither
 *      the installed app nor this workspace ships a compiler)
 *   2. the extracted client bundle still matches the asar byte-for-byte
 *   3. every text artifact decodes as UTF-8 with no replacement characters
 *
 * Run: node verify-deliverables.js
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const APP_RESOURCES = process.env.DSH_APP_RESOURCES ?? path.join(
  process.env.LOCALAPPDATA ?? path.join(require('node:os').homedir(), 'AppData', 'Local'),
  'Programs', 'DeepSeek Harness', 'resources',
)
const TS_PATH = path.join(APP_RESOURCES, 'app.asar.unpacked/dsh/node_modules/typescript')
const ASAR = path.join(APP_RESOURCES, 'app.asar')
const WORKSPACE = path.resolve(__dirname, '..')
const UPSTREAM = path.join(WORKSPACE, 'dsh-upstream')
const SPEC = path.join(UPSTREAM, 'packages/client/ui-workspace/tests/workspaces-service.client.spec.ts')
const SRC_BUNDLE = path.join(WORKSPACE, '.dsh-src/dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js')

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

/**
 * Count code delimiters while skipping strings, template literals, comments and
 * regex literals, so brace balance is a real corruption signal rather than a
 * count of braces inside prose and i18n copy.
 * @param source - file text
 * @returns `{ depth, reason }`; depth 0 means balanced, reason names an unclosed construct
 */
function delimiterReport(source) {
  const stack = []
  const pairs = { ')': '(', ']': '[', '}': '{' }
  let index = 0
  let reason = ''
  const prevSignificant = () => {
    for (let back = index - 1; back >= 0; back--) {
      const char = source[back]
      if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') return char
    }
    return ''
  }
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index++
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      index++
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue }
        if (source[index] === quote) { index++; break }
        index++
      }
      continue
    }
    if (char === '/' && /[=(,:;[!&|?{}+\-*%<>~^]/.test(prevSignificant())) {
      index++
      let inClass = false
      while (index < source.length) {
        const current = source[index]
        if (current === '\\') { index += 2; continue }
        if (current === '[') inClass = true
        else if (current === ']') inClass = false
        else if (current === '/' && !inClass) { index++; break }
        else if (current === '\n') break
        index++
      }
      continue
    }
    if (char === '(' || char === '[' || char === '{') { stack.push(char); index++; continue }
    if (char === ')' || char === ']' || char === '}') {
      const expected = pairs[char]
      const actual = stack.pop()
      if (actual !== expected) { reason = `unbalanced "${char}"`; break }
      index++
      continue
    }
    index++
  }
  if (reason === '' && stack.length > 0) reason = `unclosed "${stack[stack.length - 1]}"`
  return { depth: stack.length, reason }
}

// ---- 1. spec file integrity -------------------------------------------------
const specSource = fs.readFileSync(SPEC, 'utf8')
const specReport = delimiterReport(specSource)
check('spec code delimiters are balanced', specReport.reason === '',
  specReport.reason || `${specSource.split('\n').length} lines`)
check('spec has no replacement characters', !specSource.includes('\uFFFD'))
check('spec has no NUL bytes', !specSource.includes('\u0000'))

const added = /it\.each\(\['panel', 'workspace'\][\s\S]*?it\.todo\('keeps or recycles the created Session[^\n]*\n/.exec(specSource)
check('added regression block is present and closed', added !== null)
if (added) {
  const blockReport = delimiterReport(added[0])
  check('added block delimiters are balanced', blockReport.reason === '', blockReport.reason)
  check('added block drives both supersession kinds',
    added[0].includes("['panel', 'workspace']") && added[0].includes('await pending'))
  check('added block pins retain and notice absence',
    added[0].includes('expect(b.sessions.retain).not.toHaveBeenCalled()')
    && added[0].includes('expect(b.notify).not.toHaveBeenCalled()'))
}

// Optional: the real compiler, when the repo has been installed.
let ts
try { ts = require(TS_PATH) } catch { ts = undefined }
if (ts === undefined) {
  console.log('SKIP  TypeScript syntax pass — no compiler available (needs the repo install: pnpm install)')
} else {
  const sourceFile = ts.createSourceFile('spec.ts', specSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const syntactic = sourceFile.parseDiagnostics ?? []
  check('spec parses with no syntax diagnostics', syntactic.length === 0,
    syntactic.slice(0, 3).map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join(' | '))
}

// ---- 2. extracted bundle matches the asar ----------------------------------
function readAsarEntry(target) {
  const fd = fs.openSync(ASAR, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(4)
    const jsonSize = head.readUInt32LE(12)
    const json = Buffer.alloc(jsonSize)
    fs.readSync(fd, json, 0, jsonSize, 16)
    const base = 8 + headerSize
    let node = JSON.parse(json.toString('utf8'))
    for (const part of target.split('/')) {
      node = node.files?.[part]
      if (node === undefined) throw new Error(`asar entry not found: ${target}`)
    }
    if (node.files !== undefined) throw new Error(`asar entry is a directory: ${target}`)
    const buffer = Buffer.alloc(Number(node.size))
    if (buffer.length > 0) fs.readSync(fd, buffer, 0, buffer.length, base + Number(node.offset))
    return buffer
  } finally { fs.closeSync(fd) }
}

const asarEntry = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js'
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex')
// Anchor recorded when the artefact was first extracted; a change here means the
// installed app changed, not that the file was corrupted.
const EXPECTED_BUNDLE_SHA = '29c34ce1c2a4'
try {
  const fromAsar = readAsarEntry(asarEntry)
  const digest = sha(fromAsar)
  check('asar bundle matches the recorded anchor', digest.startsWith(EXPECTED_BUNDLE_SHA),
    `${digest.slice(0, 12)} (${fromAsar.length} B)`)
  check('asar bundle still carries the silent-drop branch',
    fromAsar.toString('utf8').includes('if (navigation.aborted) return;'))
  if (fs.existsSync(SRC_BUNDLE)) {
    check('extracted copy matches the asar byte-for-byte',
      sha(fs.readFileSync(SRC_BUNDLE)) === digest)
  } else {
    console.log('SKIP  extracted copy comparison — .dsh-src removed (regenerable via extract-asar.js)')
  }
} catch (error) {
  check('asar bundle matches the recorded anchor', false, error.message)
}

// ---- 3. text artifacts decode cleanly --------------------------------------
const textArtifacts = [
  path.join(__dirname, 'abort-probe.console.js'),
  path.join(__dirname, 'self-test.js'),
  path.join(__dirname, 'extract-asar.js'),
  path.join(__dirname, 'verify-deliverables.js'),
  path.join(__dirname, 'dsh-cleanup-blank-sessions.ps1'),
  path.join(__dirname, '.gitattributes'),
  path.join(__dirname, 'README.md'),
]
for (const file of textArtifacts) {
  if (!fs.existsSync(file)) { check(`decodes cleanly: ${path.basename(file)}`, false, 'missing'); continue }
  const bytes = fs.readFileSync(file)
  const text = bytes.toString('utf8')
  const roundTrips = Buffer.from(text, 'utf8').equals(bytes)
  check(`decodes cleanly: ${path.basename(file)}`, roundTrips && !text.includes('\uFFFD'),
    `${bytes.length} B${bytes[0] === 0xEF && bytes[1] === 0xBB ? ', has BOM' : ''}`)
}

const failed = results.filter(entry => !entry.ok).length
console.log(failed === 0
  ? `\nintegrity: all ${results.length} checks passed`
  : `\nintegrity: ${failed} of ${results.length} checks FAILED`)
process.exitCode = failed === 0 ? 0 : 1
