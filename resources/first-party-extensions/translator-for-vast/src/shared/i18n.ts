// Interface strings. English is the baseline and the fallback for any missing key; a language is
// added by adding one dictionary below. Placeholders are {name}.

const en = {
  appName: 'Translator for Vast',
  localNote: 'Runs on this device. Page text is never sent anywhere.',
  menuTranslatePage: 'Translate page',
  menuTranslateSelection: 'Translate “%s”',
  menuShowOriginal: 'Show original page',
  translatePage: 'Translate page',
  showOriginal: 'Show original',
  cancel: 'Cancel',
  from: 'From',
  to: 'To',
  detected: 'Detected: {language}',
  detecting: 'Detecting language…',
  unknownLanguage: 'Language not detected',
  pageUnsupported: 'Translator works on regular websites only.',
  pageAlreadyTarget: 'This page is already in {language}.',
  translating: 'Translating… {done} of {total}',
  translated: 'Translated {done} blocks.',
  translatedKept: '{kept} blocks the page changed after translation stay as they are.',
  restoring: 'Restoring…',
  noRoute: 'No model translates {source} to {target}.',
  downloadNeeded: '{source} → {target} needs a language model.',
  downloadAction: 'Download · {size}',
  downloadPivot: 'This direction goes through English, so it needs two models and may be less accurate.',
  downloading: 'Downloading… {loaded} of {total}',
  downloadFailed: 'Download failed: {error}',
  downloadCancelled: 'Download cancelled.',
  retry: 'Try again',
  offlineReady: 'Available offline',
  displayMode: 'Display',
  displayReplace: 'Replace text',
  displayBilingual: 'Original and translation',
  alwaysTranslateLanguage: 'Always translate {language}',
  neverTranslateSite: 'Never translate {site}',
  settings: 'Settings',
  close: 'Close',
  copy: 'Copy',
  copied: 'Copied',
  selectionTitle: 'Translation',
  selectionTranslating: 'Translating…',
  selectionNothing: 'Select some text first.',
  selectionTruncated: 'Only the first {count} characters were translated.',
  selectionSame: 'The selection is already in {language}.',
  selectionButton: 'Translate selection',
  errorGeneric: 'Translation failed: {error}',
  errorUnsupported: 'This processor cannot run the translation engine.',
  optionsTitle: 'Translator for Vast settings',
  optionsLanguage: 'Language',
  optionsTarget: 'Translate into',
  optionsTargetAuto: 'Browser language ({language})',
  optionsDisplay: 'Page display',
  optionsSelection: 'Selection',
  optionsSelectionButton: 'Show a translate button next to selected text',
  optionsSelectionButtonHint: 'Adds a small script to websites that only watches for text selection. Translation still starts only when you press the button. The page menu works without it.',
  optionsAutomatic: 'Automatic translation',
  optionsAlways: 'Always translate these languages',
  optionsAlwaysHint: 'While this list is not empty, a small script checks the language of websites you open, on this device. Pages are translated only when the language model is already downloaded.',
  optionsNeverLanguages: 'Never offer to translate these languages',
  optionsNeverSites: 'Never translate these websites',
  optionsAddLanguage: 'Add language',
  optionsAddSite: 'Add website',
  optionsSitePlaceholder: 'example.com',
  optionsRemove: 'Remove',
  optionsModels: 'Language models',
  optionsModelsHint: 'Models are downloaded from Mozilla’s public model storage only when you ask, verified, and kept in this workspace. Translation works offline once a model is here.',
  optionsInstalled: 'Downloaded',
  optionsAvailable: 'Available directions',
  optionsNoModels: 'No language models downloaded yet.',
  optionsDelete: 'Delete',
  optionsDeleteAll: 'Delete all models',
  optionsDeleteAllConfirm: 'Delete every downloaded language model in this workspace? You can download them again later.',
  optionsStorage: 'Models use {size} in this workspace.',
  optionsEngine: 'Engine',
  optionsIdle: 'Keep the engine ready after translating for',
  optionsSeconds: '{count} s',
  optionsEngineState: 'Engine state: {state}',
  optionsPrivacy: 'Privacy',
  optionsPrivacyText: 'Translation runs in a worker inside this extension. The only network requests are model downloads from storage.googleapis.com, made when you ask for a language. No account, telemetry or remote translation service is used.',
  optionsSearch: 'Filter languages',
  stateUninitialized: 'not started',
  stateLoading: 'loading',
  stateReady: 'ready',
  stateTranslating: 'translating',
  stateIdle: 'ready (idle)',
  stateReleased: 'released',
  stateError: 'error'
}

export type MessageKey = keyof typeof en

