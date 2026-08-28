document.documentElement.dataset.vastExtensionFixture = 'content-script-loaded'

chrome.storage.local.set({ vastExtensionFixtureStorage: 'storage-round-trip' }, () => {
  chrome.storage.local.get('vastExtensionFixtureStorage', (value) => {
    document.documentElement.dataset.vastExtensionFixtureStorage = value.vastExtensionFixtureStorage
  })
})
