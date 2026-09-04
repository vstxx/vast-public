import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { DEFAULT_SETTINGS } from '../../src/shared/constants.ts'
import {
  assertIpcFeatureAllowed,
  assertSensitiveIpcRegistrationComplete,
  PASSWORD_VAULT_IPC_ACCESS,
  requiredFeatureForIpcChannel,
  SENSITIVE_IPC_FEATURES,
  vaultAccessForIpcChannel
} from '../../src/main/ipc-feature-policy.ts'
import { settingsAllowedByRuntimeFeaturePolicy } from '../../src/main/runtime-feature-policy.ts'

const VastFeatures = {
  Avidae: 'avidae',
  NetworkDevices: 'network-devices',
  PasswordManager: 'password-manager',
  AdvancedDiagnostics: 'advanced-diagnostics'
} as const

const expectedSensitiveHandlers = {
  [VastFeatures.Avidae]: [
    'vast:avidae:status', 'vast:avidae:start', 'vast:avidae:stop', 'vast:avidae:install-dependencies'
  ],
  [VastFeatures.NetworkDevices]: [
    'vast:network:get-devices', 'vast:network:scan', 'vast:network:update-device',
    'vast:network:forget-device', 'vast:network:clear-cache', 'vast:network:export-inventory'
  ],
  [VastFeatures.PasswordManager]: [
    'vast:passwords:session-status', 'vast:passwords:unlock-session', 'vast:passwords:lock-session',
    'vast:passwords:list', 'vast:passwords:create', 'vast:passwords:update', 'vast:passwords:remove',
    'vast:passwords:copy-username', 'vast:passwords:copy-password', 'vast:passwords:autofill',
    'vast:passwords:autofill-suggestions', 'vast:passwords:fill-by-id', 'vast:passwords:save-captured',
    'vast:passwords:capture-status', 'vast:passwords:resolve-save-prompt', 'vast:passwords:allow-save-prompts',
    'vast:passwords:import-csv', 'vast:passwords:export-csv', 'vast:passwords:audit'
  ],
  [VastFeatures.AdvancedDiagnostics]: ['vast:app:diagnostics', 'vast:app:process-metrics']
} as const

function registeredSensitiveHandlers(): string[] {
  const channels: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'handle') {
      const first = node.arguments[0]
      if (first && ts.isStringLiteral(first)) {
        const channel = first.text
        if (
          channel.startsWith('vast:avidae:') ||
          channel.startsWith('vast:network:') ||
          channel.startsWith('vast:passwords:') ||
          channel === 'vast:app:diagnostics' ||
          channel === 'vast:app:process-metrics'
        ) channels.push(channel)
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const relativePath of ['ipc.ts', 'ipc/avidae.ts', 'ipc/network.ts', 'ipc/passwords.ts']) {
    const moduleText = readFileSync(new URL(`../../src/main/${relativePath}`, import.meta.url), 'utf8')
    visit(ts.createSourceFile(relativePath, moduleText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS))
  }
  return channels
}

test('central policy enumerates every sensitive IPC handler with its required feature', () => {
  const expected = Object.entries(expectedSensitiveHandlers)
    .flatMap(([feature, channels]) => channels.map((channel) => [channel, feature] as const))
    .sort(([left], [right]) => left.localeCompare(right))
  assert.deepEqual(Object.entries(SENSITIVE_IPC_FEATURES).sort(([left], [right]) => left.localeCompare(right)), expected)
  assert.deepEqual(registeredSensitiveHandlers().sort(), expected.map(([channel]) => channel).sort())
  for (const [channel, feature] of expected) assert.equal(requiredFeatureForIpcChannel(channel), feature)
  assert.throws(() => requiredFeatureForIpcChannel('vast:passwords:unregistered-sensitive-operation'), /missing a central feature policy/)
})

test('every sensitive handler fails closed until its exact Labs feature is enabled', () => {
  for (const [feature, channels] of Object.entries(expectedSensitiveHandlers)) {
    for (const channel of channels) {
      assert.throws(() => assertIpcFeatureAllowed(channel, DEFAULT_SETTINGS), /disabled in Vast Labs settings/)
      const enabledSettings = {
        ...DEFAULT_SETTINGS,
        labs: {
          ...DEFAULT_SETTINGS.labs,
          enabled: true,
          [feature === VastFeatures.Avidae
            ? 'avidae'
            : feature === VastFeatures.NetworkDevices
              ? 'networkDevices'
              : feature === VastFeatures.PasswordManager
                ? 'passwordManager'
                : 'advancedDiagnostics']: true
        }
      }
      assert.doesNotThrow(() => assertIpcFeatureAllowed(channel, enabledSettings))
    }
  }
})

test('password handlers have complete main-process session access policy', () => {
  const passwordChannels = expectedSensitiveHandlers[VastFeatures.PasswordManager]
  assert.deepEqual(Object.keys(PASSWORD_VAULT_IPC_ACCESS).sort(), [...passwordChannels].sort())
  for (const channel of passwordChannels) assert.ok(vaultAccessForIpcChannel(channel))
  assert.throws(() => vaultAccessForIpcChannel('vast:passwords:unregistered-sensitive-operation'), /missing a central vault policy/)
  assert.doesNotThrow(() => assertSensitiveIpcRegistrationComplete(new Set(Object.keys(SENSITIVE_IPC_FEATURES))))
  assert.throws(() => assertSensitiveIpcRegistrationComplete(new Set()), /unregistered handlers/)
})

test('main runtime uses the program flag without an obsolete global Labs gate', () => {
  const requested = {
    ...DEFAULT_SETTINGS,
    spoofing: { ...DEFAULT_SETTINGS.spoofing, enabled: true }
  }
  assert.equal(settingsAllowedByRuntimeFeaturePolicy(requested).spoofing.enabled, false)
  assert.equal(settingsAllowedByRuntimeFeaturePolicy({
    ...requested,
    labs: { ...requested.labs, spoofing: true }
  }).spoofing.enabled, true)
})

test('display-only usernames and explicit autofill activation work while the vault session is locked', () => {
  assert.equal(vaultAccessForIpcChannel('vast:passwords:autofill-suggestions'), 'control')
  assert.equal(vaultAccessForIpcChannel('vast:passwords:fill-by-id'), 'control')
  assert.equal(vaultAccessForIpcChannel('vast:passwords:autofill'), 'control')
  assert.equal(vaultAccessForIpcChannel('vast:passwords:capture-status'), 'control')
  assert.equal(vaultAccessForIpcChannel('vast:passwords:resolve-save-prompt'), 'control')
  assert.equal(vaultAccessForIpcChannel('vast:passwords:copy-password'), 'fresh')
})
