/*
 * Extract selected directories from a DSH app.asar for read-only inspection.
 *
 * Usage:
 *   node extract-asar.js <out-dir> [prefix,...] [--asar <path>]
 *
 *   <prefix> entries are asar path prefixes, for example
 *   "dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/".
 *   With no prefix the whole archive is extracted.
 *   --asar overrides the app.asar path (default: the per-user Windows install).
 *
 * Example:
 *   node extract-asar.js ./out dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const DEFAULT_ASAR = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'Programs', 'DeepSeek Harness', 'resources', 'app.asar',
)

const argv = process.argv.slice(2)
const asarFlag = argv.indexOf('--asar')
let asarPath = DEFAULT_ASAR
if (asarFlag !== -1) {
  asarPath = argv[asarFlag + 1] ?? ''
  argv.splice(asarFlag, 2)
}
const [outDir, prefixArg] = argv
const prefixes = (prefixArg ?? '').split(',').map(entry => entry.trim()).filter(Boolean)

if (outDir === undefined) {
  console.error('usage: node extract-asar.js <out-dir> [prefix,...] [--asar <path>]')
  console.error('example: node extract-asar.js ./out dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/')
  process.exit(2)
}
if (!fs.existsSync(asarPath)) {
  console.error(`app.asar not found: ${asarPath}`)
  console.error('pass --asar <path> to point at another installation.')
  process.exit(2)
}

const fd = fs.openSync(asarPath, 'r')
let written = 0
let bytes = 0
try {
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const jsonSize = head.readUInt32LE(12)
  const headerJson = Buffer.alloc(jsonSize)
  fs.readSync(fd, headerJson, 0, jsonSize, 16)
  const index = JSON.parse(headerJson.toString('utf8'))
  const base = 8 + headerSize

  const walk = (element, prefix) => {
    for (const [name, node] of Object.entries(element.files ?? {})) {
      const full = prefix + name
      if (node.files !== undefined) { walk(node, full + '/'); continue }
      if (prefixes.length > 0 && !prefixes.some(candidate => full.startsWith(candidate))) continue
      if (node.unpacked === true) continue // lives in app.asar.unpacked, not in this archive
      const target = path.join(outDir, full)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const size = Number(node.size)
      const buffer = Buffer.alloc(size)
      if (size > 0) fs.readSync(fd, buffer, 0, size, base + Number(node.offset))
      fs.writeFileSync(target, buffer)
      written++
      bytes += size
    }
  }
  walk(index, '')
} finally {
  fs.closeSync(fd)
}

console.log(`extracted ${written} file(s), ${(bytes / 1048576).toFixed(1)} MB -> ${outDir}`)
if (written === 0) {
  console.error('nothing matched; check the prefix against the archive layout (node extract-asar.js ./out "dsh/")')
  process.exitCode = 1
}
