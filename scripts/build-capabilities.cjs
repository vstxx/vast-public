function flag(env, name, fallback = false) {
  const value = String(env[name] ?? '').trim().toLowerCase()
  if (!value) return fallback
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  return fallback
}

function catAddonEnabled(env = process.env) {
  const channel = String(env.VAST_RELEASE_CHANNEL ?? 'dev').trim().toLowerCase()
  const publicDistribution = ['beta', 'stable'].includes(channel) && !flag(env, 'VAST_PRIVATE_BUILD', true)
  return flag(env, 'VAST_CAT_ADDON_ENABLED', !publicDistribution)
}

function withBuildCapabilities(build, env = process.env) {
  const extraResources = (build.extraResources ?? []).filter((entry) => entry?.to !== 'cat-addon')
  if (catAddonEnabled(env)) extraResources.push({ from: 'resources/cat-addon', to: 'cat-addon' })
  return { ...build, extraResources }
}

module.exports = { catAddonEnabled, flag, withBuildCapabilities }
