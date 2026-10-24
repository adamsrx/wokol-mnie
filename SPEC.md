# Wokół mnie — specyfikacja (v0 → v0.1 „nieskończony feed” → v0.2 „polubienia i zapisane”)

Lekka aplikacja webowa (PWA bez backendu): pełnoekranowe karty z polskiej Wikipedii o miejscach
wokół użytkownika, przesuwane jak TikTok. Feed nie kończy się na wybranym promieniu: po wyczerpaniu
kart pierścienia startowego sam dociąga kolejne pierścienie (500 m → 1 km → 3 km → 5 km → 10 km),
z kartą podsumowania między pierścieniami i jedną kartą końcową po 10 km. Od v0.2 nie ma quizu
ani licznika: w obrębie pierścienia karty idą w losowej kolejności (nieobejrzane najpierw), każdą
można polubić („Lubię”) i zapisać („Zapisz”) do lokalnej listy „Moje miejsca”. Cały interfejs po polsku.

## Zakres (v0 + v0.1 + v0.2, nic ponadto)

1. Ekran startowy
   - Tytuł „Wokół mnie”, jedno zdanie: „Co ciekawego jest kilkaset metrów od ciebie? Przesuwaj karty, polub to, co cię zaciekawi, i zapisz miejsca na później.”
   - Wybór promienia startowego jako chipsy: **500 m, 1 km, 3 km, 5 km, 10 km** (domyślnie 1 km; wybór zapamiętany w localStorage, w try/catch). To pierścień, od którego feed zaczyna — dalej idzie sam (§3).
   - Duży przycisk „Pokaż, co jest wokół” → `navigator.geolocation.getCurrentPosition` (timeout 10 s, enableHighAccuracy false).
   - Fallback bez GPS lub po odmowie: pole „Wpisz miejsce (np. Rynek Główny, Kraków)” → wyszukanie w Wikipedii strony ze współrzędnymi (`action=query&generator=search&gsrsearch=...&gsrlimit=5&prop=coordinates`) → pierwsza strona ze współrzędnymi staje się środkiem. Komunikaty błędów po polsku, bez przeprosin, z instrukcją co zrobić.

2. Dane z Wikipedii (pl.wikipedia.org, zawsze `origin=*`, `formatversion=2`)
   - Lista miejsc: `action=query&list=geosearch&gscoord=LAT|LON&gsradius=R&gslimit=100&gsnamespace=0` (R w metrach, max 10000; `gslimit=500` dla pierścieni ≥ 3 km). Pole `dist` to odległość w metrach, `lat`/`lon` — współrzędne (dla „Nawiguj”). Każdy pierścień to jedno takie zapytanie; miejsca z poprzednich pierścieni są odrzucane po `pageid`. Kolejność z API (po odległości) **nie** jest zachowywana w feedzie — patrz §3.
   - Szczegóły karty: leniwie, dla bieżącej karty i 3 następnych, z REST: `https://pl.wikipedia.org/api/rest_v1/page/summary/{tytuł zakodowany encodeURIComponent, spacje jako _}` → `extract`, `thumbnail.source`, `originalimage.source`, `content_urls.mobile.page`, `coordinates` (jeśli są — dokładniejszy cel dla „Nawiguj”). Gdy REST zawiedzie, fallback do `action=query&prop=extracts|pageimages&exintro=1&explaintext=1&exlimit=1&exsentences=3&piprop=thumbnail&pithumbsize=1000&pageids=ID`.
   - Ekstrakt skrócić do maks. 3 zdań / ~280 znaków z wielokropkiem.
   - Brak obrazka → placeholder generowany w CSS: kolor z hasha tytułu + duża pierwsza litera. Nigdy pusty czarny ekran.
   - Wszystkie fetch-e z obsługą błędów i jednym przyciskiem „Spróbuj ponownie”.

