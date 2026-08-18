export function shouldLoadPopupInitialUrl(
  initialUrl: string | undefined,
  hasProvidedWebContents: boolean,
  isSafeWebUrl: (url: string) => boolean
): initialUrl is string {
  if (hasProvidedWebContents || !initialUrl || initialUrl === 'about:blank') return false
  return isSafeWebUrl(initialUrl)
}
