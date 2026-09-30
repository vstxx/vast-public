const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { workerData } = require('node:worker_threads')

const snapshot = join(workerData.stagingRoot, 'snapshot-hanging')
mkdirSync(snapshot, { recursive: true })
writeFileSync(join(snapshot, 'marker'), 'staged')
setInterval(() => undefined, 1000)
