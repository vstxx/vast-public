import assert from 'node:assert/strict'
import test from 'node:test'

import { parsePasswordImportCsv, passwordCsvCell } from '../../src/shared/password-csv.ts'

test('password CSV import preserves notes and counts incomplete rows as skipped', () => {
  const result = parsePasswordImportCsv(
    '\uFEFFname,url,username,password,note\n' +
      '"Work, Login",https://work.example.com/login,me@example.com,"sec,ret","has, comma"\n' +
      'Missing Password,https://empty.example.com,user,,ignored\n' +
      'Missing URL,,user,secret,ignored\n'
  )

  assert.equal(result.skipped, 2)
  assert.deepEqual(result.items, [
    {
      origin: 'https://work.example.com/login',
      username: 'me@example.com',
      password: 'sec,ret',
      title: 'Work, Login',
      notes: 'has, comma'
    }
  ])
})

test('password CSV import accepts common header aliases', () => {
  const result = parsePasswordImportCsv('title,origin,user,password,notes\nDocs,docs.example.com,owner,secret,"team account"\n')

  assert.equal(result.skipped, 0)
  assert.deepEqual(result.items, [
    {
      origin: 'docs.example.com',
      username: 'owner',
      password: 'secret',
      title: 'Docs',
      notes: 'team account'
    }
  ])
})

test('password CSV import rejects files without required columns', () => {
  assert.throws(() => parsePasswordImportCsv('name,url,password\nNo username,https://example.com,secret\n'), {
    message: 'CSV must include url, username, and password columns.'
  })
})

test('password CSV export neutralizes spreadsheet formulas before quoting', () => {
  assert.equal(passwordCsvCell('=HYPERLINK("https://evil.test")'), '"\'=HYPERLINK(""https://evil.test"")"')
  assert.equal(passwordCsvCell('+SUM(1,1)'), '"\'+SUM(1,1)"')
  assert.equal(passwordCsvCell('-1+2'), '"\'-1+2"')
  assert.equal(passwordCsvCell('@cmd'), '"\'@cmd"')
  assert.equal(passwordCsvCell(' ordinary "value"'), '" ordinary ""value"""')
})
