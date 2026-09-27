const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const result = JSON.parse(readFileSync(join(__dirname, 'results', 'ece-production-mv3.json'), 'utf8'))
const functional = result.reports.filter((entry) => entry.from === 'sw').at(-1)?.data?.functional

assert.equal(result.completed, true)
assert.deepEqual(functional?.permissionsContainsRequiredOriginSubset, { ok: true, result: true })
assert.deepEqual(functional?.permissionsRequestRequiredOrigin, { ok: true, result: true })
assert.deepEqual(functional?.permissionsRequest, { ok: true, result: true })
assert.deepEqual(functional?.permissionsRemove, { ok: true, result: true })
const workerRuns = result.reports.filter((entry) => entry.from === 'sw').length
const addedEvents = result.reports.filter((entry) => entry.from === 'permissions-onAdded')
const removedEvents = result.reports.filter((entry) => entry.from === 'permissions-onRemoved')
assert.equal(addedEvents.length, workerRuns)
assert.equal(removedEvents.length, workerRuns)
assert.ok(addedEvents.every((entry) => JSON.stringify(entry.data) === JSON.stringify({ permissions: ['bookmarks'], origins: [] })))
assert.ok(removedEvents.every((entry) => JSON.stringify(entry.data) === JSON.stringify({ permissions: ['bookmarks'], origins: [] })))

console.log('ECE permissions semantics verified: required grants are successful no-ops; optional grants still dispatch exactly once.')
