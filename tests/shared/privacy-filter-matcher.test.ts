import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseNetworkFilterList,
  privacyFilterRulesAllow,
  privacyFilterRulesMatch
} from '../../src/shared/privacy-filter-matcher.ts'

test('hosts and ABP domain rules block domains and their subdomains', () => {
  const rules = parseNetworkFilterList('0.0.0.0 ads.example.com\n||tracker.example^\n')
  assert.equal(privacyFilterRulesMatch(rules, 'https://ads.example.com/banner.js'), true)
  assert.equal(privacyFilterRulesMatch(rules, 'https://img.tracker.example/pixel.gif'), true)
  assert.equal(privacyFilterRulesMatch(rules, 'https://example.com/content.js'), false)
})

test('ABP path rules block only the matching resource, not the whole domain', () => {
  const rules = parseNetworkFilterList('||cdn.example.com/advertising/*.js$script,third-party\n')
  const context = { topLevelUrl: 'https://site.example/', resourceType: 'script' }
  assert.equal(privacyFilterRulesMatch(rules, 'https://cdn.example.com/advertising/home.js', context), true)
  assert.equal(privacyFilterRulesMatch(rules, 'https://cdn.example.com/app/home.js', context), false)
  assert.equal(privacyFilterRulesMatch(rules, 'https://cdn.example.com/advertising/home.js', { ...context, resourceType: 'image' }), false)
  assert.equal(privacyFilterRulesMatch(rules, 'https://cdn.example.com/advertising/home.js', { topLevelUrl: 'https://cdn.example.com/', resourceType: 'script' }), false)
})

test('domain and path exceptions override blocked rules', () => {
  const rules = parseNetworkFilterList([
    '||tracker.example^',
    '@@||safe.tracker.example^',
    '*/sponsor/*',
    '@@||site.example/sponsor/allowed.js'
  ].join('\n'))
  assert.equal(privacyFilterRulesMatch(rules, 'https://safe.tracker.example/pixel'), false)
  assert.equal(privacyFilterRulesAllow(rules, 'https://site.example/sponsor/allowed.js'), true)
  assert.equal(privacyFilterRulesMatch(rules, 'https://site.example/sponsor/other.js'), true)
})

test('cosmetic filters and short generic fragments are not treated as network rules', () => {
  const rules = parseNetworkFilterList('example.com##.advert\n/ad/\n')
  assert.equal(privacyFilterRulesMatch(rules, 'https://example.com/ad/page.js'), false)
})

test('scoped image rules do not blank Google Images CDN thumbnails', () => {
  const rules = parseNetworkFilterList('*/images*$image,third-party,domain=publisher.example\n')
  const thumbnail = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:sample'
  assert.equal(privacyFilterRulesMatch(rules, thumbnail, {
    topLevelUrl: 'https://www.google.com/search?q=test&udm=2',
    resourceType: 'image'
  }), false)
  assert.equal(privacyFilterRulesMatch(rules, thumbnail, {
    topLevelUrl: 'https://publisher.example/gallery',
    resourceType: 'image'
  }), true)
})

test('unsupported modifier rules are not widened into request cancellation', () => {
  const rules = parseNetworkFilterList([
    '||cdn.example.com/resource$redirect=noop.js',
    '|http*://*?$popup,third-party,domain=publisher.example'
  ].join('\n'))
  assert.equal(privacyFilterRulesMatch(rules, 'https://cdn.example.com/resource', {
    topLevelUrl: 'https://site.example/', resourceType: 'script'
  }), false)
  assert.equal(privacyFilterRulesMatch(rules, 'https://encrypted-tbn0.gstatic.com/images?q=tbn:sample', {
    topLevelUrl: 'https://www.google.com/search?q=test&udm=2', resourceType: 'image'
  }), false)
})
