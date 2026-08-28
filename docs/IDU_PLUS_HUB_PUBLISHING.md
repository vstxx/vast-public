# Publikacja IDU+ 0.3.8 w Vast Extensions Hub

Ten przewodnik opisuje publikację gotowego IDU+ z konta właściciela Vast na
`https://extensions.vastbrowser.com`. Pakiet działa wyłącznie na stronach HTTPS
hosta `idu.edu.pl` i jego subdomen (`https://*.idu.edu.pl/*`).

Opublikowany katalog Hubu jest wspólnym źródłem Explore dla strony i Vast.
IDU+ pojawi się w obu miejscach dopiero po zatwierdzeniu release'u; nie ma już
osobnego lokalnego wpisu katalogowego w przeglądarce. Stan `Installed` i `Enabled`
pozostaje lokalny dla profilu Vast i nie jest wysyłany na publiczną stronę.

## Stan produkcji po wdrożeniu 2026-08-24

- Worker `vast-extensions-hub` jest wdrożony pod custom domain
  `https://extensions.vastbrowser.com`.
- Aktywna wersja Workera: `493aadbc-967c-4f0e-8ff6-3f358192b2d9`.
- Migracje D1 są zastosowane; kategoria `education` istnieje.
- Bindingi D1, R2 i Assets oraz cztery wymagane sekrety są podłączone.
- Konto GitHub `vstxx` istnieje już jako zweryfikowany wydawca `Vast` z rolą
  `admin`.
- IDU+ nie jest jeszcze opublikowane, dlatego zapytanie katalogowe zwraca zero
  wyników dla IDU+. To zmieni się dopiero po wykonaniu sekcji C i D.

Do pierwszej publikacji IDU+ nie powtarzaj konfiguracji infrastruktury z sekcji
A i B. Zacznij od sekcji C.

## Gotowe pliki

- Pakiet: `artifacts/IDU-Plus-by-Vast-0.3.8.vext`
- Ikona katalogowa: `artifacts/IDU-Plus-icon-128.png`
- Zrzut ekranu: `artifacts/IDU-Plus-screenshot-login.png`
- Extension ID: `kbbfoeemomglhdhohnkcnfnpikedcoka`
- SHA-256 pakietu: `5e3cf3ac3cda455df828cca2e19f87e34378a9562ef79946711f65d3f780e305`
- SHA-256 ikony: `0f7f973ad701e2f0ed84442264ffe5dec4dafbcdf3a811940af53d24f3fdb490`
- SHA-256 zrzutu: `fc87e95483692a4f989a082ad2897cd06d81134685acf19a74d68abb7aff6830`

Pakiet ma `publisher_id: null`. Jest to zamierzone: podczas zatwierdzania Hub
przepisuje pakiet, przypisuje rzeczywisty identyfikator zalogowanego wydawcy i
podpisuje wynik oficjalnym kluczem Hubu. Nie edytuj pliku `.vext` ręcznie.

## A. Ponowne wdrożenie Workera w przyszłości

Jeżeli `extensions.vastbrowser.com` jest już wdrożony, D1/R2 oraz cztery sekrety
są skonfigurowane, wykonaj tylko poniższe polecenia z katalogu repozytorium:

```powershell
npm run hub:typecheck
npm run hub:test
npm run hub:build
npx wrangler d1 migrations apply vast-extensions-hub --remote --config extensions-hub/wrangler.jsonc
npx wrangler deploy --config extensions-hub/wrangler.jsonc
```

Wrangler pominie zastosowane migracje. Po deployu sprawdź `wrangler deployments
status` i oba publiczne endpointy zamiast zakładać, że upload oznacza poprawne
uruchomienie:

```powershell
npx wrangler deployments status --config extensions-hub/wrangler.jsonc
Invoke-WebRequest -UseBasicParsing "https://extensions.vastbrowser.com/"
Invoke-WebRequest -UseBasicParsing "https://extensions.vastbrowser.com/v1/catalog"
```

