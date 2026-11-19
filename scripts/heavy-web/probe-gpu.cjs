#!/usr/bin/env node
// Records, per target: active GPU device, feature status (software fallback),
// WebGL renderer, WebGPU adapters per powerPreference, hardwareConcurrency
// seen by the page and its workers, and the GPU process command line.
// Usage: node scripts/heavy-web/probe-gpu.cjs [--targets=vast,chrome,min-window,min-webview] [--vast=<Vast.exe>] [--out=<file>]
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const { close, launch, startFixtureServer, wait } = require('./lib.cjs')

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')))
const targets = (args.targets || 'vast,chrome,min-window,min-webview').split(',')

function gpuProcessCommandLine(rootPid) {
  const script = `$all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine; $ids = @(${rootPid}); $changed = $true; while ($changed) { $changed = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $changed = $true } } }; ($all | Where-Object { $ids -contains $_.ProcessId -and $_.CommandLine -match '--type=gpu-process' } | Select-Object -First 1).CommandLine`
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim()
}

async function main() {
  const { server, base } = await startFixtureServer()
  const report = { createdAt: new Date().toISOString(), base, targets: {} }
  try {
    for (const kind of targets) {
      const handle = await launch(kind, `${base}/webgpu.html?particles=200000`, { executable: kind === 'vast' ? args.vast : undefined })
      try {
        await wait(2500)
        const fixture = await handle.page.evaluate('(async () => { for (let i = 0; i < 100 && !window.__fixture?.ready && !window.__fixture?.error; i++) await new Promise((r) => setTimeout(r, 100)); return window.__fixture })()')
        const webgl = await handle.page.evaluate(`(() => { const gl = document.createElement('canvas').getContext('webgl2'); const d = gl && gl.getExtension('WEBGL_debug_renderer_info'); return gl ? { renderer: gl.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : gl.RENDERER), vendor: gl.getParameter(d ? d.UNMASKED_VENDOR_WEBGL : gl.VENDOR), maskedRenderer: gl.getParameter(gl.RENDERER) } : null })()`)
        const workerHc = await handle.page.evaluate(`new Promise((resolve) => { const w = new Worker(URL.createObjectURL(new Blob(['postMessage(navigator.hardwareConcurrency)'], { type: 'text/javascript' }))); w.onmessage = (e) => { resolve(e.data); w.terminate() } })`)
        const info = await handle.browser.send('SystemInfo.getInfo').catch((error) => ({ error: error.message }))
        report.targets[kind] = {
          product: handle.version.Browser, userAgent: handle.version['User-Agent'],
          hardwareConcurrency: { page: fixture.hardwareConcurrency, worker: workerHc },
          webgpu: { adapters: fixture.adapters, error: fixture.error },
          webgl,
          gpuDevices: info.gpu?.devices, featureStatus: info.gpu?.featureStatus, driverBugWorkarounds: info.gpu?.driverBugWorkarounds,
          auxAttributes: info.gpu && { optimus: info.gpu.auxAttributes?.optimus, amdSwitchable: info.gpu.auxAttributes?.amdSwitchable, inProcessGpu: info.gpu.auxAttributes?.inProcessGpu, passthroughCmdDecoder: info.gpu.auxAttributes?.passthroughCmdDecoder, gpuProcessCrashCount: info.gpu.auxAttributes?.gpuProcessCrashCount, glImplementationParts: info.gpu.auxAttributes?.glImplementationParts, displayType: info.gpu.auxAttributes?.displayType },
          gpuProcessCommandLine: gpuProcessCommandLine(handle.child.pid)
        }
        console.log(`${kind}: WebGL ${webgl?.renderer} | WebGPU default ${fixture.adapters?.default?.vendor}/${fixture.adapters?.default?.architecture} high-perf ${fixture.adapters?.['high-performance']?.vendor}/${fixture.adapters?.['high-performance']?.architecture} | hc ${fixture.hardwareConcurrency}/${workerHc}`)
      } finally {
        await close(handle)
      }
    }
  } finally {
    server.close()
  }
  const out = args.out || 'heavy-web-gpu-probe.json'
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  console.log(`wrote ${out}`)
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
