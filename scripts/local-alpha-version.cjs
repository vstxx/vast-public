function packagedVersion(sourceVersion, env = process.env) {
  const requested = String(env.VAST_LOCAL_ALPHA_VERSION || '').trim()
  if (!requested) return sourceVersion
  if (!/^0\.5\.0-alpha\.[1-9][0-9]*$/.test(requested)) throw new Error('Invalid local alpha version; expected 0.5.0-alpha.N.')
  if (env.VAST_RELEASE_CHANNEL !== 'alpha' || env.VAST_PRIVATE_BUILD !== '1') {
    throw new Error('A local alpha version requires a private alpha build.')
  }
  if (env.VAST_UPDATE_ENABLED !== '0') throw new Error('A local alpha version requires the network updater to be disabled.')
  return requested
}

module.exports = { packagedVersion }
