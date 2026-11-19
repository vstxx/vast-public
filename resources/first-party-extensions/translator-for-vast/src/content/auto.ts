// Registered only while the user has "always translate" languages. Runs once per document at
// idle: reads the declared language and a short prose sample, and asks the service worker whether
// this page qualifies. No observers, no timers, nothing else stays behind.

const LIMIT = 2_000

if (!(globalThis as { __tfvAuto?: boolean }).__tfvAuto && top === self) {
  ;(globalThis as { __tfvAuto?: boolean }).__tfvAuto = true
  const parts: string[] = []
  let length = 0
  for (const element of document.querySelectorAll('h1, h2, p, li')) {
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text.length < 20) continue
    parts.push(text)
    length += text.length + 1
    if (length >= LIMIT) break
  }
  if (length >= 80) {
    void chrome.runtime.sendMessage({ scope: 'tfv', type: 'content:auto-check', declared: document.documentElement.getAttribute('lang'), sample: parts.join(' ').slice(0, LIMIT) }).catch(() => undefined)
  }
}
