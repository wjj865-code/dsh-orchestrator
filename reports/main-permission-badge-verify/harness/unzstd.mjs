// Decompress DSH's multi-frame JSONL zstd log by splitting on the zstd magic number.
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [input, output] = process.argv.slice(2)
const buf = readFileSync(input)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
for (let i = 0; i + 4 <= buf.length; i += 1) {
  if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) starts.push(i)
}
const chunks = []
for (let i = 0; i < starts.length; i += 1) {
  const end = i + 1 < starts.length ? starts[i + 1] : buf.length
  try {
    chunks.push(zstdDecompressSync(buf.subarray(starts[i], end)))
  } catch (error) {
    console.error(`frame ${i} at ${starts[i]} failed: ${error.message}`)
  }
}
const text = Buffer.concat(chunks).toString('utf8')
writeFileSync(output, text, 'utf8')
console.log(JSON.stringify({ frames: starts.length, decoded: chunks.length, bytes: text.length, lines: text.split('\n').filter(Boolean).length }))
