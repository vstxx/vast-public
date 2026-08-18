import { readFile } from 'node:fs/promises'

const transientReadErrorCodes = new Set(['EBUSY', 'EACCES', 'EPERM', 'EMFILE'])

type ReadUtf8 = (path: string) => Promise<string>

interface ReadTextWithRetryOptions {
  attempts?: number
  read?: ReadUtf8
  wait?: (ms: number) => Promise<void>
}

export function isTransientStorageReadError(error: unknown): boolean {
  return transientReadErrorCodes.has((error as NodeJS.ErrnoException).code ?? '')
}

export async function readTextWithRetry(
  path: string,
  options: ReadTextWithRetryOptions = {}
): Promise<string> {
  const attempts = Math.max(1, options.attempts ?? 5)
  const read = options.read ?? ((target) => readFile(target, 'utf8'))
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read(path)
    } catch (error) {
      if (!isTransientStorageReadError(error) || attempt >= attempts - 1) throw error
      await wait(40 * 2 ** attempt)
    }
  }
}
