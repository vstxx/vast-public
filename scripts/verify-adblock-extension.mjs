import assert from 'node:assert/strict'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, relative, dirname, sep } from 'node:path'
import { validatePublisherPackage } from '../extensions-hub/src/validation.ts'
const root=resolve('resources/first-party-extensions/adblocker-for-vast')
const archive=resolve(process.argv[2] ?? 'artifacts/Adblocker-for-Vast-1.1.0.vext')
const bytes=new Uint8Array(await readFile(archive))
const summary=await validatePublisherPackage(bytes,'ighghepofocdonohadbmkbgmphppdagk','publisher_7b1e2c9f4a806d3e5b709c12')
const manifest=JSON.parse(new TextDecoder().decode(summary.parsed.files.get('manifest.json')))
assert.equal(manifest.name,'Adblocker for Vast');assert.equal(manifest.version,'1.1.0')
assert.equal(manifest.key,JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8')).key)
const id=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,x=>String.fromCharCode(97+parseInt(x,16)))
assert.equal(id,'ighghepofocdonohadbmkbgmphppdagk')
assert(summary.permissions.chrome.includes('vast.documentRules'))
const expected=[]
async function walk(directory) { for(const entry of await readdir(directory,{withFileTypes:true})) {const path=resolve(directory,entry.name);if(entry.isDirectory())await walk(path);else if(entry.isFile())expected.push(relative(root,path).split(sep).join('/'));else throw Error('Unexpected filesystem entry')} }
await walk(root)
assert.deepEqual([...summary.parsed.files.keys()].sort(),expected.sort(),'Archive inventory differs from reviewed source')
for(const [name,content] of summary.parsed.files) {
  assert(!/(?:^|\/)(?:node_modules|\.git|\.env)(?:\/|$)|\.(?:exe|dll|node|map|pfx|p12|pem|key)$/i.test(name),'Unexpected runtime/private file: '+name)
  assert(Buffer.from(content).equals(await readFile(resolve(root,name))), 'Stale packaged bytes: '+name)
  if(/\.(?:js|mjs|ts|html|json|txt|md|css)$/i.test(name)) {
    const text=new TextDecoder().decode(content)
    assert(!/[A-Za-z]:[\\/]Users[\\/]|[A-Za-z]:[\\/]All Side Files[\\/]|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|approvedRule/.test(text),'Local path, private key or test fixture in '+name)
  }
}
for(const name of ['assets/THIRD-PARTY-NOTICES.txt','assets/DEPENDENCY-LICENSES.txt','assets/GPL-3.0.txt','assets/MPL-2.0.txt','assets/CC-BY-3.0.txt','assets/source/provenance.json','assets/resources-safe.json','assets/resources-trusted.json']) assert(summary.parsed.files.has(name),'Missing required notice/resource: '+name)
const provenance=JSON.parse(new TextDecoder().decode(summary.parsed.files.get('assets/provenance.json')))
for(const file of provenance.files) { const content=summary.parsed.files.get('assets/'+file.name);assert(content,'Missing provenance file '+file.name);assert.equal(content.length,file.bytes);assert.equal(createHash('sha256').update(content).digest('hex'),file.sha256,'Provenance hash '+file.name) }
if(process.argv[3]) {
  const destination=resolve(process.argv[3],'resources/first-party-extensions/adblocker-for-vast')
  for(const [name,content] of summary.parsed.files) {const target=resolve(destination,name);assert(target.startsWith(destination+sep));await mkdir(dirname(target),{recursive:true});await writeFile(target,content)}
}
console.log(JSON.stringify({archive,name:manifest.name,version:manifest.version,extensionId:id,files:summary.parsed.files.size,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),keyPreserved:true,validation:summary.validation},null,2))
