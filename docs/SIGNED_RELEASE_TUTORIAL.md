# Podpisane wydanie Vast na Windows

Author / publisher: **VastProductions**

> Ten dokument opisuje zalecany proces podpisany. Wyjątkowa publiczna unsigned
> beta jest osobnym, jawnie słabszym trybem i nigdy nie może być użyta dla stable.

> Publiczne `0.2.5` jest wydaniem **unsigned**, nie poprzednią podpisaną betą.
> Bieżąca decyzja dla `0.2.7` jest opisana w
> `docs/RELEASE_0.2.7_READINESS.md`; przykłady poniżej pokazują wyłącznie
> przyszłą sekwencję podpisanych wydań.

Ten proces obowiązuje identycznie dla publicznej bety i stable. Publiczna beta
nie jest buildem developerskim: musi przejść pełny audit, podpis Authenticode,
RFC 3161 timestamp, test upgrade oraz ponowną weryfikację plików pobranych z
produkcyjnego repozytorium wydań.

## 1. Wymagania

- Windows 11 lub aktualny Windows Server runner;
- Node.js 24 i `npm ci`;
- Python 3.13;
- .NET SDK 8;
- Windows SDK z `signtool.exe`;
- publicznie zaufany certyfikat Authenticode, którego Subject zawiera
  `VastProductions`;
- the pinned Vast FFmpeg 9.0.1 build with verified corresponding source (`npm run ffmpeg:build`);
- uprawnienie do `vstxx/vast-public`.

Prywatnego klucza, hasła PFX ani tokenu GitHub nigdy nie zapisuj w Git. Nazwy
sekretów używane przez workflow:

- `WIN_CSC_LINK`;
- `WIN_CSC_KEY_PASSWORD`;
- `VAST_RELEASE_TOKEN`.

`VAST_RELEASE_TOKEN` powinien być fine-grained i mieć zapis Contents wyłącznie
do repozytorium `vstxx/vast-public`.

Nie wysyłaj PFX ani hasła w czacie. Zapisz PFX lokalnie poza repo albo dodaj
jego base64 jako sekret GitHub Actions. Workflow bierze dokładny `github.sha`,
a lokalny gate sam odczytuje czysty `git rev-parse HEAD`; ten SHA trafia do
pakietu i manifestów jako `sourceCommit`.

## 2. Numeracja beta → final

Do weryfikacji rzeczywistego upgrade path używaj kolejno np.:

1. `0.2.7-beta.1` — pierwszy podpisany publiczny kandydat;
2. `0.2.7-beta.2` — kolejny podpisany kandydat, aktualizowany z beta.1;
3. `0.2.7` — final, aktualizowany z ostatniej podpisanej bety.

Updater obsługuje pełną kolejność SemVer: `beta.1 < beta.2 < 0.2.7`. Nie testuj
publicznego upgrade na artefaktach unsigned ani na samych atrapach plików.

Jeżeli repo `vstxx/vast-public` nie zawiera jeszcze żadnego opublikowanego Release, uruchom
`beta.1` z wejściem `bootstrap_first_beta=true`. Ten jednorazowy tryb jest
dozwolony wyłącznie dla wersji kończącej się `-beta.1` i braku opublikowanych
wydań. Prywatny draft `internal unsigned` nie jest publicznym poprzednikiem.
Nie omija podpisu, timestampu ani weryfikacji po pobraniu z produkcji; pomija
wyłącznie niemożliwy test upgrade z nieistniejącego poprzednika. Dla `beta.2`
i wszystkich kolejnych wydań ustaw `bootstrap_first_beta=false` i wskaż
rzeczywistą poprzednią podpisaną wersję oraz jej URL.

## 3. Lokalna konfiguracja podpisu

Skopiuj `.env.release.example` do ignorowanego `.env.release.local` i ustaw:

```dotenv
VAST_RELEASE_CHANNEL=beta
VAST_PRIVATE_BUILD=0
VAST_RELEASE_REPO=vstxx/vast-public
VAST_PREVIOUS_VERSION=0.2.7-beta.1
VAST_UPDATE_ENABLED=1
VAST_OBFUSCATE=1
VAST_EXPECTED_SIGNER_SUBJECT=VastProductions
VAST_RELAY_ENABLED=1
VAST_RELAY_ENVIRONMENT=production
WIN_CSC_LINK=C:\secure\VastProductions-code-signing.pfx
WIN_CSC_KEY_PASSWORD=<hasło tylko lokalnie>
```

Dla stable ustaw `VAST_RELEASE_CHANNEL=stable`; public beta i stable używają
tego samego produkcyjnego Relay po przejściu staging gate.

## 4. Pełny lokalny gate