const pl: Partial<Record<MessageKey, string>> = {
  appName: 'Translator for Vast',
  localNote: 'Działa na tym urządzeniu. Tekst strony nigdy nie jest nigdzie wysyłany.',
  menuTranslatePage: 'Przetłumacz stronę',
  menuTranslateSelection: 'Przetłumacz „%s”',
  menuShowOriginal: 'Pokaż oryginał strony',
  translatePage: 'Przetłumacz stronę',
  showOriginal: 'Pokaż oryginał',
  cancel: 'Anuluj',
  from: 'Z',
  to: 'Na',
  detected: 'Wykryto: {language}',
  detecting: 'Wykrywanie języka…',
  unknownLanguage: 'Nie wykryto języka',
  pageUnsupported: 'Tłumacz działa tylko na zwykłych stronach internetowych.',
  pageAlreadyTarget: 'Ta strona jest już po {language}.',
  translating: 'Tłumaczenie… {done} z {total}',
  translated: 'Przetłumaczono bloki: {done}.',
  translatedKept: 'Bloki zmienione przez stronę po tłumaczeniu ({kept}) pozostają bez zmian.',
  restoring: 'Przywracanie…',
  noRoute: 'Żaden model nie tłumaczy z języka {source} na {target}.',
  downloadNeeded: '{source} → {target} wymaga modelu językowego.',
  downloadAction: 'Pobierz · {size}',
  downloadPivot: 'Ten kierunek prowadzi przez angielski, więc wymaga dwóch modeli i może być mniej dokładny.',
  downloading: 'Pobieranie… {loaded} z {total}',
  downloadFailed: 'Pobieranie nie powiodło się: {error}',
  downloadCancelled: 'Anulowano pobieranie.',
  retry: 'Spróbuj ponownie',
  offlineReady: 'Dostępny offline',
  displayMode: 'Widok',
  displayReplace: 'Zastąp tekst',
  displayBilingual: 'Oryginał i tłumaczenie',
  alwaysTranslateLanguage: 'Zawsze tłumacz język: {language}',
  neverTranslateSite: 'Nigdy nie tłumacz {site}',
  settings: 'Ustawienia',
  close: 'Zamknij',
  copy: 'Kopiuj',
  copied: 'Skopiowano',
  selectionTitle: 'Tłumaczenie',
  selectionTranslating: 'Tłumaczenie…',
  selectionNothing: 'Najpierw zaznacz tekst.',
  selectionTruncated: 'Przetłumaczono tylko pierwsze {count} znaków.',
  selectionSame: 'Zaznaczenie jest już w języku: {language}.',
  selectionButton: 'Przetłumacz zaznaczenie',
  errorGeneric: 'Tłumaczenie nie powiodło się: {error}',
  errorUnsupported: 'Ten procesor nie obsługuje silnika tłumaczenia.',
  optionsTitle: 'Ustawienia Translator for Vast',
  optionsLanguage: 'Język',
  optionsTarget: 'Tłumacz na',
  optionsTargetAuto: 'Język przeglądarki ({language})',
  optionsDisplay: 'Wygląd strony',
  optionsSelection: 'Zaznaczenie',
  optionsSelectionButton: 'Pokazuj przycisk tłumaczenia obok zaznaczonego tekstu',
  optionsSelectionButtonHint: 'Dodaje do stron mały skrypt, który tylko obserwuje zaznaczenie tekstu. Tłumaczenie zaczyna się dopiero po naciśnięciu przycisku. Menu strony działa bez tej opcji.',
  optionsAutomatic: 'Tłumaczenie automatyczne',
  optionsAlways: 'Zawsze tłumacz te języki',
  optionsAlwaysHint: 'Gdy lista nie jest pusta, mały skrypt sprawdza na tym urządzeniu język otwieranych stron. Strona jest tłumaczona tylko wtedy, gdy model jest już pobrany.',
  optionsNeverLanguages: 'Nigdy nie proponuj tłumaczenia tych języków',
  optionsNeverSites: 'Nigdy nie tłumacz tych stron',
  optionsAddLanguage: 'Dodaj język',
  optionsAddSite: 'Dodaj stronę',
  optionsRemove: 'Usuń',
  optionsModels: 'Modele językowe',
  optionsModelsHint: 'Modele są pobierane z publicznego magazynu Mozilli tylko na Twoje żądanie, weryfikowane i przechowywane w tym obszarze roboczym. Po pobraniu tłumaczenie działa offline.',
  optionsInstalled: 'Pobrane',
  optionsAvailable: 'Dostępne kierunki',
  optionsNoModels: 'Nie pobrano jeszcze żadnego modelu.',
  optionsDelete: 'Usuń',
  optionsDeleteAll: 'Usuń wszystkie modele',
  optionsDeleteAllConfirm: 'Usunąć wszystkie pobrane modele w tym obszarze roboczym? Można je później pobrać ponownie.',
  optionsStorage: 'Modele zajmują {size} w tym obszarze roboczym.',
  optionsEngine: 'Silnik',
  optionsIdle: 'Utrzymuj silnik gotowy po tłumaczeniu przez',
  optionsSeconds: '{count} s',
  optionsEngineState: 'Stan silnika: {state}',
  optionsPrivacy: 'Prywatność',
  optionsPrivacyText: 'Tłumaczenie działa w wątku roboczym wewnątrz rozszerzenia. Jedyne żądania sieciowe to pobieranie modeli z storage.googleapis.com, wykonywane na Twoje żądanie. Nie ma konta, telemetrii ani zdalnej usługi tłumaczenia.',
  optionsSearch: 'Filtruj języki',
  stateUninitialized: 'nieuruchomiony',
  stateLoading: 'ładowanie',
  stateReady: 'gotowy',
  stateTranslating: 'tłumaczy',
  stateIdle: 'gotowy (bezczynny)',
  stateReleased: 'zwolniony',
  stateError: 'błąd'
}

const dictionaries: Record<string, Partial<Record<MessageKey, string>>> = { en, pl }

export function uiLanguage(): string {
  let tag = 'en'
  try {
    tag = chrome.i18n?.getUILanguage?.() ?? navigator.language
  } catch {
    tag = typeof navigator === 'undefined' ? 'en' : navigator.language
  }
  const primary = tag.toLowerCase().split(/[-_]/)[0] ?? 'en'
  return primary in dictionaries ? primary : 'en'
}

export function t(key: MessageKey, values: Record<string, string | number> = {}, language = uiLanguage()): string {
  const template = dictionaries[language]?.[key] ?? en[key]
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match)
}

export function formatBytes(bytes: number, language = uiLanguage()): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: value >= 10 || unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`
}
