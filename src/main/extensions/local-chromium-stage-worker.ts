import { parentPort, workerData } from 'node:worker_threads'
import { stageLocalChromiumDirectory, verifyLocalChromiumCopy } from './local-chromium-stage.ts'
import { resolveChromiumExtensionDirectory } from '../import/chromium-extension-discovery.ts'

if (!parentPort) throw new Error('Local Chromium stage requires a worker parent.')
const port = parentPort
const request = workerData as {
  action?: 'verify' | 'stage-profile'
  contentRoot?: string
  fingerprint?: string
  profilePath?: string
  sourceExtensionId?: string
  expectedVersion?: string
  stagingRoot?: string
}
const work = request.action === 'verify'
  ? verifyLocalChromiumCopy(String(request.contentRoot), String(request.fingerprint), new AbortController().signal).then(() => undefined)
  : request.action === 'stage-profile'
    ? resolveChromiumExtensionDirectory(String(request.profilePath), String(request.sourceExtensionId),
      String(request.expectedVersion), String(request.fingerprint)).then((sourceRoot) =>
      stageLocalChromiumDirectory({ sourceRoot, sourceExtensionId: String(request.sourceExtensionId),
        expectedVersion: String(request.expectedVersion), stagingRoot: String(request.stagingRoot) }, new AbortController().signal))
    : stageLocalChromiumDirectory(workerData as Parameters<typeof stageLocalChromiumDirectory>[0], new AbortController().signal)
void work.then(
  (stage) => port.postMessage({ ok: true, stage }),
  (error: unknown) => port.postMessage({ ok: false, error: error instanceof Error ? error.message.slice(0, 512) : 'Extension staging failed.' })
)