Przejdź następnie do sekcji C.

## B. Pierwsze uruchomienie Hubu na koncie Cloudflare

### 1. Zaloguj Wrangler na właściwe konto

```powershell
npx wrangler --version
npx wrangler login
npx wrangler whoami
```

Repozytorium używa Wranglera 4.x. Konto musi posiadać strefę
`vastbrowser.com`. Custom Domain skonfigurowany w `wrangler.jsonc` utworzy DNS i
certyfikat dla `extensions.vastbrowser.com`. Usuń wcześniej kolidujący rekord
CNAME o tej nazwie, jeśli istnieje.

### 2. Sprawdź zasoby D1 i R2

```powershell
npx wrangler d1 list
npx wrangler r2 bucket list
```

Konfiguracja oczekuje:

- D1: `vast-extensions-hub`
- R2: `vast-extensions-packages`

Jeżeli konfigurujesz inne konto i tych zasobów nie ma, utwórz je:

```powershell
npx wrangler d1 create vast-extensions-hub
npx wrangler r2 bucket create vast-extensions-packages
```

Po utworzeniu D1 wpisz zwrócony `database_id` do
`extensions-hub/wrangler.jsonc`. Nazwa bucketa R2 musi odpowiadać polu
`bucket_name`.

Dodaj awaryjną regułę retencji dla porzuconych uploadów stagingowych (Worker
czyści je wcześniej, reguła R2 jest dodatkowym zabezpieczeniem):

```powershell
npx wrangler r2 bucket lifecycle add vast-extensions-packages expire-abandoned-staging staging/ --expire-days 30
```

### 3. Utwórz GitHub OAuth App

W GitHub przejdź do `Settings -> Developer settings -> OAuth Apps -> New OAuth App`
i ustaw:

- Application name: `Vast Extensions Hub`
- Homepage URL: `https://extensions.vastbrowser.com`
- Authorization callback URL:
  `https://extensions.vastbrowser.com/auth/github/callback`

Nie włączaj wildcard matching dla callback URL. Skopiuj Client ID i wygeneruj
Client Secret.

### 4. Ustaw sekrety Workera

Wartości podawaj dopiero w interaktywnym promptcie Wranglera. Nie wpisuj ich do
`wrangler.jsonc`, Git, komunikatora ani logów.

```powershell
npx wrangler secret put GITHUB_CLIENT_ID --config extensions-hub/wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config extensions-hub/wrangler.jsonc
npx wrangler secret put HUB_SIGNING_PRIVATE_KEY_PKCS8 --config extensions-hub/wrangler.jsonc
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put HUB_RATE_LIMIT_SECRET --config extensions-hub/wrangler.jsonc
npx wrangler secret list --config extensions-hub/wrangler.jsonc
```

`HUB_SIGNING_PRIVATE_KEY_PKCS8` musi być wartością base64 prywatnego klucza
Ed25519 odpowiadającego publicznemu kluczowi `vast-hub-2026-01` przypiętemu w
`src/main/extensions/trusted-hub-keys.ts`. Jeżeli produkcyjny sekret już istnieje,
nie zastępuj go. Utrata tego klucza wymaga kontrolowanej rotacji, dodania nowego
klucza publicznego do Vast i wydania nowej wersji przeglądarki przed podpisaniem
nowych paczek.

### 5. Migracje, kontrola i wdrożenie

```powershell
npm run hub:types
npm run hub:typecheck
npm run hub:test
npm run hub:build
npx wrangler d1 migrations apply vast-extensions-hub --remote --config extensions-hub/wrangler.jsonc
npx wrangler deploy --config extensions-hub/wrangler.jsonc
```

Sprawdź `https://extensions.vastbrowser.com/`. Jeżeli potrzebujesz logów:

```powershell
npx wrangler tail vast-extensions-hub
```

## C. Utworzenie listingu IDU+ z konta wydawcy

### 1. Zaloguj konto