3. Karty (feed) — losowy, nieskończony feed w pierścieniach
   - Kontener pionowy `scroll-snap-type: y mandatory`, każda karta = 100% wysokości widocznego okna (użyć `100dvh` z fallbackiem `100vh`; `html, body { height: 100% }`).
   - Karta: tło (obraz, `object-fit: cover`) z gradientem od dołu, odznaka odległości („320 m stąd”, „1,4 km stąd”; polskie formatowanie, przecinek dziesiętny; odległości spoza promienia startowego wyglądają tak samo, np. „2,3 km stąd”), tytuł, ekstrakt (clamp 4–5 linii) oraz w jednym rzędzie dwa kompaktowe linki-pigułki z ikoną SVG:
     - „Czytaj w Wikipedii” (nowa karta, `rel=noopener`),
     - „Nawiguj” (`data-testid="card-navigate"`): trasa piesza w Mapach Google `https://www.google.com/maps/dir/?api=1&destination=LAT,LON&travelmode=walking`, współrzędne z kropką dziesiętną i 5 miejscami po przecinku, `target="_blank" rel="noopener"`, `aria-label="Nawiguj do: {tytuł}"`. Współrzędne z geosearch (zawsze są); gdy REST summary poda `coordinates`, te dokładniejsze mają pierwszeństwo.
   - Dwa duże przyciski-przełączniki na dole (min. 48 px, `aria-pressed`, wyraźny fokus): po lewej **„Zapisz”** (`data-testid="btn-save"`, ikona zakładki; wciśnięty = „Zapisane” z wypełnioną ikoną), po prawej **„Lubię”** (`data-testid="btn-like"`, ikona serca; wciśnięty = „Lubisz” z wypełnionym sercem). Oba są lokalne: `wm.likes` i `wm.saved` w localStorage jako mapy `pageid → timestamp`; dodatkowo `wm.savedPlaces` (`pageid → { title, lat, lon, url }`), żeby lista „Moje miejsca” działała między sesjami. Po polubieniu / zapisaniu nic się nie przewija — użytkownik dalej ogląda kartę.
   - Gesty: podwójne stuknięcie w zdjęcie = polubienie (duże serce na chwilę; przy `prefers-reduced-motion` bez animacji, serce po prostu pojawia się i znika). Przesunięcie poziome palcem/myszą (Pointer Events, próg 80 px): w prawo = polubienie (to samo serce; gest nigdy nie cofa polubienia), w lewo = następna karta (bez zapisu stanu). W trakcie przesuwania karta lekko się przechyla i pokazuje etykietę „Lubię” / „Dalej”. Pionowe przewijanie pozostaje natywne.
   - Licznik polubień: **nie pokazujemy żadnej liczby** (nie ma wspólnego backendu). Kod jest na to gotowy: obiekt `likes` z `isLiked(pageid)`, `toggle(pageid)`, `counts(pageids) → Promise<Map>` (dziś zawsze pusta mapa) oraz ukryty element `.like-count` na karcie, renderowany tylko dla znanej liczby.
   - Kolejność: pierścienie ładują się po promieniu, ale **w obrębie pierścienia miejsca są tasowane przy każdym załadowaniu** (świeże losowanie, bez zapisywania ziarna). Najpierw idą miejsca **nieobejrzane**, po nich obejrzane (też przetasowane). „Obejrzane” = karta była aktywną (przyciągniętą) kartą przez ≥ 1,5 s; `wm.seen` w localStorage to lista pageid-ów (maks. 2000, najstarsze wypadają; ponowne obejrzenie odświeża wpis). Deduplikacja po `pageid` zostaje. Dla testów `window.WM.rng.next` można podmienić (np. `() => 0.9999` daje kolejność z API).
   - Pierścienie: drabinka promieni **500 m → 1 km → 3 km → 5 km → 10 km**. Chip wybiera pierścień startowy. Gdy użytkownik jest w zasięgu 2 kart od końca załadowanego feedu (IntersectionObserver), aplikacja sama dociąga następny pierścień tym samym `geosearch` (`gslimit=500` dla promieni ≥ 3 km, inaczej 100), odrzuca `pageid` obecne już w feedzie, tasuje (nieobejrzane najpierw) i dokleja karty na końcu. Tak aż do 10 km (maksimum geosearch). Pierścień bez nowych miejsc nie dostaje karty — od razu ładuje się kolejny. Na końcu załadowanego feedu zawsze stoi karta ładowania („Szukam miejsc 1–3 km stąd…”, `data-testid="loading-card"`); błąd pierścienia zamienia ją na kartę błędu z „Spróbuj ponownie” tylko dla tego pierścienia (`ring-error`, `ring-retry`), załadowane karty zostają.
   - Karta pierścienia (`data-testid="ring-card"`, `data-radius`) po kartach każdego pierścienia poza ostatnim: nadtytuł „Promień 1 km”, tytuł „To wszystko w promieniu 1 km”, linia „Przejrzałeś 16 miejsc, polubiłeś 3, zapisałeś 2” (formy: 1 miejsce / 2–4 miejsca / 5+ miejsc; „polubiłeś N” zawsze, „zapisałeś N” tylko gdy N > 0), nad tytułem pasek do 3 ostatnio polubionych miejsc z tego pierścienia (miniatury z REST albo placeholder z pierwszą literą; tylko gdy są polubienia), główny przycisk „Udostępnij” (`ring-share`) oraz linia „Dalej: miejsca 1–3 km stąd” ze strzałką w dół — bez przycisku „Dalej”, po prostu przewijasz. Pusty pierścień startowy: „W promieniu 500 m nic nie ma” + „Dalej: miejsca 500 m–1 km stąd”, a następny pierścień ładuje się dalej.
   - Wydajność: karty renderują się przyrostowo (bieżąca + ~40 następnych w DOM, reszta czeka w stanie); szczegóły stron wciąż leniwie — bieżąca karta + 3 następne.
   - Pasek u góry (sticky): bez licznika. Po lewej przycisk **„Moje miejsca”** (`data-testid="my-places"`, ikona zakładki + liczba zapisanych miejsc w `my-places-count`, ukryta przy 0), po prawej „Zmień miejsce” (powrót do startu; wejście do feedu dodaje wpis historii, więc „wstecz” też wraca na start), pod nimi chipsy promienia startowego (zmiana = przeładowanie feedu od tego pierścienia dla tych samych współrzędnych, ze świeżym losowaniem; polubienia i zapisane zostają; pobrane szczegóły stron zostają w pamięci podręcznej).
   - Panel „Moje miejsca” (`data-testid="my-places-panel"`, `role="dialog"`, `aria-modal`): lista zapisanych miejsc od najnowszego — tytuł, odległość od bieżącego położenia (gdy znane; haversine od środka do współrzędnych miejsca), pigułki „Czytaj w Wikipedii” i „Nawiguj” (`saved-navigate`), przycisk „Usuń” (`saved-remove`). Stan pusty: „Nic jeszcze nie zapisałeś. Stuknij „Zapisz” na karcie miejsca.” Zamyka go przycisk „Zamknij” (`panel-close`), Escape i stuknięcie w tło; fokus krąży po panelu (prosta pułapka) i po zamknięciu wraca na „Moje miejsca”.

