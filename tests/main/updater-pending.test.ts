import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pendingStartupDecision, pendingUpdatePath, readPendingUpdate, stagePendingUpdate, updateCacheKey, validPendingUpdate } from '../../src/main/updater-pending.ts'

test('a prepared update survives offline startup; successful installation removes its marker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vast-pending-'))
  t.after(() => rm(root, { recursive:true, force:true }))
  const executable = join(root,'install','Vast.exe')
  const profile = join(root,'custom profile')
  const cacheRoot = join(root,'cache')
  const source = join(root,'helper.ps1')
  await writeFile(source,'# test helper')
  const record = { version:'0.2.8',executable,installer:join(cacheRoot,'vast-update-'+updateCacheKey(executable,profile),'pending','setup.exe'),sha512:Buffer.alloc(64).toString('base64'),automatic:true }
  await stagePendingUpdate(record,profile,source)
  const options = {executable,profile,cacheRoot,currentVersion:'0.2.7',skipOnce:false}
  assert.equal((await pendingStartupDecision(options))?.version,'0.2.8')
  assert.equal(await pendingStartupDecision({...options,skipOnce:true}),undefined,'failed handoff cannot create a launch loop')
  assert.equal(await pendingStartupDecision({...options,currentVersion:'0.2.8'}),undefined)
  assert.equal(await readPendingUpdate(pendingUpdatePath(executable,profile)),undefined)
})

test('repeated feed checks preserve failed attempt count and opt-out', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vast-pending-'))
  t.after(() => rm(root, { recursive:true, force:true }))
  const executable = join(root,'Vast.exe'), profile = join(root,'profile'), cacheRoot = join(root,'cache')
  const source = join(root,'helper.ps1')
  await writeFile(source,'# fixture')
  const record = {version:'0.2.8',executable,installer:join(cacheRoot,'vast-update-'+updateCacheKey(executable,profile),'pending','setup.exe'),sha512:Buffer.alloc(64).toString('base64'),automatic:true}
  await stagePendingUpdate(record,profile,source)
  const file = pendingUpdatePath(executable,profile)
  await writeFile(file,'\uFEFF'+JSON.stringify({...record,attempts:3}))
  await stagePendingUpdate(record,profile,source)
  assert.equal(JSON.parse(await readFile(file,'utf8')).attempts,3)
  const options = {executable,profile,cacheRoot,currentVersion:'0.2.7',skipOnce:false}
  assert.equal(await pendingStartupDecision(options),undefined)
  await stagePendingUpdate({...record,version:'0.2.9',automatic:false},profile,source)
  assert.equal(await pendingStartupDecision(options),undefined)
  await stagePendingUpdate({...record,version:'0.2.9',automatic:true},profile,source)
  assert.equal((await pendingStartupDecision(options))?.version,'0.2.9')
})

test('pending metadata cannot select another installation or a file outside its own cache', () => {
  const executable = join(tmpdir(),'Vast.exe'), profile = join(tmpdir(),'profile'), cacheRoot = join(tmpdir(),'cache')
  const record = {version:'0.2.8',executable,installer:join(cacheRoot,'vast-update-'+updateCacheKey(executable,profile),'pending','setup.exe'),sha512:Buffer.alloc(64).toString('base64'),automatic:true,attempts:0}
  assert.equal(validPendingUpdate(record,executable,profile,cacheRoot),true)
  for (const patch of [{executable:join(tmpdir(),'other.exe')},{installer:join(cacheRoot,'other.exe')},{sha512:'bad'},{version:'invalid'},{attempts:-1},{attempts:4},{automatic:'true'}]) {
    assert.equal(validPendingUpdate({...record,...patch},executable,profile,cacheRoot),false)
  }
})
