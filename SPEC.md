# Wokół mnie — specyfikacja wersji zero (v0)

Lekka aplikacja webowa (PWA bez backendu): pełnoekranowe karty z polskiej Wikipedii o miejscach
w wybranym promieniu od użytkownika, przesuwane jak TikTok, z quizem „Wiedziałem / Nie wiedziałem”
i wynikiem do udostępnienia. Cały interfejs po polsku.

## Zakres v0 (nic ponadto)

1. Ekran startowy
   - Tytuł „Wokół mnie”, jedno zdanie: „Co ciekawego jest kilkaset metrów od ciebie? Przesuwaj karty i sprawdź, ile wiesz o swojej okolicy.”
   - Wybór promienia jako chipsy: **500 m, 1 km, 3 km, 5 km** (domyślnie 1 km; wybór zapamiętany w localStorage, w try/catch).
   - Duży przycisk „Pokaż, co jest wokół” → `navigator.geolocation.getCurrentPosition` (timeout 10 s, enableHighAccuracy false).
   - Fallback bez GPS lub po odmowie: pole „Wpisz miejsce (np. Rynek Główny, Kraków)” → wyszukanie w Wikipedii strony ze współrzędnymi (`action=query&generator=search&gsrsearch=...&gsrlimit=5&prop=coordinates`) → pierwsza strona ze współrzędnymi staje się środkiem. Komunikaty błędów po polsku, bez przeprosin, z instrukcją co zrobić.

2. Dane z Wikipedii (pl.wikipedia.org, zawsze `origin=*`, `formatversion=2`)
   - Lista miejsc: `action=query&list=geosearch&gscoord=LAT|LON&gsradius=R&gslimit=100&gsnamespace=0` (R w metrach, max 10000). API zwraca posortowane po odległości; zachować tę kolejność. Pole `dist` to odległość w metrach.
   - Szczegóły karty: leniwie, dla bieżącej karty i 3 następnych, z REST: `https://pl.wikipedia.org/api/rest_v1/page/summary/{tytuł zakodowany encodeURIComponent, spacje jako _}` → `extract`, `thumbnail.source`, `originalimage.source`, `content_urls.mobile.page`. Gdy REST zawiedzie, fallback do `action=query&prop=extracts|pageimages&exintro=1&explaintext=1&exlimit=1&exsentences=3&piprop=thumbnail&pithumbsize=1000&pageids=ID`.
   - Ekstrakt skrócić do maks. 3 zdań / ~280 znaków z wielokropkiem.
   - Brak obrazka → placeholder generowany w CSS/Canvas: kolor z hasha tytułu + duża pierwsza litera. Nigdy pusty czarny ekran.
   - Wszystkie fetch-e z obsługą błędów i jednym przyciskiem „Spróbuj ponownie”.

3. Karty (feed)
   - Kontener pionowy `scroll-snap-type: y mandatory`, każda karta = 100% wysokości widocznego okna (użyć `100dvh` z fallbackiem `100vh`; `html, body { height: 100% }`).
   - Karta: tło (obraz, `object-fit: cover`) z gradientem od dołu, odznaka odległości („320 m stąd”, „1,4 km stąd”; polskie formatowanie, przecinek dziesiętny), tytuł, ekstrakt (clamp 4–5 linii), link „Czytaj w Wikipedii” (nowa karta, `rel=noopener`).
   - Dwa duże przyciski na dole: po lewej „Nie wiedziałem”, po prawej „Wiedziałem”. Minimalna wysokość dotyku 48 px. Wyraźny stan focus.
   - Gest: przesunięcie poziome palcem/myszą (Pointer Events, próg 80 px) w prawo = „Wiedziałem”, w lewo = „Nie wiedziałem”; w trakcie przesuwania karta lekko się przechyla i pokazuje etykietę. Pionowe przewijanie pozostaje natywne (nie przechwytywać, gdy ruch jest głównie pionowy).
   - Po odpowiedzi: karta oznaczona (znacznik „Wiedziałeś” / „Nie wiedziałeś”), automatyczne płynne przewinięcie do następnej karty bez odpowiedzi po ~250 ms. Odpowiedzi zapisane w localStorage jako `{ [pageid]: true|false }` i przywracane przy każdym załadowaniu listy (także po przeładowaniu strony): karta z zapamiętaną odpowiedzią jest już oznaczona, a feed startuje od pierwszej karty bez odpowiedzi (gdy wszystkie mają odpowiedź — od karty końcowej).
   - Pasek u góry (sticky): „3 z 24 · znasz 2”, chipsy promienia (zmiana = przeładowanie listy dla tych samych współrzędnych; licznik liczony od nowa dla nowej listy, ale miejsca, na które użytkownik już odpowiedział, nie są pytane ponownie — ich odpowiedzi wracają po `pageid`; pobrane szczegóły stron zostają w pamięci podręcznej i nie są pobierane drugi raz), przycisk „Zmień miejsce” (powrót do startu; wejście do feedu dodaje wpis historii, więc „wstecz” też wraca na start).

