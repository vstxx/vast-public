export type SettingsSearchSectionId =
  | 'Appearance'
  | 'Advanced'
  | 'Labs'
  | 'Network'
  | 'Developer'
  | 'Privacy'
  | 'Spoofing'
  | 'Security'
  | 'Site Data'
  | 'Search'
  | 'Automation'
  | 'Workspaces'
  | 'Shortcuts'
  | 'Data'

type SearchDefinition = readonly [label: string, ...aliases: string[]]

export interface SettingsSearchEntry {
  section: SettingsSearchSectionId
  label: string
  aliases: readonly string[]
}

export interface SettingsSearchResult extends SettingsSearchEntry {
  score: number
  matchedAlias?: string
}

declare const __VAST_CAT_ADDON_AVAILABLE__: boolean
const CAT_ADDON_AVAILABLE = typeof __VAST_CAT_ADDON_AVAILABLE__ !== 'undefined' && __VAST_CAT_ADDON_AVAILABLE__

const groups: Record<SettingsSearchSectionId, readonly SearchDefinition[]> = {
  Appearance: [
    ['Appearance', 'display look visuals wyglad wygląd interfejs'],
    ['Layout', 'tab layout vertical horizontal purist rozmieszczenie układ zakladki zakładki'],
    ['Theme', 'dark light dim mode color scheme motyw tryb ciemny jasny'],
    ['Force dark mode on websites', 'website dark mode night pages ciemne strony nocny tryb ciemny stron'],
    ['Background', 'wallpaper canvas backdrop tlo tło'],
    ['Accent color', 'primary colour highlight kolor akcentu'],
    ['Secondary accent', 'second accent colour drugi kolor'],
    ['Background tint', 'canvas color tlo kolor'],
    ['Surface tint', 'panel surface color kolor paneli'],
    ['Sidebar density', 'compact comfortable spacing gestosc gęstość paska'],
    ['Sidebar mode', 'dock floating auto panel boczny przypiety przypięty'],
    ['Sidebar width', 'panel size szerokosc szerokość'],
    ['Sidebar labels', 'panel text names etykiety paska'],
    ['Corner radius', 'roundness rounded corners zaokraglenie zaokrąglenie'],
    ['Glassiness', 'glass transparency acrylic szklo szkło'],
    ['Blur', 'background blur rozmycie'],
    ['Glow', 'neon bloom poswiata poświata'],
    ['Borders', 'outlines obramowanie ramki'],
    ['Shadow depth', 'shadows elevation cien cienie'],
    ['Gradients', 'gradient intensity przejscia kolorow'],
    ['Panel opacity', 'panel transparency przezroczystosc panelu'],
    ['Chrome opacity', 'browser ui transparency przezroczystosc interfejsu'],
    ['Saturation', 'color intensity nasycenie'],
    ['Animations', 'motion transitions ruch animacje'],
    ['Opening animation', 'startup splash launch animation animacja startowa'],
    ['Opening sound', 'startup audio launch sound dzwiek startowy'],
    ['Bookmarks bar', 'favorites bar pasek zakladek ulubione'],
    ['Show bookmarks bar only on New Tab', 'new tab favorites only zakladki tylko nowa karta'],
    ...(CAT_ADDON_AVAILABLE ? [['Cat Addon', 'cat pet kot dodatek'] as const] : []),
    ['Visual style', 'window effects appearance style styl wizualny']
  ],
  Advanced: [
    ['Advanced', 'power user zaawansowane'],
    ['Compact UI density', 'small controls tight spacing kompaktowy interfejs'],
    ['Memory target (best effort)', 'ram limit memory pressure memory target limit pamieci pamięci'],
    ['Hibernate after minutes', 'sleep inactive tabs timeout uspij karty hibernacja'],
    ['Discard after minutes', 'unload inactive tabs timeout odrzuc karty zwolnij ram'],
    ['Keep pinned tabs awake', 'never unload pinned przypiete karty aktywne'],
    ['Confirm before closing many tabs', 'close warning bulk tabs ostrzezenie zamykanie wielu kart'],
    ['Confirm before deleting workspace', 'workspace delete warning potwierdzenie usuniecia przestrzeni'],
    ['Show advanced More actions', 'more menu extra actions wiecej akcji'],
    ['Show internal pages in command palette', 'vast pages commands internal command menu'],
    ['Experimental features', 'experiments beta flags funkcje eksperymentalne'],
    ['Developer Mode', 'dev mode tools tryb programisty'],
    ['Enable Vast Labs', 'labs experimental lab laboratorium']
  ],
  Labs: [
    ['Labs', 'experimental features feature flags laboratorium eksperymenty'],
    ['Video & Audio', 'media downloader video audio av idae pobieranie filmow muzyki'],
    ['Network Devices', 'lan devices discovery urzadzenia sieciowe'],
    ['Automation', 'macros automate workflow automatyzacja makra'],
    ['Password Manager', 'password vault passwords credentials logins menedzer hasel hasla sejf'],
    ['Advanced diagnostics', 'debug diagnostics logs troubleshooting diagnostyka'],
    ['Spoofing tools', 'fingerprint identity user agent privacy spoofing maskowanie']
  ],
  Network: [
    ['Network Devices', 'lan local devices discovery siec urzadzenia sieciowe'],
    ['Enable Network Devices', 'turn on lan discovery wlacz urzadzenia sieciowe'],
    ['Allow local scans', 'scan lan network skanowanie sieci lokalnej'],
    ['Passive mDNS / SSDP discovery', 'bonjour upnp passive discovery wykrywanie pasywne'],
    ['Active local probing', 'probe hosts active scan aktywne skanowanie'],
    ['Remember devices', 'save discovered devices zapamietaj urzadzenia'],
    ['Show raw metadata', 'device details raw data surowe metadane'],
    ['Probe timeout', 'network scan timeout limit czasu skanowania'],
    ['Probe concurrency', 'parallel scan workers rownolegle skanowanie'],
    ['Open Network Devices', 'device list network page lista urzadzen'],
    ['Clear network cache', 'forget devices reset discovery wyczysc cache sieci']
  ],
  Developer: [
    ['Developer', 'dev tools debugging programista'],
    ['Enable Developer Mode', 'turn on devtools wlacz tryb programisty'],
    ['Open tab DevTools', 'inspect webview chromium console developer tools'],
    ['Reload active webview', 'refresh current page przeladuj strone'],
    ['Reload app chrome', 'refresh vast ui restart renderer przeladuj interfejs'],
    ['Copy debug report', 'support report diagnostics clipboard raport bledu'],
    ['Open Diagnostics', 'runtime diagnostics troubleshooting diagnostyka'],
    ['Copy diagnostics', 'copy system info debug data'],
    ['Vast version', 'app build release version wersja aplikacji'],
    ['Electron version', 'electron runtime version'],
    ['Chromium version', 'chrome engine version silnik'],
    ['Node version', 'nodejs runtime version'],
    ['Active URL', 'current page address aktywny adres']
  ],
  Privacy: [
    ['Privacy', 'tracking protection prywatnosc prywatność'],
    ['Block common trackers', 'anti tracking tracker blocker blokowanie sledzenia'],
    ['Ad blocker', 'adblock advertisements ads reklamy blokada reklam'],
    ['Ad blocking', 'adblock mode standard strict custom tryb reklam'],
    ['EasyList', 'ad filter list lista filtrow reklam'],
    ['EasyPrivacy', 'tracker filter list lista prywatnosci'],
    ["Peter Lowe's ad/tracker list", 'peter lowe filter ads trackers'],
    ['URLhaus malware list', 'malicious sites security filter zlosliwe strony'],
    ['Polish Annoyance Filters', 'polskie filtry irytujace elementy cookies'],
    ['Automatically update filter lists', 'auto refresh adblock filters aktualizuj filtry'],
    ['Custom: block ads', 'custom adblock reklamy'],
    ['Custom: block trackers', 'custom anti tracking sledzenie'],
    ['Custom: block malware', 'custom malicious sites zlosliwe oprogramowanie'],
    ['Custom: block third-party cookies', 'custom cross site cookies ciasteczka firm trzecich'],
    ['Custom network rules (one per line; use @@||domain^ for exceptions)', 'adblock syntax custom filters reguly sieciowe wyjatki'],
    ['Ad-block allowlist (domains, comma-separated)', 'adblock whitelist allowed sites dozwolone strony'],
    ['Clean tracking parameters while opening links', 'strip utm clean url remove tracking link tracking czysc linki'],
    ['Also remove affiliate parameters', 'strip affiliate referral links usun afiliacje'],
    ['Block third-party cookies', 'cross site cookies tracking cookies blokuj ciasteczka'],
    ['Cookie/login exceptions (domains, comma-separated)', 'cookie allowlist login exceptions wyjatki logowania'],
    ['Fingerprinting', 'browser fingerprint canvas protection odcisk przegladarki'],
    ['WebRTC', 'ip leak rtc network privacy wyciek ip'],
    ['Fingerprinting exceptions (domains, comma-separated)', 'fingerprint allowlist wyjatki fingerprintingu'],
    ['WebRTC exceptions (domains, comma-separated)', 'rtc allowlist wyjatki webrtc'],
    ['Open WebRTC leak test', 'test ip leak browserleaks sprawdz wyciek'],
    ['Update filter lists now', 'refresh adblock rules aktualizuj filtry teraz'],
    ['Fake browsing history', 'history noise decoy privacy falszywa historia'],
    ['Clear cookies/site data on exit', 'delete browsing data shutdown czysc dane przy wyjsciu'],
    ['Make new workspaces temporary by default', 'private ephemeral incognito workspace prywatne przestrzenie'],
    ['Disable history globally', 'stop browsing history no history wylacz historie'],
    ['Disable recently closed tabs', 'no closed tab log wylacz ostatnio zamkniete'],
    ['Disable page text capture', 'stop indexing page content wylacz zapis tekstu stron'],
    ['Disable favicons', 'no site icons wylacz ikony stron'],
    ['Clear cookies/site data', 'delete cache storage cookies wyczysc dane stron']
  ],
  Spoofing: [
    ['Spoofing', 'fingerprint identity masking maskowanie tozsamosci'],
    ['Enabled', 'enable spoofing wlacz maskowanie'],
    ['Browser brand', 'browser profile chrome firefox safari marka przegladarki'],
    ['Languages', 'locale accept language jezyki'],
    ['Timezone', 'time zone strefa czasowa'],
    ['Do Not Track', 'dnt privacy request nie sledz'],
    ['Custom user agent', 'ua browser identity wlasny user agent'],
    ['CPU cores', 'hardware concurrency processor rdzenie procesora'],
    ['Device memory GB', 'ram navigator memory pamiec urzadzenia'],
    ['Touch points', 'touchscreen max touch dotyk ekran dotykowy'],
    ['WebGL vendor', 'gpu manufacturer graphics fingerprint producent karty'],
    ['WebGL renderer', 'gpu model graphics fingerprint karta graficzna'],
    ['Location', 'geolocation gps spoof fake location lokalizacja'],
    ['Latitude', 'gps north south szerokosc geograficzna'],
    ['Longitude', 'gps east west dlugosc geograficzna'],
    ['Accuracy meters', 'gps precision dokladnosc lokalizacji'],
    ['Reset spoofing', 'restore fingerprint defaults resetuj maskowanie'],
    ['Use Warsaw profile', 'poland polish location warszawa profil']
  ],
  Security: [
    ['Security', 'protection safety bezpieczenstwo'],
    ['HTTPS-only mode', 'secure connections force https tylko https'],
    ['External link confirmation', 'open other apps protocol warning potwierdz linki zewnetrzne'],
    ['Dangerous download warnings', 'malware executable download alert ostrzezenia pobierania'],
    ['Always confirm autofill', 'password fill confirmation potwierdz autouzupelnianie'],
    ['Reset security settings', 'restore protection defaults resetuj bezpieczenstwo'],
    ['Unsafe protocols', 'blocked schemes dangerous links niebezpieczne protokoly'],
    ['WebSecurity', 'same origin cors electron web security'],
    ['Sandbox', 'electron isolation piaskownica']
  ],
  'Site Data': [
    ['Site Data / Permissions', 'website storage permissions dane stron uprawnienia'],
    ['Open Diagnostics & Site Data', 'site storage inspector diagnostics dane witryn'],
    ['Clear cached site data', 'delete cache storage cookies wyczysc cache'],
    ['Camera', 'webcam permission aparat kamera uprawnienie'],
    ['Microphone', 'mic permission mikrofon uprawnienie'],
    ['Location', 'geolocation gps permission lokalizacja uprawnienie'],
    ['Notifications', 'push alerts permission powiadomienia uprawnienie'],
    ['Clipboard', 'copy paste permission schowek uprawnienie'],
    ['Fullscreen', 'full screen permission pelny ekran uprawnienie'],
    ['Per-site permissions', 'website exceptions origin overrides uprawnienia witryn'],
    ['Revoke', 'remove site permission cofnij uprawnienie']
  ],
  Search: [
    ['Search and Startup', 'search engine launch new tab wyszukiwanie uruchamianie'],
    ['Search engine', 'google duckduckgo brave perplexity youtube wikipedia provider wyszukiwarka'],
    ['Startup', 'launch open behavior start uruchamianie'],
    ['New tab layout', 'dashboard blank workspace homepage nowa karta wyglad'],
    ['Compact dashboard cards', 'small new tab widgets kompaktowe kafelki'],
    ['Show quick links', 'new tab shortcuts speed dial szybkie linki'],
    ['Show recent pages', 'new tab history ostatnie strony'],
    ['Show bookmarks', 'new tab favorites zakladki na nowej karcie'],
    ['Show to-do', 'new tab tasks todo zadania'],
    ['Show notes', 'new tab notes notatki'],
    ['Show recently closed', 'new tab closed tabs ostatnio zamkniete'],
    ['Show workspace summary', 'new tab workspace overview podsumowanie przestrzeni'],
    ['Show session timeline', 'new tab browsing timeline os czasu sesji'],
    ['Restore previous session', 'continue tabs after restart przywroc poprzednia sesje'],
    ['Hibernate inactive tabs', 'sleep tabs memory saver uspij nieaktywne karty'],
    ['set browser as default', 'default browser windows http https domyslna przegladarka']
  ],
  Automation: [
    ['Automation', 'macros workflows automatyzacja makra'],
    ['Open Automation', 'automation page macro editor otworz automatyzacje'],
    ['Run first macro', 'execute workflow uruchom makro'],
    ['Macros installed', 'macro count installed workflows zainstalowane makra'],
    ['Automation model', 'local visible user controlled security model']
  ],
  Workspaces: [
    ['Workspaces', 'profiles containers spaces przestrzenie robocze'],
    ['New workspace', 'create profile add space nowa przestrzen'],
    ['Rename workspace', 'change profile name zmien nazwe przestrzeni'],
    ['Customize workspace', 'workspace icon color appearance dostosuj przestrzen'],
    ['Delete workspace', 'remove profile usun przestrzen'],
    ['Identity', 'session storage isolation profile tozsamosc sesja'],
    ['Network route', 'proxy connection routing trasa sieciowa'],
    ['Proxy URL', 'proxy server socks http serwer proxy'],
    ['Proxy bypass rules', 'no proxy exceptions wyjatki proxy']
  ],
  Shortcuts: [
    ['Keyboard Shortcuts', 'hotkeys key bindings skroty klawiszowe'],
    ['Reset shortcuts', 'restore hotkeys defaults resetuj skroty']
  ],
  Data: [
    ['Data', 'storage profile backup dane kopia profil'],
    ['Current Vast data directory', 'profile folder user data location folder danych'],
    ['Open data folder', 'show profile directory otworz folder danych'],
    ['Change Vast data directory', 'move profile storage location zmien folder danych'],
    ['Clear history', 'delete browsing history wyczysc historie'],
    ['Session timeline', 'browsing activity history os czasu sesji'],
    ['Password Manager', 'password vault credentials logins menedzer hasel sejf hasla'],
    ['Export all Vast data', 'full backup migrate archive eksport kopia danych'],
    ['Import Vast data', 'restore full backup migrate import przywroc dane'],
    ['Create local JSON restore point', 'quick backup snapshot recovery point lokalna kopia json'],
    ['Backup report', 'migration result backup status raport kopii']
  ]
}

