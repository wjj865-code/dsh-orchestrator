// Read-only asar extractor: node asar-extract.mjs <inner-path> <out-file> | --list <substring>
import { openSync, readSync } from 'node:fs'
import { writeFileSync } from 'node:fs'

const ASAR = 'C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const fd = openSync(ASAR, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerSize)
readSync(fd, headerBuf, 0, headerSize, 16)
const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''))
const baseOffset = 8 + head.readUInt32LE(4)

const lookup = innerPath => {
  const parts = innerPath.replace(/\\/g, '/').replace(/^\//, '').split('/')
  let node = header
  for (const part of parts) {
    if (!node?.files?.[part]) return undefined
    node = node.files[part]
  }
  return node
}
const readFile = node => {
  const offset = Number(node.offset)
  const buf = Buffer.alloc(node.size)
  readSync(fd, buf, 0, node.size, baseOffset + offset)
  return buf
}

const [, , a, b] = process.argv
if (a === '--list') {
  const hits = []
  const walk = (node, prefix) => {
    if (!node?.files) return
    for (const [name, child] of Object.entries(node.files)) {
      const path = `${prefix}/${name}`
      if (path.includes(b)) hits.push(`${path}${child.files ? '/' : ` (${child.size})`}`)
      if (child.files) walk(child, path)
    }
  }
  walk(header, '')
  console.log(hits.slice(0, 100).join('\n'))
} else {
  const node = lookup(a)
  if (node === undefined || node.files) {
    console.error('not a file:', a)
    process.exit(1)
  }
  writeFileSync(b, readFile(node))
  console.log('wrote', b, node.size)
}
