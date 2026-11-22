import sharp from "sharp"

const MAX_INPUT_BYTES = 16 * 1024 * 1024
const MAX_OUTPUT_BYTES = 512 * 1024
const MAX_INPUT_PIXELS = 16_000_000

const readInput = async (): Promise<Buffer> => {
  const chunks: Array<Buffer> = []
  let total = 0
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += value.byteLength
    if (total > MAX_INPUT_BYTES) throw new Error("thumbnail input exceeds the limit")
    chunks.push(value)
  }
  return Buffer.concat(chunks, total)
}

try {
  const input = await readInput()
  const output = await sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true,
    failOn: "error"
  })
    .rotate()
    .resize({ width: 320, height: 480, fit: "cover", position: "attention" })
    .flatten({ background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .webp({ quality: 82, effort: 4 })
    .toBuffer()

  if (output.byteLength === 0 || output.byteLength > MAX_OUTPUT_BYTES) {
    throw new Error("thumbnail output exceeds the limit")
  }
  process.stdout.write(output)
} catch {
  process.exitCode = 1
}
