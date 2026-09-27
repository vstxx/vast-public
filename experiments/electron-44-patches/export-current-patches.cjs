const { spawnSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const sourceRoot = resolve(process.env.VAST_ELECTRON_SRC || 'D:\\VastElectron44\\src')
const outputRoot = __dirname

function exportDiff(cwd, files, output) {
  const result = spawnSync('git', ['diff', '--', ...files], {
    cwd,
    maxBuffer: 20 * 1024 * 1024
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
  }
  writeFileSync(join(outputRoot, output), result.stdout)
  console.log(`${output}: ${result.stdout.length} bytes`)
}

exportDiff(join(sourceRoot, 'electron'), [
  'shell/browser/api/electron_api_web_request.cc',
  'shell/browser/api/electron_api_web_request.h',
  'shell/browser/electron_browser_client.cc',
  'shell/browser/extensions/electron_extension_loader.cc',
  'shell/browser/extensions/electron_extension_loader.h',
  'shell/browser/extensions/electron_extension_system.cc',
  'shell/browser/extensions/electron_extension_system.h',
  'shell/browser/extensions/electron_extension_web_contents_observer.cc',
  'shell/browser/login_handler.cc',
  'shell/browser/login_handler.h',
  'shell/browser/net/proxying_url_loader_factory.cc',
  'shell/browser/net/proxying_url_loader_factory.h',
  'shell/browser/net/proxying_websocket.cc',
  'shell/browser/net/proxying_websocket.h',
  'shell/browser/net/url_loader_factory_gate.cc',
  'shell/browser/net/url_loader_factory_gate.h'
], '0004-electron-composed-webrequest-lifecycle.patch')

exportDiff(sourceRoot, [
  'extensions/browser/extension_navigation_throttle.cc',
  'extensions/browser/api/alarms/alarm_manager.cc',
  'extensions/browser/api/runtime/runtime_api.cc',
  'extensions/browser/api/web_request/web_request_api.h',
  'extensions/browser/events/lazy_event_dispatch_util.cc',
  'extensions/browser/events/lazy_event_dispatch_util.h'
], '0005-chromium-lifecycle-auth-support.patch')
