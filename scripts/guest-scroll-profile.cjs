function seedBenchmarkProfile(template, url, now = Date.now()) {
  const data = structuredClone(template)
  const workspace = data.workspaces.find((item) => !item.isPrivate) || data.workspaces[0]
  if (!workspace) throw new Error('Benchmark template lacks a workspace')
  data.tabs = [{
    id: 'benchmark-tab', workspaceId: workspace.id, title: 'Guest benchmark',
    url, displayUrl: new URL(url).host, pinned: false, status: 'idle',
    lifecycle: 'active', progress: 0, canGoBack: false, canGoForward: false,
    zoom: 1, createdAt: now, lastAccessedAt: now
  }]
  workspace.activeTabId = 'benchmark-tab'
  data.activeWorkspaceId = workspace.id
  data.settings.openingAnimation = false
  data.settings.hibernateInactiveTabs = false
  data.onboarding = { ...(data.onboarding || {}), completed: true }
  return data
}

module.exports = { seedBenchmarkProfile }
