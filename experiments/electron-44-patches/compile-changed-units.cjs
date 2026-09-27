// Fast syntax check of modified Electron/Chromium translation units. Run from
// anywhere after `gn gen out/VastCompat`; no full Ninja dependency scan.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const src = process.env.VAST_ELECTRON_SRC || 'D:\\VastElectron44\\src';
const out = path.join(src, 'out', 'VastCompat');
const ninja = fs.readFileSync(path.join(out, 'obj', 'electron', 'electron_lib.ninja'), 'utf8');
const vars = Object.fromEntries(
  [...ninja.matchAll(/^([a-z_]+) = (.*)$/gm)].map((match) => [match[1], match[2]]),
);
const compiler = path.join(src, 'third_party', 'llvm-build', 'Release+Asserts', 'bin', 'clang-cl.exe');
const windowsIncludes = [
  'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Tools\\MSVC\\14.51.36231\\include',
  'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Tools\\MSVC\\14.51.36231\\ATLMFC\\include',
  'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Auxiliary\\VS\\include',
  ...['ucrt', 'um', 'shared', 'winrt', 'cppwinrt'].map((part) =>
    `C:\\Program Files (x86)\\Windows Kits\\10\\include\\10.0.26100.0\\${part}`),
];
const allSources = [
  'shell/browser/electron_browser_client.cc',
  'shell/browser/extensions/electron_extension_loader.cc',
  'shell/browser/extensions/electron_extension_system.cc',
  'shell/browser/net/proxying_url_loader_factory.cc',
  'shell/browser/net/proxying_websocket.cc',
  'shell/browser/login_handler.cc',
  'shell/browser/api/electron_api_web_request.cc',
  'shell/browser/api/electron_api_extensions.cc',
  'shell/browser/extensions/api/extension_action/extension_action_api.cc',
  'extensions/browser/extension_navigation_throttle.cc',
  'extensions/browser/events/lazy_event_dispatch_util.cc',
];
const sources = process.argv.length > 2
  ? allSources.filter((source) => process.argv.slice(2).some((name) => source.endsWith(name)))
  : allSources;
if (sources.length === 0) throw new Error('No matching source files');
const requiredGenerated = [
  'chrome/common/buildflags.h',
  'extensions/common/api/types.h',
  'extensions/common/mojom/manifest.mojom-shared.h',
];
const missingGenerated = requiredGenerated.filter((name) =>
  !fs.existsSync(path.join(out, 'gen', name)));
if (missingGenerated.length > 0) {
  console.error('Generated headers are missing; complete their GN actions first:');
  for (const name of missingGenerated) console.error(`  gen/${name}`);
  process.exit(2);
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-electron-syntax-'));
let failed = false;
for (const source of sources) {
  const rsp = path.join(scratch, `${path.basename(source)}.rsp`);
  const flags = [
    '/Zs /nologo /TP',
    ...windowsIncludes.map((include) => `"-imsvc${include}"`),
    vars.defines,
    vars.include_dirs,
    vars.cflags,
    vars.cflags_cc,
    `"-fmodule-name=${vars.cc_module_name}_Private"`,
    `"../../${source.startsWith('extensions/') ? '' : 'electron/'}${source}"`,
  ];
  // GN uses Ninja's '$ ' escape in paths; clang response files use plain space.
  fs.writeFileSync(rsp, flags.join('\n').replace(/\$ /g, ' ').replace(/\$:/g, ':'));
  process.stdout.write(`Checking ${source}\n`);
  const result = cp.spawnSync(compiler, [`@${rsp}`], {
    cwd: out,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) console.error(result.error);
  if (result.status !== 0) {
    failed = true;
    break;
  }
}
process.stdout.write(`Response files: ${scratch}\n`);
process.exitCode = failed ? 1 : 0;