export const settingsSearchCatalog: readonly SettingsSearchEntry[] = (
  Object.entries(groups) as Array<[SettingsSearchSectionId, readonly SearchDefinition[]]>
).flatMap(([section, definitions]) => definitions.map(([label, ...aliases]) => ({ section, label, aliases })))

export function normalizeSettingsSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[łŁ]/g, 'l')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function editDistanceWithin(left: string, right: string, limit: number): number | undefined {
  if (Math.abs(left.length - right.length) > limit) return undefined
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    let rowMinimum = current[0]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      const value = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + cost
      )
      current.push(value)
      rowMinimum = Math.min(rowMinimum, value)
    }
    if (rowMinimum > limit) return undefined
    previous = current
  }
  return previous[right.length] <= limit ? previous[right.length] : undefined
}

function wordMatchScore(token: string, word: string): number {
  if (token === word) return 32
  if (word.startsWith(token) && token.length >= 2) return 25 - Math.min(8, word.length - token.length)
  if (token.startsWith(word) && word.length >= 4) return 16 - Math.min(6, token.length - word.length)
  if (word.includes(token) && token.length >= 3) return 13
  const limit = token.length >= 7 ? 2 : token.length >= 4 ? 1 : 0
  if (limit === 0) return 0
  const distance = editDistanceWithin(token, word, limit)
  return distance === undefined ? 0 : 11 - (distance * 3)
}

