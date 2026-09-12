# Corresponding resource source

`src/` and `LICENSE.txt` are unmodified selected files from uBlock Origin 1.74.0,
commit `6dd2d95e50d134a477a4e183343c0b26e9147123`. This includes the complete
dependency closure of the scriptlet registry and the web-accessible surrogates.
`provenance.json` records individual SHA-256 hashes and the source repository.
The complete upstream tree is available at:
https://github.com/gorhill/uBlock/tree/6dd2d95e50d134a477a4e183343c0b26e9147123

To reproduce the shipped library, use Node 24 and the Vast source distribution:

1. `npm ci` at the Vast repository root.
2. `node resources/first-party-extensions/adblocker-for-vast/assets/source/compile-adblock-resources.mjs --check` compares the generated
   bytes with `resources/first-party-extensions/adblocker-for-vast/assets/resources.json` without changing either.
3. Omit `--check` to regenerate the JSON and its integrity manifest offline.

The generator is included in this directory and uses relative asset paths.
It uses `@ghostery/adblocker` 2.18.2 only to validate output.

Conversion preserves readable function bodies and dependencies without
minification. It excludes scriptlets marked `requiresTrust`, because the
selected engine API does not enforce upstream trusted-list semantics.
Every JavaScript redirect body comes from the included original source.
`upstream-resources.json` extracts alias/MIME metadata and fully represented
synthetic MIME stubs, excluding unused compiled script bodies; its immutable
Ghostery source URL, original hash, transformation and extracted-file hash are recorded
in `provenance.json`. No executable resource is downloaded by the browser.

To update the source, review a new upstream release, replace the same source
files and any new relative-import dependencies, update their manifest hashes
and immutable commit, then regenerate, run asset verification and the adblock
unit/Electron tests. Ordinary list updates do not modify this directory.

The GPL notices in the original files remain applicable. The generator is
original Vast integration code. Keep this source directory, generator, license
and source notices in distributions containing the generated library.