4. Karta końcowa
   - Dopiero po ostatnim pierścieniu (10 km): „To wszystko, co Wikipedia zna w promieniu 10 km”, linia łączna dla wszystkich załadowanych pierścieni („Przejrzałeś 56 miejsc, polubiłeś 7, zapisałeś 2”), pasek do 3 polubionych miejsc, przyciski: „Udostępnij” (Web Share API; fallback: kopiowanie do schowka + toast „Skopiowano”), „Zmień miejsce”, **„Od nowa”** (`end-restart`: czyści wyłącznie `wm.seen` — nigdy polubień ani zapisanych — i ładuje feed od pierścienia startowego ze świeżym losowaniem).
   - Tekst udostępnienia: `Odkryłem 16 miejsc w promieniu 1 km od siebie, 3 z nich polubiłem. Sprawdź swoją okolicę: {location.href bez hasha}` (z karty pierścienia — promień i liczby tego pierścienia; z karty końcowej — 10 km i liczby łączne).

5. Stany puste i błędy
   - Pusty pierścień startowy nie jest stanem pustym (patrz karta pierścienia). Stan pusty pojawia się dopiero, gdy wszystkie pierścienie do 10 km są puste: „Wikipedia nie zna żadnego miejsca w promieniu 10 km od tego punktu. Zmień miejsce.” + chipsy.
   - Brak sieci / błąd API przy pierwszym pierścieniu: pełnoekranowy komunikat + „Spróbuj ponownie”; przy dociąganiu kolejnego pierścienia — karta błędu na końcu feedu z „Spróbuj ponownie”, bez utraty załadowanych kart.
   - Odmowa geolokalizacji: pokazać fallback z polem tekstowym i zdanie, jak włączyć lokalizację.

