import { describe, expect, it } from 'vitest'
import { MAX_CHECKIN_BODY_BYTES } from '../src/shared/constants'
import publicWorker from '../src/public/index'
import {
  validateAssetId,
  validateBroadcastInput,
  validateCheckin,
  validateSemVer,
  validateUuid
} from '../src/shared/validation'
import { publicBindings } from './helpers'

const validCheckin = {
  protocol: 1,
  install_id: 'b2b65f31-4c31-4da3-9c2c-e5d28f8ca130',
  current_version: '0.1.4',
  launch_count: 12,
  instance_kind: 'test'
}

describe('protocol validation', () => {
  it('accepts the deliberately small exact schema', () => {
    expect(validateCheckin(validCheckin)).toEqual(validCheckin)
    expect(validateCheckin((({ instance_kind: _kind, ...legacy }) => legacy)(validCheckin))).toMatchObject({
      instance_kind: 'unknown'
    })
  })

  it('rejects unsupported protocols, nested/unexpected data and abnormal counts', () => {
    expect(() => validateCheckin({ ...validCheckin, protocol: 2 })).toThrow(/Unsupported/)
    expect(() => validateCheckin({ ...validCheckin, extra: { prototype: true } })).toThrow(/unexpected/)
    expect(() => validateCheckin({ ...validCheckin, launch_count: -1 })).toThrow(/bounded/)
    expect(() => validateCheckin({ ...validCheckin, launch_count: 2_147_483_648 })).toThrow(/bounded/)
    expect(() => validateCheckin({ ...validCheckin, instance_kind: 'automation-ish' })).toThrow(/instance_kind/)
  })

  it('validates RFC UUIDs and rejects nil, malformed and non-variant UUIDs', () => {
    expect(validateUuid(validCheckin.install_id)).toBe(validCheckin.install_id)
    for (const invalid of [
      '00000000-0000-0000-0000-000000000000',
      'b2b65f31-4c31-4da3-7c2c-e5d28f8ca130',
      '../install',
      'not-a-uuid'
    ]) expect(() => validateUuid(invalid)).toThrow(/UUID/)
  })

  it('uses strict SemVer compatible with Vast 0.1.4', () => {
    for (const valid of ['0.1.4', '1.2.3-beta.1', '2.0.0+build.7']) expect(validateSemVer(valid)).toBe(valid)
    for (const invalid of ['v0.1.4', '1.2', '01.2.3', '1.2.3-01', ' 1.2.3 ']) {
      expect(() => validateSemVer(invalid)).toThrow(/SemVer/)
    }
  })

  it('rejects unknown or active-content broadcast structures', () => {
    const input = {
      type: 'command',
      title: 'Title',
      body: 'Body',
      media_id: null,
      action_label: null,
      action_url: null,
      min_version: null,
      max_version: null,
      active_from: '2026-08-10T10:00:00.000Z',
      active_until: null,
      priority: 1,
      enabled: true
    }
    expect(() => validateBroadcastInput(input)).toThrow(/type/)
    expect(() => validateBroadcastInput({ ...input, type: 'welcome', custom_html: '<b>bad</b>' })).toThrow(/unexpected/)
    expect(validateBroadcastInput({
      ...input,
      type: 'announcement',
      body: '# Heading\n\n> Quote\n\n**Bold** and <b>literal text</b>'
    }).body).toContain('<b>literal text</b>')
  })

  it('rejects traversal and executable asset ids', () => {
    for (const invalid of ['../image.png', 'folder/image.png', 'image.exe', 'image.png/other', 'image.PNG']) {
      expect(() => validateAssetId(invalid)).toThrow(/Asset id/)
    }
  })
})

describe('public HTTP validation', () => {
  it('requires POST and application/json', async () => {
    const method = await publicWorker.fetch(new Request('https://relay.test/v1/checkin'), publicBindings())
    expect(method.status).toBe(405)
    const contentType = await publicWorker.fetch(new Request('https://relay.test/v1/checkin', {
      method: 'POST', body: JSON.stringify(validCheckin), headers: { 'Content-Type': 'text/plain' }
    }), publicBindings())
    expect(contentType.status).toBe(415)
  })

  it('rejects malformed and oversized JSON before database work', async () => {
    const malformed = await publicWorker.fetch(new Request('https://relay.test/v1/checkin', {
      method: 'POST', body: '{bad', headers: { 'Content-Type': 'application/json' }
    }), publicBindings())
    expect(malformed.status).toBe(400)

    const oversized = await publicWorker.fetch(new Request('https://relay.test/v1/checkin', {
      method: 'POST',
      body: 'x'.repeat(MAX_CHECKIN_BODY_BYTES + 1),
      headers: { 'Content-Type': 'application/json' }
    }), publicBindings())
    expect(oversized.status).toBe(413)
  })
})
