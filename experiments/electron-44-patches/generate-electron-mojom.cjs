// Run only the Electron Mojo actions needed by direct syntax preflight.
// Uses the exact commands emitted by the preserved GN output; no clean/build.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const src = process.env.VAST_ELECTRON_SRC || 'D:\\VastElectron44\\src';
const out = path.join(src, 'out', 'VastCompat');
const ninja = fs.readFileSync(path.join(out, 'toolchain.ninja'), 'utf8');
const actions = [
  ['__electron_shell_common_mojo__type_mappings___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/common/mojo__type_mappings'],
  ['__electron_shell_common_mojo__parser_action___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/common/api/api.mojom-module'],
  ['__electron_shell_common_mojo_shared__generator___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/common/api/api.mojom-features.h'],
  ['__electron_shell_common_mojo__generator___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/common/api/api.mojom.h'],
  ['__electron_shell_services_node_public_mojom_mojom__type_mappings___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/services/node/public/mojom/mojom__type_mappings'],
  ['__electron_shell_services_node_public_mojom_mojom__parser_action___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/services/node/public/mojom/node_service.mojom-module'],
  ['__electron_shell_services_node_public_mojom_mojom_shared__generator___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/services/node/public/mojom/node_service.mojom-features.h'],
  ['__electron_shell_services_node_public_mojom_mojom__generator___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/services/node/public/mojom/node_service.mojom.h'],
  ['__electron_shell_common_plugin__type_mappings___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/common/plugin__type_mappings'],
  ['__electron_shell_common_plugin__parser_action___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/common/plugin.mojom-module'],
  ['__electron_shell_common_plugin_shared__generator___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/common/plugin.mojom-features.h'],
  ['__electron_shell_common_plugin__generator___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/common/plugin.mojom.h'],
  ['__electron_shell_common_web_contents_utility__type_mappings___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/common/web_contents_utility__type_mappings'],
  ['__electron_shell_common_web_contents_utility__parser_action___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/common/web_contents_utility.mojom-module'],
  ['__electron_shell_common_web_contents_utility_shared__generator___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/common/web_contents_utility.mojom-features.h'],
  ['__electron_shell_common_web_contents_utility__generator___build_toolchain_win_win_clang_x64__rule', 'gen/electron/shell/common/web_contents_utility.mojom.h'],
  ['__components_spellcheck_common_interfaces__type_mappings___build_toolchain_win_win_clang_x64__rule', 'gen/components/spellcheck/common/interfaces__type_mappings'],
  ['__components_spellcheck_common_interfaces__parser_action___build_toolchain_win_win_clang_x64__rule', 'gen/components/spellcheck/common/spellcheck.mojom-module'],
  ['__components_spellcheck_common_interfaces_shared__generator___build_toolchain_win_win_clang_x64__rule', 'gen/components/spellcheck/common/spellcheck.mojom-features.h'],
  ['__components_spellcheck_common_interfaces__generator___build_toolchain_win_win_clang_x64__rule', 'gen/components/spellcheck/common/spellcheck.mojom.h'],
  ['__components_guest_view_common_mojom__type_mappings___build_toolchain_win_win_clang_x64__rule', 'gen/components/guest_view/common/mojom__type_mappings'],
  ['__components_guest_view_common_mojom__parser_action___build_toolchain_win_win_clang_x64__rule', 'gen/components/guest_view/common/guest_view.mojom-module'],
  ['__components_guest_view_common_mojom_shared__generator___build_toolchain_win_win_clang_x64__rule', 'gen/components/guest_view/common/guest_view.mojom-features.h'],
  ['__components_guest_view_common_mojom__generator___build_toolchain_win_win_clang_x64__rule', 'gen/components/guest_view/common/guest_view.mojom.h'],
  ['__extensions_common_api_mojom__type_mappings___build_toolchain_win_win_clang_x64__rule', 'gen/extensions/common/api/mojom__type_mappings'],
  ['__extensions_common_api_mojom__parser_action___build_toolchain_win_win_clang_x64__rule', 'gen/extensions/common/api/mime_handler.mojom-module'],
  ['__extensions_common_api_mojom_shared__generator___build_toolchain_win_win_clang_x64__rule', 'gen/extensions/common/api/mime_handler.mojom-features.h'],
  ['__extensions_common_api_mojom__generator___build_toolchain_win_win_clang_x64__rule', 'gen/extensions/common/api/mime_handler.mojom.h'],
  ['__components_printing_common_mojo_interfaces__type_mappings___build_toolchain_win_win_clang_x64__rule', 'gen/components/printing/common/mojo_interfaces__type_mappings'],
  ['__components_printing_common_mojo_interfaces__parser_action___build_toolchain_win_win_clang_x64__rule', 'gen/components/printing/common/print.mojom-module'],
  ['__components_printing_common_mojo_interfaces_shared__generator___build_toolchain_win_win_clang_x64__rule', 'gen/components/printing/common/print.mojom-features.h'],
  ['__components_printing_common_mojo_interfaces__generator___build_toolchain_win_win_clang_x64__rule', 'gen/components/printing/common/print.mojom.h'],
  ['__components_enterprise_watermarking_mojom_mojom__type_mappings___build_toolchain_win_win_clang_x64__rule', 'gen/components/enterprise/watermarking/mojom/mojom__type_mappings'],
  ['__components_enterprise_watermarking_mojom_mojom__parser_action___build_toolchain_win_win_clang_x64__rule', 'gen/components/enterprise/watermarking/mojom/watermark.mojom-module'],
  ['__components_enterprise_watermarking_mojom_mojom_shared__generator___build_toolchain_win_win_clang_x64__rule', 'gen/components/enterprise/watermarking/mojom/watermark.mojom-shared-internal.h'],
  ['__components_enterprise_watermarking_mojom_mojom__generator___build_toolchain_win_win_clang_x64__rule', 'gen/components/enterprise/watermarking/mojom/watermark.mojom.h'],
  ['__components_services_print_compositor_public_mojom_mojom__type_mappings___build_toolchain_win_win_clang_x64__rule', 'gen/components/services/print_compositor/public/mojom/mojom__type_mappings'],
  ['__components_services_print_compositor_public_mojom_mojom__parser_action___build_toolchain_win_win_clang_x64__rule', 'gen/components/services/print_compositor/public/mojom/print_compositor.mojom-module'],
  ['__components_services_print_compositor_public_mojom_mojom_shared__generator___build_toolchain_win_win_clang_x64__rule', 'gen/components/services/print_compositor/public/mojom/print_compositor.mojom-features.h'],
  ['__components_services_print_compositor_public_mojom_mojom__generator___build_toolchain_win_win_clang_x64__rule', 'gen/components/services/print_compositor/public/mojom/print_compositor.mojom.h'],
  ['__printing_backend_mojom_mojom__type_mappings___build_toolchain_win_win_clang_x64__rule', 'gen/printing/backend/mojom/mojom__type_mappings'],
  ['__printing_backend_mojom_mojom__parser_action___build_toolchain_win_win_clang_x64__rule', 'gen/printing/backend/mojom/print_backend.mojom-module'],
  ['__printing_mojom_printing_context__type_mappings___build_toolchain_win_win_clang_x64__rule', 'gen/printing/mojom/printing_context__type_mappings'],
  ['__printing_mojom_printing_context__parser_action___build_toolchain_win_win_clang_x64__rule', 'gen/printing/mojom/printing_context.mojom-module'],
  ['__chrome_services_printing_public_mojom_mojom__type_mappings___build_toolchain_win_win_clang_x64__rule', 'gen/chrome/services/printing/public/mojom/mojom__type_mappings'],
  ['__chrome_services_printing_public_mojom_mojom__parser_action___build_toolchain_win_win_clang_x64__rule', 'gen/chrome/services/printing/public/mojom/print_backend_service.mojom-module'],
  ['__chrome_services_printing_public_mojom_mojom_shared__generator___build_toolchain_win_win_clang_x64__rule', 'gen/chrome/services/printing/public/mojom/print_backend_service.mojom-features.h'],
  ['__chrome_services_printing_public_mojom_mojom__generator___build_toolchain_win_win_clang_x64__rule', 'gen/chrome/services/printing/public/mojom/print_backend_service.mojom.h'],
];
for (const [rule, output] of actions) {
  if (fs.existsSync(path.join(out, output))) continue;
  const start = ninja.indexOf(`rule ${rule}\n`);
  if (start < 0) throw new Error(`GN rule missing: ${rule}`);
  const commandStart = ninja.indexOf('  command = ', start) + '  command = '.length;
  const commandEnd = ninja.indexOf('\n', commandStart);
  const command = ninja.slice(commandStart, commandEnd)
    .replace(/\$:/g, ':').replace(/\$ /g, ' ');
  const [program, ...args] = command.trim().split(/\s+/);
  console.log(`Generating ${output}`);
  const result = cp.spawnSync(program, args, { cwd: out, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  if (!fs.existsSync(path.join(out, output))) throw new Error(`Missing generated output: ${output}`);
}