4. Karta końcowa
   - Gdy wszystkie karty odpowiedziane lub lista się skończyła: „Znasz 23% okolicy w promieniu 1 km” (zaokrąglone do pełnych procentów), „Wiedziałeś o 5 z 22 miejsc”, przyciski: „Udostępnij” (Web Share API; fallback: kopiowanie do schowka + toast „Skopiowano”), „Zwiększ promień” (następny chip), „Jeszcze raz” (usuwa z localStorage odpowiedzi dla miejsc z bieżącej listy i wraca na pierwszą kartę).
   - Tekst udostępnienia: `Znam 23% miejsc w promieniu 1 km od siebie. Sprawdź swoją okolicę: {location.href bez hasha}`.

5. Stany puste i błędy
   - 0 wyników: „W promieniu 500 m Wikipedia nie zna żadnego miejsca. Zwiększ promień.” + chipsy.
   - Brak sieci / błąd API: komunikat + „Spróbuj ponownie”.
   - Odmowa geolokalizacji: pokazać fallback z polem tekstowym i zdanie, jak włączyć lokalizację.

6. PWA-lite
   - `manifest.webmanifest` (name „Wokół mnie”, short_name „Wokół mnie”, display standalone, theme_color, ikony jako SVG data URI lub plik `icon.svg`), `<meta name="theme-color">`, `apple-touch-icon` (PNG 180×180 wygenerowany skryptem lub SVG), `apple-mobile-web-app-capable`.
   - Bez service workera w v0.
   - Wszystkie ścieżki względne, żeby działało z `file://`, z katalogu podrzędnego (GitHub Pages `/wokol-mnie/`) i z roota.

## Technologia

- Czysty HTML + CSS + JavaScript (ES2020), bez frameworków, bez kroku budowania. Pliki: `index.html`, `styles.css`, `app.js`, `manifest.webmanifest`, `icon.svg` (+ `apple-touch-icon.png` jeśli łatwo wygenerować).
- Czcionki: Google Fonts dozwolone (z `display=swap` i realnym fallbackiem systemowym). Unikać Inter/Space Grotesk jako jedynego wyboru.
- Kolory jako tokeny CSS w `:root`; projekt ciemny, immersyjny (pełnoekranowe zdjęcia), jeden akcent. Ma wyglądać jak terenowy przewodnik/kompas, nie jak generyczny szablon. Żadnych emoji jako ikon w UI (ikony inline SVG).
- Responsywność: telefon 360–430 px szerokości to główny cel, desktop ma być poprawny (karta wyśrodkowana, maks. szerokość ~520 px, tło przyciemnione). Zero przewijania poziomego strony.
- Dostępność: `aria-label` na przyciskach ikonowych, `prefers-reduced-motion` wyłącza animacje, kontrast tekstu na zdjęciu zapewniony gradientem.
- Dla testów: `window.WM = { state, loadAround(lat, lon, radiusM), answer(pageid, known) }` oraz atrybuty `data-testid` na kluczowych elementach: `start-screen`, `radius-chip-500`, `radius-chip-1000`, `radius-chip-3000`, `radius-chip-5000`, `start-button`, `place-input`, `place-submit`, `feed`, `card`, `card-title`, `card-distance`, `card-extract`, `btn-known`, `btn-unknown`, `progress`, `end-card`, `share-button`, `empty-state`, `error-state`, `retry-button`, `change-place`.
- Zmienna `const WIKI_BASE = 'https://pl.wikipedia.org'` na górze `app.js`, żeby dało się ją podmienić w testach.

## Ograniczenia środowiska budowy

- W tym kontenerze **nie ma dostępu sieciowego do Wikipedii** (proxy zwraca 403). Buduj na podstawie dokumentacji API i testuj lokalnie z mockami (Playwright `page.route` z fixture JSON w `tests/fixtures/`). Realny test z Wikipedią zrobi użytkownik na telefonie lub po odblokowaniu domen `pl.wikipedia.org` i `upload.wikimedia.org`.
- Chromium jest zainstalowane; Playwright szuka go w `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`. Nie uruchamiaj `playwright install`.

## Poza zakresem v0 (nie buduj)

Album odwiedzonych miejsc, GPS check-in, liga znajomych, treści od użytkowników, konta, backend, service worker, analityka.