function phraseScore(query: string, text: string, label: boolean): number {
  if (!text) return 0
  if (text === query) return label ? 240 : 190
  if (text.startsWith(query)) return label ? 185 : 145
  if (text.includes(query)) return label ? 150 : 115
  return 0
}

function scoreEntry(entry: SettingsSearchEntry, normalizedQuery: string): SettingsSearchResult | undefined {
  const label = normalizeSettingsSearchText(entry.label)
  const aliases = entry.aliases.map((alias) => ({ original: alias, normalized: normalizeSettingsSearchText(alias) }))
  let score = phraseScore(normalizedQuery, label, true)
  let matchedAlias: string | undefined

  for (const alias of aliases) {
    const aliasScore = phraseScore(normalizedQuery, alias.normalized, false)
    if (aliasScore > score) {
      score = aliasScore
      matchedAlias = alias.original
    }
  }

  const queryTokens = normalizedQuery.split(' ').filter(Boolean)
  const labelWords = label.split(' ').filter(Boolean)
  const aliasWords = aliases.flatMap((alias) => alias.normalized.split(' ').filter(Boolean))
  let tokenScore = 0
  for (const token of queryTokens) {
    const bestLabelScore = Math.max(0, ...labelWords.map((word) => wordMatchScore(token, word)))
    const bestAliasScore = Math.max(0, ...aliasWords.map((word) => wordMatchScore(token, word)))
    const best = Math.max(bestLabelScore + (bestLabelScore > 0 ? 5 : 0), bestAliasScore)
    if (best <= 0) return undefined
    tokenScore += best
  }

  score += tokenScore
  if (!matchedAlias && phraseScore(normalizedQuery, label, true) === 0) {
    matchedAlias = aliases.find((alias) => normalizedQuery.split(' ').every((token) =>
      alias.normalized.split(' ').some((word) => wordMatchScore(token, word) > 0)
    ))?.original
  }
  return { ...entry, score, matchedAlias }
}

export function searchSettings(
  query: string,
  allowedSections?: ReadonlySet<SettingsSearchSectionId>,
  extraEntries: readonly SettingsSearchEntry[] = [],
  limit = 24
): SettingsSearchResult[] {
  const normalizedQuery = normalizeSettingsSearchText(query)
  if (!normalizedQuery) return []
  return [...settingsSearchCatalog, ...extraEntries]
    .filter((entry) => !allowedSections || allowedSections.has(entry.section))
    .map((entry) => scoreEntry(entry, normalizedQuery))
    .filter((result): result is SettingsSearchResult => Boolean(result))
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, Math.max(1, limit))
}
