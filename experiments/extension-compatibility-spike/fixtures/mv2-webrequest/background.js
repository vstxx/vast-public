const port = __PORT__;
const state = { beforeRequest: 0, secondObserver: 0, beforeSendHeaders: 0, completed: 0, urls: [], completedUrls: [], errorUrls: [], authUrls: [], errors: [] };
const report = () => fetch(`http://127.0.0.1:${port}/report`, {
  method: 'POST', body: JSON.stringify({ from: 'mv2-webrequest', data: state })
}).catch(() => {});
try {
  chrome.webRequest.onBeforeRequest.addListener((details) => {
    if (!details.url.includes('/report')) { state.beforeRequest++; state.urls.push(details.url); }
    if (details.url.includes('/matrix?case=extension-throws')) throw new Error('intentional extension listener exception');
    if (details.url.includes('/matrix?case=extension-cancel')) return { cancel: true };
    if (details.url.includes('/matrix?case=extension-redirect-denied')) return { redirectUrl: details.url.replace('extension-redirect-denied', 'vast-deny') };
    if (details.url.includes('/matrix?case=extension-redirect')) return { redirectUrl: details.url.replace('extension-redirect', 'extension-target') };
    if (details.url.includes('/matrix?case=redirect-collision')) return { redirectUrl: details.url.replace('redirect-collision', 'extension-target') };
    return {};
  }, { urls: ['<all_urls>'] }, ['blocking']);
  chrome.webRequest.onBeforeRequest.addListener((details) => {
    if (!details.url.includes('/report')) state.secondObserver++;
  }, { urls: ['<all_urls>'] });
  chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
    if (!details.url.includes('/matrix?case=')) return {};
    state.beforeSendHeaders++;
    return { requestHeaders: [...details.requestHeaders.filter((header) => header.name.toLowerCase() !== 'x-vast-probe'), { name: 'X-Extension-Probe', value: 'present' }] };
  }, { urls: ['<all_urls>'] }, ['blocking', 'requestHeaders']);
  chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
    if (!details.url.includes('/matrix?case=')) return {};
    return { requestHeaders: [...details.requestHeaders, { name: 'X-Extension-Second', value: 'observed' }] };
  }, { urls: ['<all_urls>'] }, ['blocking', 'requestHeaders']);
  chrome.webRequest.onHeadersReceived.addListener((details) => {
    if (!details.url.includes('/matrix?case=')) return {};
    return { responseHeaders: [...details.responseHeaders.filter((header) => header.name.toLowerCase() !== 'x-vast-response'), { name: 'X-Extension-Response', value: 'present' }] };
  }, { urls: ['<all_urls>'] }, ['blocking', 'responseHeaders']);
  chrome.webRequest.onAuthRequired.addListener((details, callback) => {
    state.authUrls.push(details.url);
    if (details.url.includes('case=auth-extension-timeout')) return;
    if (details.url.includes('case=auth-extension-async')) {
      setTimeout(() => callback({ authCredentials: { username: 'extension', password: 'pass' } }), 75);
      return;
    }
    callback(details.url.includes('/matrix?case=auth-')
      ? { authCredentials: { username: 'extension', password: 'pass' } }
      : {});
  }, { urls: ['<all_urls>'] }, ['asyncBlocking']);
  chrome.webRequest.onCompleted.addListener((details) => {
    if (!details.url.includes('/report')) state.completed++;
    if (details.url.includes('/matrix?case=')) state.completedUrls.push(details.url);
  }, { urls: ['http://127.0.0.1/*'] });
  chrome.webRequest.onErrorOccurred.addListener((details) => {
    if (details.url.includes('/matrix?case=')) state.errorUrls.push(details.url);
  }, { urls: ['http://127.0.0.1/*'] });
} catch (error) { state.errors.push(String(error && error.message || error)); }
setInterval(report, 1000);
