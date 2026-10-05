# Audyt startu Vast — 2026-10-04

## Środowisko i sposób pomiaru

- Windows 11, prywatna, niepodpisana paczka `release/logo-fix/win-unpacked` z zatwierdzonym Electron 44.3.0 Vast r5. Użyto odizolowanych profili testowych, bez zmian w profilu J Nowa.
- Czasy liczone od uruchomienia procesu przez skrypt do znaczników procesu głównego i renderera. „Zimny profil” oznacza pierwsze uruchomienie świeżo przygotowanego profilu, a „ciepły” ponowny start tego profilu. Nie wykonywano restartu Windows ani czyszczenia pamięci podręcznej systemu.
- Wyniki końcowe z paczki z pełnymi metadanymi zgodności rozszerzeń: `performance-results/startup-final-first-launch-20261004.json` (trzy puste profile), `performance-results/startup-final-full-runtime-20261004.json` (trzy pary zimny/ciepły z animacją oraz 1, 50, 250 kart), `performance-results/startup-final-no-animation-20261004.json` (trzy pary bez animacji). Przywracane karty poza aktywną były uśpione, zgodnie z domyślną hibernacją.
- Skrypt pomiarowy teraz czeka na zamknięcie okna splash i wymaga znacznika `primary-browser-revealed`. Wcześniejsze krótkie przebiegi zamykały aplikację przed końcem animacji, co fałszowało znacznik jej zakończenia.

## Wyniki

| Etap | Pusty profil, mediana z 3 pierwszych startów | Zimny profil z animacją, mediana z 3 | Ciepły profil z animacją, mediana z 3 |
| --- | ---: | ---: | ---: |
| Interaktywny szkielet UI | 469 ms | 478 ms | 429 ms |
| Ustawienia wczytane | 168 ms | 172 ms | 152 ms |
| Rozszerzenia zainicjowane | 198 ms | 208 ms | 174 ms |
| Główne okno utworzone | 278 ms | 279 ms | 240 ms |
| Renderer DOM gotowy | 398 ms | 405 ms | 358 ms |
| UI gotowe do odsłonięcia | — | 607 ms | 599 ms |
| Splash widoczny | — | 633 ms | 626 ms |
| Główne okno odsłonięte | — | 3346 ms | 3333 ms |

Pierwsze uruchomienie używa domyślnego ustawienia animacji `off`; mediana pierwszego contentful paint wyniosła 660 ms w trzech pustych profilach. W przywracanych profilach animację celowo włączono. Jej stały czas 2700 ms od pokazania splashu odpowiada za niemal całe oczekiwanie między gotowym UI a odsłonięciem. Nie należy utożsamiać czasu 3,33–3,35 s z ładowaniem renderera.

W osobnych próbach przy **wyłączonej** animacji ponowny start miał medianę 457 ms (zimny profil) i 428 ms (ciepły profil) do interaktywnego szkieletu UI. Mediana pierwszego contentful paint wyniosła odpowiednio 636 i 652 ms. Główne okno jest wtedy widoczne od początku renderowania. Różnice czasu samego szkieletu między seriami z animacją i bez niej zależą również od tego, czy główne okno jest ukryte w trakcie hydratacji; nie są pomiarem zysku z animacji.

Skalowanie przy włączonej animacji: 1 / 50 / 250 kart dało odpowiednio 478 / 486 / 490 ms do szkieletu UI i 3346 / 3358 / 3355 ms do odsłonięcia okna. Zsumowany working set czterech procesów wyniósł około 495 / 502 / 505 MiB po odsłonięciu. Ta próba pokazuje brak wyraźnego kosztu liczby **uśpionych** kart na ścieżce startu. Nie dowodzi tego samego dla 250 aktywnie ładowanych stron ani profilu z wieloma rozszerzeniami.

## Ścieżka krytyczna i decyzje