Otwórz `https://extensions.vastbrowser.com`, kliknij `Publisher sign in` i
zaloguj konto GitHub `vstxx`. Po zalogowaniu przejdź do `Dashboard`. To konto
jest już skonfigurowane jako zweryfikowany wydawca `Vast` i administrator, więc
nie wykonuj dla niego ręcznego `UPDATE`.

Poniższe polecenie jest potrzebne tylko wtedy, gdy kiedyś zmienisz konto
wydawcy. Zastąp placeholder dokładnym loginem GitHub:

```powershell
npx wrangler d1 execute vast-extensions-hub --remote --config extensions-hub/wrangler.jsonc --command "UPDATE publishers SET publisher_name='Vast', verified=1 WHERE github_login='TWOJ_LOGIN_GITHUB';"
```

Wyloguj się i zaloguj ponownie, aby odświeżyć sesję z nowymi danymi wydawcy.

### 2. Utwórz listing

W `Dashboard -> Create extension` wpisz dokładnie:

- Name: `IDU+`
- Slug: `idu-plus`
- Extension ID: `kbbfoeemomglhdhohnkcnfnpikedcoka`
- Summary: `Improves the interface and usability of IDU school portals.`
- Category: `education`
- Description:
  `IDU+ improves the layout, styling and day-to-day usability of IDU school portals on HTTPS hosts under idu.edu.pl. It runs locally in the browser and requests only extension storage and access to supported IDU pages.`
- Homepage: `https://idu.edu.pl/`
- Source URL: publiczny adres repozytorium źródłowego albo pozostaw puste

Kliknij `Create listing`. Identyfikator widoczny na karcie musi być równy
`kbbfoeemomglhdhohnkcnfnpikedcoka`.

### 3. Prześlij materiały

Na karcie listingu wykonaj kolejno:

1. `Extension package -> Validate upload` i wybierz
   `artifacts/IDU-Plus-by-Vast-0.3.8.vext`.
2. `Catalog icon -> Upload icon` i wybierz
   `artifacts/IDU-Plus-icon-128.png`.
3. `Screenshot -> Add screenshot` i wybierz
   `artifacts/IDU-Plus-screenshot-login.png`.

Po walidacji release `0.3.8` ma mieć status `draft`. Kliknij
`Submit for review`.

## D. Review i publikacja z konta administratora

Konto `vstxx` ma rolę `admin`, dlatego może przejrzeć i zatwierdzić także release
należący do własnego publishera. Jest to celowy wyjątek operacyjny dostępny
wyłącznie administratorom. Pakiet nadal jest ponownie walidowany, podpisywany
i publikowany atomowo, a operacja trafia do audytu jako
`admin-self-approve-and-sign`.

Na koncie `vstxx`:

1. otwórz `https://extensions.vastbrowser.com/review`;
2. przy własnym wydaniu zobaczysz oznaczenie `Admin self-review`;
3. sprawdź zakres `https://*.idu.edu.pl/*`, uprawnienie `storage`, wersję 0.3.8,
   kod źródłowy, ikonę i zrzut;
4. kliknij `Approve and publish`.

Puste pole notatki jest dozwolone dla zatwierdzenia. Hub automatycznie zapisze
bezpieczną notatkę o użyciu uprawnienia administratora.

### Opcjonalnie: niezależny reviewer

Jeżeli chcesz zachować zasadę dwóch osób dla konkretnego wydania, drugie konto
GitHub musi najpierw zalogować się do Hubu, a następnie otrzymać rolę reviewera:

```powershell
npx wrangler d1 execute vast-extensions-hub --remote --config extensions-hub/wrangler.jsonc --command "UPDATE publishers SET role='reviewer', verified=1 WHERE github_login='LOGIN_DRUGIEGO_KONTA';"
```

Następnie na drugim koncie:

1. wyloguj i zaloguj się ponownie;
2. otwórz `https://extensions.vastbrowser.com/review`;
3. sprawdź zakres `https://*.idu.edu.pl/*`, uprawnienie `storage`, wersję 0.3.8,
   kod źródłowy, ikonę i zrzut;
