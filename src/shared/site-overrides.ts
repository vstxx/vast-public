export interface SiteAppearanceOverride {
  id: string
  label: string
  hostnames: string[]
  css: string
}

export interface SiteOverridePreferences {
  disabled?: Record<string, boolean>
}

const IDU_MODERN_CSS = `
html.vast-site-override-idu-modern {
  --vast-idu-icon-message: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%235d728f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8A2.5 2.5 0 0 1 17.5 17H9l-5 3v-13.5Z'/%3E%3Cpath d='m7 8 5 4 5-4'/%3E%3C/svg%3E");
  --vast-idu-icon-news: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%235d728f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 4h11l3 3v13H5z'/%3E%3Cpath d='M15 4v4h4'/%3E%3Cpath d='M8 11h8'/%3E%3Cpath d='M8 15h6'/%3E%3C/svg%3E");
  --vast-idu-icon-forum: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%235d728f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M7 8h10'/%3E%3Cpath d='M7 12h7'/%3E%3Cpath d='M6 18 3 21v-14a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3z'/%3E%3C/svg%3E");
  --vast-idu-icon-profile: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%235d728f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='8' r='4'/%3E%3Cpath d='M5 20a7 7 0 0 1 14 0'/%3E%3C/svg%3E");
  --vast-idu-icon-logout: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%235d728f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10 6H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4'/%3E%3Cpath d='M14 16l4-4-4-4'/%3E%3Cpath d='M18 12H9'/%3E%3C/svg%3E");
  --vast-idu-icon-file: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%235d728f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z'/%3E%3Cpath d='M14 3v5h5'/%3E%3Cpath d='M9 14h6'/%3E%3Cpath d='M9 17h4'/%3E%3C/svg%3E");
}

html.vast-site-override-idu-modern body,
html.vast-site-override-idu-modern body * {
  font-family: Inter, "Inter", "Segoe UI", Arial, sans-serif !important;
}

html.vast-site-override-idu-modern #header,
html.vast-site-override-idu-modern #top,
html.vast-site-override-idu-modern #topbar,
html.vast-site-override-idu-modern #banner,
html.vast-site-override-idu-modern #baner,
html.vast-site-override-idu-modern #naglowek,
html.vast-site-override-idu-modern .header,
html.vast-site-override-idu-modern .top,
html.vast-site-override-idu-modern .topbar,
html.vast-site-override-idu-modern .banner,
html.vast-site-override-idu-modern .baner,
html.vast-site-override-idu-modern .naglowek,
html.vast-site-override-idu-modern [id*="header" i],
html.vast-site-override-idu-modern [id*="topbar" i],
html.vast-site-override-idu-modern [id*="banner" i],
html.vast-site-override-idu-modern [id*="baner" i],
html.vast-site-override-idu-modern [id*="naglow" i],
html.vast-site-override-idu-modern [class*="header" i],
html.vast-site-override-idu-modern [class*="topbar" i],
html.vast-site-override-idu-modern [class*="banner" i],
html.vast-site-override-idu-modern [class*="baner" i],
html.vast-site-override-idu-modern [class*="naglow" i],
html.vast-site-override-idu-modern body > table:first-of-type:has(img[src*="idu" i]),
html.vast-site-override-idu-modern body > center:first-child > table:first-of-type:has(img[src*="idu" i]) {
  height: auto !important;
  line-height: 1.18 !important;
  min-height: 58px !important;
  padding-bottom: 6px !important;
  padding-top: 6px !important;
}

html.vast-site-override-idu-modern #header td,
html.vast-site-override-idu-modern #top td,
html.vast-site-override-idu-modern #topbar td,
html.vast-site-override-idu-modern #banner td,
html.vast-site-override-idu-modern #baner td,
html.vast-site-override-idu-modern #naglowek td,
html.vast-site-override-idu-modern .header td,
html.vast-site-override-idu-modern .top td,
html.vast-site-override-idu-modern .topbar td,
html.vast-site-override-idu-modern .banner td,
html.vast-site-override-idu-modern .baner td,
html.vast-site-override-idu-modern .naglowek td,
html.vast-site-override-idu-modern [id*="header" i] td,
html.vast-site-override-idu-modern [id*="topbar" i] td,
html.vast-site-override-idu-modern [id*="banner" i] td,
html.vast-site-override-idu-modern [id*="baner" i] td,
html.vast-site-override-idu-modern [id*="naglow" i] td,
html.vast-site-override-idu-modern [class*="header" i] td,
html.vast-site-override-idu-modern [class*="topbar" i] td,
html.vast-site-override-idu-modern [class*="banner" i] td,
html.vast-site-override-idu-modern [class*="baner" i] td,
html.vast-site-override-idu-modern [class*="naglow" i] td,
html.vast-site-override-idu-modern body > table:first-of-type:has(img[src*="idu" i]) td,
html.vast-site-override-idu-modern body > center:first-child > table:first-of-type:has(img[src*="idu" i]) td {
  height: auto !important;
  line-height: 1.18 !important;
  padding-bottom: 4px !important;
  padding-top: 4px !important;
  vertical-align: middle !important;
}

html.vast-site-override-idu-modern #header img,
html.vast-site-override-idu-modern #top img,
html.vast-site-override-idu-modern #topbar img,
html.vast-site-override-idu-modern #banner img,
html.vast-site-override-idu-modern #baner img,
html.vast-site-override-idu-modern #naglowek img,
html.vast-site-override-idu-modern .header img,
html.vast-site-override-idu-modern .top img,
html.vast-site-override-idu-modern .topbar img,
html.vast-site-override-idu-modern .banner img,
html.vast-site-override-idu-modern .baner img,
html.vast-site-override-idu-modern .naglowek img,
html.vast-site-override-idu-modern [id*="header" i] img,
html.vast-site-override-idu-modern [id*="topbar" i] img,
html.vast-site-override-idu-modern [id*="banner" i] img,
html.vast-site-override-idu-modern [id*="baner" i] img,
html.vast-site-override-idu-modern [id*="naglow" i] img,
html.vast-site-override-idu-modern [class*="header" i] img,
html.vast-site-override-idu-modern [class*="topbar" i] img,
html.vast-site-override-idu-modern [class*="banner" i] img,
html.vast-site-override-idu-modern [class*="baner" i] img,
html.vast-site-override-idu-modern [class*="naglow" i] img,
html.vast-site-override-idu-modern body > table:first-of-type:has(img[src*="idu" i]) img,
html.vast-site-override-idu-modern body > center:first-child > table:first-of-type:has(img[src*="idu" i]) img {
  height: auto !important;
  max-height: 46px !important;
  width: auto !important;
}

html.vast-site-override-idu-modern #header td:not(:has(a)),
html.vast-site-override-idu-modern #top td:not(:has(a)),
html.vast-site-override-idu-modern #topbar td:not(:has(a)),
html.vast-site-override-idu-modern #banner td:not(:has(a)),
html.vast-site-override-idu-modern #baner td:not(:has(a)),
html.vast-site-override-idu-modern #naglowek td:not(:has(a)),
html.vast-site-override-idu-modern .header td:not(:has(a)),
html.vast-site-override-idu-modern .top td:not(:has(a)),
html.vast-site-override-idu-modern .topbar td:not(:has(a)),
html.vast-site-override-idu-modern .banner td:not(:has(a)),
html.vast-site-override-idu-modern .baner td:not(:has(a)),
html.vast-site-override-idu-modern .naglowek td:not(:has(a)),
html.vast-site-override-idu-modern [id*="header" i] td:not(:has(a)),
html.vast-site-override-idu-modern [id*="topbar" i] td:not(:has(a)),
html.vast-site-override-idu-modern [id*="banner" i] td:not(:has(a)),
html.vast-site-override-idu-modern [id*="baner" i] td:not(:has(a)),
html.vast-site-override-idu-modern [id*="naglow" i] td:not(:has(a)),
html.vast-site-override-idu-modern [class*="header" i] td:not(:has(a)),
html.vast-site-override-idu-modern [class*="topbar" i] td:not(:has(a)),
html.vast-site-override-idu-modern [class*="banner" i] td:not(:has(a)),
html.vast-site-override-idu-modern [class*="baner" i] td:not(:has(a)),
html.vast-site-override-idu-modern [class*="naglow" i] td:not(:has(a)),
html.vast-site-override-idu-modern body > table:first-of-type:has(img[src*="idu" i]) td:not(:has(a)),
html.vast-site-override-idu-modern body > center:first-child > table:first-of-type:has(img[src*="idu" i]) td:not(:has(a)) {
  max-width: calc(100vw - 220px) !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
}

html.vast-site-override-idu-modern table,
html.vast-site-override-idu-modern fieldset,
html.vast-site-override-idu-modern form,
html.vast-site-override-idu-modern iframe,
html.vast-site-override-idu-modern object,
html.vast-site-override-idu-modern embed,
html.vast-site-override-idu-modern #content,
html.vast-site-override-idu-modern #container,
html.vast-site-override-idu-modern #main,
html.vast-site-override-idu-modern .content,
html.vast-site-override-idu-modern .container,
html.vast-site-override-idu-modern .main,
html.vast-site-override-idu-modern .box,
html.vast-site-override-idu-modern .panel,
html.vast-site-override-idu-modern .block,
html.vast-site-override-idu-modern .section,
html.vast-site-override-idu-modern .module,
html.vast-site-override-idu-modern div[style*="border" i],
html.vast-site-override-idu-modern div[style*="background" i],
html.vast-site-override-idu-modern td[style*="border" i],
html.vast-site-override-idu-modern th[style*="border" i],
html.vast-site-override-idu-modern [class*="section" i],
html.vast-site-override-idu-modern [id*="section" i] {
  border-radius: 10px !important;
}

html.vast-site-override-idu-modern table tr:first-child > td:first-child,
html.vast-site-override-idu-modern table tr:first-child > th:first-child {
  border-top-left-radius: 10px !important;
}

html.vast-site-override-idu-modern table tr:first-child > td:last-child,
html.vast-site-override-idu-modern table tr:first-child > th:last-child {
  border-top-right-radius: 10px !important;
}

html.vast-site-override-idu-modern table tr:last-child > td:first-child,
html.vast-site-override-idu-modern table tr:last-child > th:first-child {
  border-bottom-left-radius: 10px !important;
}

html.vast-site-override-idu-modern table tr:last-child > td:last-child,
html.vast-site-override-idu-modern table tr:last-child > th:last-child {
  border-bottom-right-radius: 10px !important;
}

html.vast-site-override-idu-modern input:not([type="checkbox"]):not([type="radio"]):not([type="image"]),
html.vast-site-override-idu-modern select,
html.vast-site-override-idu-modern textarea,
html.vast-site-override-idu-modern button,
html.vast-site-override-idu-modern input[type="button"],
html.vast-site-override-idu-modern input[type="submit"],
html.vast-site-override-idu-modern input[type="reset"],
html.vast-site-override-idu-modern a.button,
html.vast-site-override-idu-modern .button,
html.vast-site-override-idu-modern .btn {
  border-radius: 8px !important;
  font-family: Inter, "Inter", "Segoe UI", Arial, sans-serif !important;
}

html.vast-site-override-idu-modern input[type="file"]::file-selector-button {
  border-radius: 8px !important;
  font-family: Inter, "Inter", "Segoe UI", Arial, sans-serif !important;
}

html.vast-site-override-idu-modern [class*="plan" i] td,
html.vast-site-override-idu-modern [id*="plan" i] td,
html.vast-site-override-idu-modern [class*="lekcj" i] td,
html.vast-site-override-idu-modern [id*="lekcj" i] td,
html.vast-site-override-idu-modern [class*="timetable" i] td,
html.vast-site-override-idu-modern [id*="timetable" i] td,
html.vast-site-override-idu-modern [class*="schedule" i] td,
html.vast-site-override-idu-modern [id*="schedule" i] td,
html.vast-site-override-idu-modern [class*="terminarz" i] td,
html.vast-site-override-idu-modern [id*="terminarz" i] td,
html.vast-site-override-idu-modern td[style*="background" i][rowspan],
html.vast-site-override-idu-modern td[style*="background" i][colspan],
html.vast-site-override-idu-modern a[href*="plan" i],
html.vast-site-override-idu-modern a[href*="lekcj" i] {
  border-radius: 8px !important;
}

html.vast-site-override-idu-modern img[src*="icon" i],
html.vast-site-override-idu-modern img[src*="ikony" i],
html.vast-site-override-idu-modern img[width="16"],
html.vast-site-override-idu-modern img[height="16"],
html.vast-site-override-idu-modern a[href*="wiadom" i] img,
html.vast-site-override-idu-modern a[href*="aktual" i] img,
html.vast-site-override-idu-modern a[href*="forum" i] img,
html.vast-site-override-idu-modern a[href*="profil" i] img,
html.vast-site-override-idu-modern a[href*="logout" i] img,
html.vast-site-override-idu-modern a[href*="wyloguj" i] img,
html.vast-site-override-idu-modern a[href*="szablon" i] img,
html.vast-site-override-idu-modern a[href*="dokument" i] img {
  border-radius: 4px !important;
  height: 16px !important;
  margin: 0 3px !important;
  object-fit: contain !important;
  vertical-align: -3px !important;
  width: 16px !important;
}

html.vast-site-override-idu-modern a[href*="wiadom" i] img,
html.vast-site-override-idu-modern img[src*="wiadom" i],
html.vast-site-override-idu-modern img[alt*="wiadom" i],
html.vast-site-override-idu-modern img[title*="wiadom" i] {
  content: var(--vast-idu-icon-message) !important;
}

html.vast-site-override-idu-modern a[href*="aktual" i] img,
html.vast-site-override-idu-modern img[src*="aktual" i],
html.vast-site-override-idu-modern img[alt*="aktual" i],
html.vast-site-override-idu-modern img[title*="aktual" i] {
  content: var(--vast-idu-icon-news) !important;
}

html.vast-site-override-idu-modern a[href*="forum" i] img,
html.vast-site-override-idu-modern img[src*="forum" i],
html.vast-site-override-idu-modern img[alt*="forum" i],
html.vast-site-override-idu-modern img[title*="forum" i] {
  content: var(--vast-idu-icon-forum) !important;
}

html.vast-site-override-idu-modern a[href*="profil" i] img,
html.vast-site-override-idu-modern img[src*="profil" i],
html.vast-site-override-idu-modern img[alt*="profil" i],
html.vast-site-override-idu-modern img[title*="profil" i] {
  content: var(--vast-idu-icon-profile) !important;
}

html.vast-site-override-idu-modern a[href*="logout" i] img,
html.vast-site-override-idu-modern a[href*="wyloguj" i] img,
html.vast-site-override-idu-modern img[src*="logout" i],
html.vast-site-override-idu-modern img[src*="wyloguj" i],
html.vast-site-override-idu-modern img[alt*="wyloguj" i],
html.vast-site-override-idu-modern img[title*="wyloguj" i] {
  content: var(--vast-idu-icon-logout) !important;
}

html.vast-site-override-idu-modern a[href*="szablon" i] img,
html.vast-site-override-idu-modern a[href*="dokument" i] img,
html.vast-site-override-idu-modern img[src*="szablon" i],
html.vast-site-override-idu-modern img[src*="dokument" i],
html.vast-site-override-idu-modern img[src*="file" i],
html.vast-site-override-idu-modern img[src*="doc" i] {
  content: var(--vast-idu-icon-file) !important;
}
`.trim()

