function createPreflightEnvironment(parent) {
  const env = {
    ...parent,
    VAST_RELEASE_CHANNEL: 'dev',
    VAST_PRIVATE_BUILD: '1',
    VAST_DISTRIBUTION_CHANNEL: 'direct',
    VAST_PUBLIC_UNSIGNED_RELEASE: '0',
    VAST_UPDATE_ENABLED: '0',
    VAST_RELAY_ENABLED: '0',
    VAST_RELAY_TEST_OFFLINE: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  // The preflight build is a development build, not the sealed release build.
  // A previous candidate's fingerprint must not be validated as this commit's.
  delete env.VAST_RELEASE_COMMIT
  delete env.VAST_EXTENSION_COMPATIBILITY_FINGERPRINT_REQUIRED
  return env
}

module.exports = { createPreflightEnvironment }