```powershell
npm ci
npm ci --prefix relay
python -m pip install -r resources/avidae/requirements.txt -r resources/avidae/requirements-build.txt
npm run audit:ci
npm run lint
npm run check --prefix relay
npm test
npm run updater:stage
npm run test:updater
npm run release:audit
npm run avidae:runtime:prepare
npm run avidae:runtime:check
npm run release:check:local
npm run release:local
```

`release:local` kończy się błędem, jeżeli brakuje certyfikatu, timestampu,
expected signer, self-contained Video & Audio runtime, obfuscation, updatera lub
któregokolwiek wymaganego pliku. Beta nie ma wyjątku od tych zasad.

Sprawdź ręcznie podpisy bez ujawniania klucza:

```powershell
Get-AuthenticodeSignature release\Installer\Vast-Setup-0.2.7.exe | Format-List Status,SignerCertificate,TimeStamperCertificate
Get-AuthenticodeSignature release\Updater\VastUpdater-0.2.7.exe | Format-List Status,SignerCertificate,TimeStamperCertificate
```

Status musi być `Valid`, signer musi odpowiadać `VastProductions`, a
`TimeStamperCertificate` nie może być pusty.

## 5. Zweryfikowany upgrade

Po opublikowaniu poprzedniej podpisanej bety ustaw:

```powershell
$env:VAST_PREVIOUS_VERSION='0.2.7-beta.1'
$env:VAST_RELEASE_VERSION='0.2.7-beta.2'
$env:VAST_PREVIOUS_RELEASE_BASE_URL='https://github.com/vstxx/vast-public/releases/download/v0.2.7-beta.1'
$env:VAST_CURRENT_RELEASE_ROOT=(Resolve-Path release).Path
$env:VAST_EXPECTED_SIGNER_SUBJECT='VastProductions'
npm run test:upgrade:public
```

Test pobiera poprzedni produkcyjny ZIP, weryfikuje podpis i timestamp jego
`Vast.exe`, uruchamia aktualny podpisany updater oraz potwierdza zachowanie
ustawień, zakładek, sejfu, cookies, `install_id` Relay i `launch_count`.

## 6. Publikacja i ponowne pobranie

Zalecana droga to GitHub Actions → **Public signed release**. Podaj kanał,
poprzednią wersję, produkcyjny URL poprzednich assetów i pozostaw
`bootstrap_first_beta=false` poza jednorazowym pierwszym `beta.1`. Workflow:

1. buduje z dokładnego, czystego SHA;
2. wykonuje wszystkie testy i audit;
3. buduje self-contained Video & Audio runtime;
4. podpisuje runtime, installer, portable i updater;
5. tworzy draft w `vstxx/vast-public` i wysyła dokładne assety;
6. pobiera draft przez API i ponownie weryfikuje bajty, signer i timestamp;
7. wykonuje realny upgrade poprzednia podpisana wersja → bieżąca;
8. publikuje release;
9. pobiera pliki z publicznego produkcyjnego URL i weryfikuje je ponownie.

Po ręcznym uploadzie odpowiednikiem ostatniego kroku jest:

```powershell
$env:VAST_RELEASE_VERSION='0.2.7'
$env:VAST_PRODUCTION_RELEASE_BASE_URL='https://github.com/vstxx/vast-public/releases/download/v0.2.7'
$env:VAST_EXPECTED_SIGNER_SUBJECT='VastProductions'
npm run release:verify:published
```

Nie ogłaszaj wydania, jeżeli ten krok nie jest green. Sam napis
„VastProductions” w `package.json` nie jest podpisem — to certyfikat i zaufany
timestamp stanowią dowód wydawcy.

## 7. Jawny publiczny unsigned release

Jeżeli certyfikat nie jest jeszcze dostępny, użyj osobnego workflow **Public
unsigned release**. Nie zmienia on ani nie osłabia workflow podpisanego. Wymaga
dosłownego:

```text
I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK
```

Tryb unsigned:

- obsługuje kanał beta (GitHub prerelease) oraz stable (normalny GitHub Release);
- wymaga dokładnego czystego SHA w każdym manifeście;
- wymaga obfuscation, pełnego CI, Electron Fuses i self-contained Video & Audio;
- wymaga statusu `NotSigned` dla runtime, instalatora, portable i updatera;
- publikuje `PUBLIC-UNSIGNED-RELEASE.md` oraz SHA-256/SHA-512;
- pobiera draft, a następnie publiczne assety i porównuje je bajt w bajt;
- nie dowodzi tożsamości wydawcy i nie ma zaufanego timestampu;
- nie jest poprawnym poprzednikiem dla testu signed beta → signed beta;
- rezerwuje wersję i tag na zawsze. Przyszłe podpisane wydanie musi dostać wyższy numer.

Lokalnie użyj `npm run release:public-unsigned`; workflow używa
`.github/workflows/public-unsigned-beta.yml`. Na stronie pobierania trzeba jasno
pokazać ostrzeżenie **Unknown publisher / SmartScreen** oraz link do SHA-256.
