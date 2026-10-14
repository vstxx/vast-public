const { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { basename, dirname, join, resolve } = require('node:path')
const { windowsSdkTool } = require('./store-msix-tools.cjs')

const taskbarSizes = [16, 20, 24, 30, 32, 36, 40, 44, 48, 60, 64, 72, 80, 96, 256]

function runMakePri(args) {
  const result = spawnSync(windowsSdkTool('MakePri.exe'), args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw new Error(`MakePri ${args[0]} failed: ${result.stderr || result.stdout || result.error?.message || result.status}`)
  }
}

function withPriWorkspace(callback) {
  const workspace = mkdtempSync(join(tmpdir(), 'vast-store-pri-'))
  try {
    return callback(workspace)
  } finally {
    if (dirname(resolve(workspace)) !== resolve(tmpdir()) || !basename(workspace).startsWith('vast-store-pri-')) {
      throw new Error('Refusing to remove an unexpected Store PRI workspace.')
    }
    rmSync(workspace, { recursive: true, force: true })
  }
}

function verifyStorePri(priPath, identityName) {
  if (!existsSync(priPath)) throw new Error('Store MSIX is missing resources.pri; Windows may plate the taskbar icon.')
  return withPriWorkspace((workspace) => {
    const dumpPath = join(workspace, 'resources.xml')
    runMakePri(['dump', '/if', priPath, '/of', dumpPath, '/dt', 'detailed', '/o'])
    const dump = readFileSync(dumpPath, 'utf8')
    if (!dump.includes(`<ResourceMap name="${identityName}" primary="true"`)) {
      throw new Error('Store PRI resource map does not match the MSIX identity.')
    }
    if (!dump.includes('<NamedResource name="Square44x44Logo.png"')) {
      throw new Error('Store PRI does not index the taskbar icon.')
    }
    if (!dump.includes('<Qualifier name="AlternateForm" value="UNPLATED"')) {
      throw new Error('Store PRI does not index unplated taskbar variants.')
    }
    for (const size of taskbarSizes) {
      if (!dump.includes(`<Value>Assets\\Square44x44Logo.targetsize-${size}_altform-unplated.png</Value>`)) {
        throw new Error(`Store PRI does not index the ${size}px unplated taskbar icon.`)
      }
    }
  })
}

function generateStorePri(stagingRoot, identityName) {
  withPriWorkspace((workspace) => {
    copyFileSync(join(stagingRoot, 'AppxManifest.xml'), join(workspace, 'AppxManifest.xml'))
    cpSync(join(stagingRoot, 'Assets'), join(workspace, 'Assets'), { recursive: true })
    const config = join(workspace, 'priconfig.xml')
    const pri = join(workspace, 'resources.pri')
    runMakePri(['createconfig', '/cf', config, '/dq', 'en-US', '/o'])
    runMakePri(['new', '/pr', workspace, '/cf', config, '/of', pri, '/o'])
    verifyStorePri(pri, identityName)
    copyFileSync(pri, join(stagingRoot, 'resources.pri'))
  })
}

module.exports = { generateStorePri, verifyStorePri }