1. Przed utworzeniem okna proces zapisuje znacznik zdrowia startu, usuwa pozostałości importu, sprawdza oczekującą aktualizację, ładuje dane profilu, konfiguruje sesję/ochronę i przywraca rozszerzenia. Dla badanego profilu wszystkie te kroki kończą się około 0,17–0,21 s od uruchomienia.
2. Główne okno i osobny splash są tworzone przed hydratacją UI. Główne okno działa w tle, podczas gdy użytkownik ogląda animację. To już usuwa ładowanie UI ze stałego czasu animacji.
3. `loadData()` korzysta z pamięci podręcznej w **obrębie procesu** po pierwszym odczycie. W badanym profilu ponowny odczyt dyskowy nie jest dominującym kosztem. Trwała pamięć podręczna pliku ustawień wymagałaby walidacji zmian i odzyskiwania danych, a potencjalna oszczędność jest niewielka.
4. Przywracanie rozszerzeń jest częścią ścieżki przed pierwszym oknem. Jego bezmyślne odłożenie mogłoby spowodować ładowanie stron bez wymaganych uprawnień, blokad i modyfikacji żądań. Profil z wieloma rzeczywiście zainstalowanymi rozszerzeniami wymaga osobnego pomiaru przed optymalizacją tej części.
5. Usuwania pozostałości importu nie należy po prostu przenosić za odsłonięcie okna: działające równolegle importowanie mogłoby wtedy używać tego samego katalogu. Ewentualne odroczenie wymaga blokady albo identyfikacji starych katalogów.

## Możliwości przyspieszenia bez utraty danych

| Pomysł | Potencjalny efekt | Warunek / koszt |
| --- | --- | --- |
| Opcjonalny krótki wariant animacji lub możliwość pominięcia jej kliknięciem po sygnale `primary-ui-ready` | Do około 2,7 s krótszy **odczuwalny** start przy pełnym pominięciu animacji | Zachować obecny wariant jako wybór użytkownika; zsynchronizować dźwięk i wyjście splashu. To zmiana UX, nie poprawa szybkości inicjalizacji. |
| Pokazać splash zaraz po odczycie ustawień, równolegle z konfiguracją sesji/rozszerzeń | Kilkadziesiąt ms wcześniejszy sygnał wizualny w tym profilu; większy możliwy z rozszerzeniami | Utrzymać poprawną obsługę błędów, aktualizatora i sytuacji, w której animacja skończy się przed gotowością głównego okna. Zysk nie został jeszcze zmierzony eksperymentalnie. |
| Profilować instalacje z wieloma rozszerzeniami oraz wariant Purist przed zmianą kolejności ładowania | Może ujawnić koszt specyficzny dla ciężkiego profilu | Bez takiego pomiaru nie ma podstaw do globalnego cache manifestów ani opóźniania rejestracji rozszerzeń. |

Najbezpieczniejsza obecna opcja dla użytkownika, który chce maksymalnie szybkiego odsłonięcia okna, to wyłączenie „Opening animation” w ustawieniach. Jest domyślnie wyłączona. Sam szkielet UI i gotowość renderera nie wskazują dziś na poważny regres startu.

## Poprawka logo

Spakowany splash ładował kwadratową ikonę `app-icon-windows.png`, chociaż CSS kadrował obraz jak szeroki wordmark. Teraz ładuje już dołączony do paczki `app-wordmark.png`. Test źródłowy pilnuje zgodności z plikiem `assets/logos/vast.png`; kontrola uruchomionej paczki potwierdziła pełny napis 1584×396 i zrzut `performance-results/raw/logo-fix-splash.png`.

## Granice wniosków

Próby obejmowały prywatną paczkę testową i niewielkie dane użytkownika, bez pomiaru po restarcie Windows, na wolnym dysku, z dużą historią lub dziesiątkami rzeczywistych rozszerzeń. Interaktywny szkielet UI i znacznik gotowości to różne etapy; włączona animacja świadomie opóźnia widoczność. Żadna z powyższych liczb nie mierzy czasu załadowania zewnętrznej witryny internetowej.