4. kliknij `Approve and sign`.

Akceptacja ponownie waliduje paczkę, tworzy oficjalny `.vext`, podpisuje paczkę
i descriptor kluczem Hubu oraz publikuje je atomowo.

## E. Kontrola po publikacji

```powershell
$iduExtensionId = 'kbbfoeemomglhdhohnkcnfnpikedcoka'
Invoke-RestMethod "https://extensions.vastbrowser.com/v1/extensions/$iduExtensionId"
Invoke-RestMethod "https://extensions.vastbrowser.com/v1/install/$iduExtensionId"
Invoke-RestMethod "https://extensions.vastbrowser.com/v1/catalog?query=IDU%2B"
```

Wynik powinien pokazywać wersję `0.3.8`, wydawcę `Vast`, kategorię `education`
i host permission `https://*.idu.edu.pl/*`.

Sprawdź także, czy wpis jest dokładnie ten sam na stronie i w publicznym API:

```powershell
$iduExtensionId = 'kbbfoeemomglhdhohnkcnfnpikedcoka'
$hubCatalog = Invoke-RestMethod "https://extensions.vastbrowser.com/v1/catalog?query=IDU%2B"
$hubDetails = Invoke-RestMethod "https://extensions.vastbrowser.com/v1/extensions/$iduExtensionId"
$hubCatalog.items | Select-Object id,name,version,category
$hubDetails | Select-Object id,name,version,category,publisher,permissions
```

Następnie uruchom świeży profil Vast, przejdź do `Extensions -> Explore`, znajdź
IDU+, zainstaluj je i sprawdź co najmniej dwie różne subdomeny IDU. Zwykłe
strony HTTP oraz domeny podobne do `idu.edu.pl`, na przykład
`idu.edu.pl.example.com`, nie są objęte rozszerzeniem.

## Odtworzenie pakietu po kolejnej zmianie

Najpierw zwiększ `version` w manifeście, a potem uruchom:

```powershell
npm run extension:pack -- "resources/first-party-extensions/idu-plus" --out "artifacts/IDU-Plus-by-Vast-NOWA_WERSJA.vext" --extension-id kbbfoeemomglhdhohnkcnfnpikedcoka
```

Hub odrzuci wersję równą lub niższą od obecnie opublikowanej. Nie podawaj
`--publisher-id`: serwer przypisze i podpisze finalny pakiet podczas review.

## Najczęstsze problemy

- `409 slug or ID is already in use`: nie generuj nowego ID. Otwórz istniejący
  listing z Dashboardu i upewnij się, że ma ID
  `kbbfoeemomglhdhohnkcnfnpikedcoka`.
- Brak przycisku akceptacji: właściciel musi mieć rolę `admin`; zwykły
  `publisher` ani `reviewer` nie może zatwierdzić własnego release'u. Po zmianie
  roli wyloguj się i zaloguj ponownie.
- Wpis jest w Dashboardzie, ale nie w Explore: sam listing lub release nadal ma
  status `draft`/`pending`; tylko `published` z ustawionym current release trafia
  do katalogu.
- Upload `.vext` jest odrzucany: użyj gotowego pliku bez rozpakowywania i
  ręcznej edycji; sprawdź SHA-256 z sekcji „Gotowe pliki”.
- Strona pokazuje IDU+, a stary Vast nie: uruchom build przeglądarki zawierający
  scentralizowany katalog i ponownie otwórz Explore. Stan katalogu nie jest już
  dostarczany z lokalnych resources.
- Podpis nie przechodzi w Vast: nie zmieniaj sekretu podpisującego bez rotacji
  publicznego klucza `vast-hub-2026-01` i wydania nowej wersji przeglądarki.

Dokumentacja referencyjna:

- https://developers.cloudflare.com/workers/wrangler/commands/general/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- https://developers.cloudflare.com/d1/get-started/
- https://developers.cloudflare.com/r2/get-started/cli/
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app