export const SITE_APPEARANCE_OVERRIDES: SiteAppearanceOverride[] = [
  {
    id: 'idu-modern',
    label: 'IDU skin',
    hostnames: ['s19.idu.edu.pl'],
    css: IDU_MODERN_CSS
  }
]

export function siteOverrideForUrl(url: string | undefined): SiteAppearanceOverride | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    const hostname = parsed.hostname.toLowerCase()
    return SITE_APPEARANCE_OVERRIDES.find((override) =>
      override.hostnames.some((candidate) => candidate.toLowerCase() === hostname)
    )
  } catch {
    return undefined
  }
}

export function isSiteOverrideDisabled(preferences: SiteOverridePreferences | undefined, overrideId: string): boolean {
  return preferences?.disabled?.[overrideId] === true
}

export function buildSiteOverrideScript(override: SiteAppearanceOverride, enabled: boolean, fontFaceCss = ''): string {
  const styleId = `__vast_site_override_${override.id}`
  const className = `vast-site-override-${override.id}`
  const css = fontFaceCss ? `${fontFaceCss}\n${override.css}` : override.css
  return `
(() => {
  const id = ${JSON.stringify(styleId)};
  const rootClass = ${JSON.stringify(className)};
  const existing = document.getElementById(id);
  if (!${JSON.stringify(enabled)}) {
    if (existing) existing.remove();
    document.documentElement.classList.remove(rootClass);
    return false;
  }
  const style = existing || document.createElement('style');
  style.id = id;
  style.textContent = ${JSON.stringify(css)};
  if (!existing) {
    if (document.head) document.head.appendChild(style);
    else document.documentElement.appendChild(style);
  }
  document.documentElement.classList.add(rootClass);
  return true;
})()
`
}
