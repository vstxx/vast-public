const { readFileSync, writeFileSync } = require('node:fs');

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  throw new Error('Usage: node filter-testonly-updater-cipd.cjs <gclient.ensure> <filtered.ensure>');
}

const source = readFileSync(input, 'utf8');
const lines = source.split(/\r?\n/);
const kept = [];
const removed = [];
for (let index = 0; index < lines.length; index++) {
  const line = lines[index];
  const match = /^@Subdir (src\/third_party\/updater\/[^/]+\/cipd)$/.exec(line);
  if (!match) {
    kept.push(line);
    continue;
  }
  const packageLine = lines[index + 1];
  if (!/^chromium\/third_party\/updater\/\S+ \S+$/.test(packageLine || '')) {
    throw new Error(`Unexpected package after ${match[1]}: ${packageLine}`);
  }
  removed.push(match[1]);
  index++;
  if (lines[index + 1] === '') index++;
}

if (removed.length !== 12 || !removed.every((path) => /\/(?:chrome|chromium)_win_/.test(path))) {
  throw new Error(`Expected exactly 12 Windows old_updater test packages; found ${removed.length}: ${removed.join(', ')}`);
}
const filtered = kept.join('\n');
if (filtered.includes('@Subdir src/third_party/updater/')) {
  throw new Error('An updater package remains in the filtered ensure file');
}
writeFileSync(output, filtered);
process.stdout.write(`Removed ${removed.length} test-only updater packages; retained ${kept.filter((line) => line.startsWith('@Subdir ')).length} CIPD entries.\n`);
