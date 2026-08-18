import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const writeQueues = new Map<string, Promise<void>>()

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function replaceAtomically(file: string, contents: string | Uint8Array): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temp, contents)
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, file)
      return
    } catch (error) {
      if (attempt >= 4) {
        await unlink(temp).catch(() => undefined)
        throw error
      }
      await delay(30 * (attempt + 1))
    }
  }
}

/** Serializes writes per path and switches files using a same-directory rename. */
export async function atomicWriteFile(file: string, contents: string | Uint8Array): Promise<void> {
  const previous = writeQueues.get(file) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => replaceAtomically(file, contents))
  writeQueues.set(file, next)
  try {
    await next
  } finally {
    if (writeQueues.get(file) === next) writeQueues.delete(file)
  }
}

export function atomicWriteJson(file: string, value: unknown): Promise<void> {
  return atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`)
}