6. PWA-lite
   - `manifest.webmanifest` (name „Wokół mnie”, short_name „Wokół mnie”, display standalone, theme_color, ikony jako SVG data URI lub plik `icon.svg`), `<meta name="theme-color">`, `apple-touch-icon` (PNG 180×180 wygenerowany skryptem lub SVG), `apple-mobile-web-app-capable`.
   - Bez service workera.
   - Wszystkie ścieżki względne, żeby działało z `file://`, z katalogu podrzędnego (GitHub Pages `/wokol-mnie/`) i z roota.

## Technologia

- Czysty HTML + CSS + JavaScript (ES2020), bez frameworków, bez kroku budowania. Pliki: `index.html`, `styles.css`, `app.js`, `manifest.webmanifest`, `icon.svg` (+ `apple-touch-icon.png` jeśli łatwo wygenerować).
- Czcionki: Google Fonts dozwolone (z `display=swap` i realnym fallbackiem systemowym). Unikać Inter/Space Grotesk jako jedynego wyboru.
- Kolory jako tokeny CSS w `:root`; projekt ciemny, immersyjny (pełnoekranowe zdjęcia), jeden akcent. Ma wyglądać jak terenowy przewodnik/kompas, nie jak generyczny szablon. Żadnych emoji jako ikon w UI (ikony inline SVG).
- Responsywność: telefon 360–430 px szerokości to główny cel, desktop ma być poprawny (karta wyśrodkowana, maks. szerokość ~520 px, tło przyciemnione). Zero przewijania poziomego strony.
- Dostępność: `aria-label` na przyciskach ikonowych, `aria-pressed` na przełącznikach, `prefers-reduced-motion` wyłącza animacje, kontrast tekstu na zdjęciu zapewniony gradientem, panel jako `role="dialog"` z pułapką fokusu.
- Dla testów: `window.WM = { state, loadAround(lat, lon, radiusM), loadNextRing(), like(pageid), save(pageid), markSeen(pageid), clearSeen(), rng, likes, saved }` oraz atrybuty `data-testid` na kluczowych elementach: `start-screen`, `radius-chip-500`, `radius-chip-1000`, `radius-chip-3000`, `radius-chip-5000`, `radius-chip-10000`, `start-button`, `place-input`, `place-submit`, `feed`, `card`, `card-title`, `card-distance`, `card-extract`, `card-navigate`, `btn-save`, `btn-like`, `like-count`, `my-places`, `my-places-count`, `my-places-panel`, `panel-close`, `my-places-empty`, `saved-row`, `saved-navigate`, `saved-remove`, `ring-card` (z `data-radius`), `ring-share`, `loading-card`, `ring-error`, `ring-retry`, `end-card`, `share-button`, `end-restart`, `empty-state`, `error-state`, `retry-button`, `change-place`.
- Zmienna `const WIKI_BASE = 'https://pl.wikipedia.org'` na górze `app.js`, żeby dało się ją podmienić w testach.

## Ograniczenia środowiska budowy

- W tym kontenerze **nie ma dostępu sieciowego do Wikipedii** (proxy zwraca 403). Buduj na podstawie dokumentacji API i testuj lokalnie z mockami (Playwright `page.route` z fixture JSON w `tests/fixtures/`). Realny test z Wikipedią zrobi użytkownik na telefonie lub po odblokowaniu domen `pl.wikipedia.org` i `upload.wikimedia.org`.
- Chromium jest zainstalowane; Playwright szuka go w `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`. Nie uruchamiaj `playwright install`.

## Poza zakresem (nie buduj)

Wspólny licznik polubień (backend), album odwiedzonych miejsc, GPS check-in, liga znajomych, treści od użytkowników, konta, service worker, analityka.
