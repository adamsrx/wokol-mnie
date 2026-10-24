# Wokół mnie — specyfikacja (v0 + v0.1 „nieskończony feed”)

Lekka aplikacja webowa (PWA bez backendu): pełnoekranowe karty z polskiej Wikipedii o miejscach
wokół użytkownika, przesuwane jak TikTok, z quizem „Wiedziałem / Nie wiedziałem” i wynikiem do
udostępnienia. Od v0.1 feed nie kończy się na wybranym promieniu: po wyczerpaniu kart pierścienia
startowego sam dociąga kolejne pierścienie (500 m → 1 km → 3 km → 5 km → 10 km), z kartą podsumowania
między pierścieniami i jedną kartą końcową po 10 km. Cały interfejs po polsku.

## Zakres (v0 + v0.1, nic ponadto)

1. Ekran startowy
   - Tytuł „Wokół mnie”, jedno zdanie: „Co ciekawego jest kilkaset metrów od ciebie? Przesuwaj karty i sprawdź, ile wiesz o swojej okolicy.”
   - Wybór promienia startowego jako chipsy: **500 m, 1 km, 3 km, 5 km, 10 km** (domyślnie 1 km; wybór zapamiętany w localStorage, w try/catch). To pierścień, od którego feed zaczyna — dalej idzie sam (§3).
   - Duży przycisk „Pokaż, co jest wokół” → `navigator.geolocation.getCurrentPosition` (timeout 10 s, enableHighAccuracy false).
   - Fallback bez GPS lub po odmowie: pole „Wpisz miejsce (np. Rynek Główny, Kraków)” → wyszukanie w Wikipedii strony ze współrzędnymi (`action=query&generator=search&gsrsearch=...&gsrlimit=5&prop=coordinates`) → pierwsza strona ze współrzędnymi staje się środkiem. Komunikaty błędów po polsku, bez przeprosin, z instrukcją co zrobić.

2. Dane z Wikipedii (pl.wikipedia.org, zawsze `origin=*`, `formatversion=2`)
   - Lista miejsc: `action=query&list=geosearch&gscoord=LAT|LON&gsradius=R&gslimit=100&gsnamespace=0` (R w metrach, max 10000; `gslimit=500` dla pierścieni ≥ 3 km). API zwraca posortowane po odległości; zachować tę kolejność. Pole `dist` to odległość w metrach, `lat`/`lon` — współrzędne (dla „Nawiguj”). Każdy pierścień to jedno takie zapytanie; miejsca z poprzednich pierścieni są odrzucane po `pageid`.
   - Szczegóły karty: leniwie, dla bieżącej karty i 3 następnych, z REST: `https://pl.wikipedia.org/api/rest_v1/page/summary/{tytuł zakodowany encodeURIComponent, spacje jako _}` → `extract`, `thumbnail.source`, `originalimage.source`, `content_urls.mobile.page`, `coordinates` (jeśli są — dokładniejszy cel dla „Nawiguj”). Gdy REST zawiedzie, fallback do `action=query&prop=extracts|pageimages&exintro=1&explaintext=1&exlimit=1&exsentences=3&piprop=thumbnail&pithumbsize=1000&pageids=ID`.
   - Ekstrakt skrócić do maks. 3 zdań / ~280 znaków z wielokropkiem.
   - Brak obrazka → placeholder generowany w CSS/Canvas: kolor z hasha tytułu + duża pierwsza litera. Nigdy pusty czarny ekran.
   - Wszystkie fetch-e z obsługą błędów i jednym przyciskiem „Spróbuj ponownie”.

3. Karty (feed) — od v0.1 „nieskończony feed” w pierścieniach
   - Kontener pionowy `scroll-snap-type: y mandatory`, każda karta = 100% wysokości widocznego okna (użyć `100dvh` z fallbackiem `100vh`; `html, body { height: 100% }`).
   - Karta: tło (obraz, `object-fit: cover`) z gradientem od dołu, odznaka odległości („320 m stąd”, „1,4 km stąd”; polskie formatowanie, przecinek dziesiętny; odległości spoza promienia startowego wyglądają tak samo, np. „2,3 km stąd”), tytuł, ekstrakt (clamp 4–5 linii) oraz w jednym rzędzie dwa kompaktowe linki-pigułki z ikoną SVG:
     - „Czytaj w Wikipedii” (nowa karta, `rel=noopener`),
     - „Nawiguj” (`data-testid="card-navigate"`): trasa piesza w Mapach Google `https://www.google.com/maps/dir/?api=1&destination=LAT,LON&travelmode=walking`, współrzędne z kropką dziesiętną i 5 miejscami po przecinku, `target="_blank" rel="noopener"`, `aria-label="Nawiguj do: {tytuł}"`. Współrzędne z geosearch (zawsze są); gdy REST summary poda `coordinates`, te dokładniejsze mają pierwszeństwo.
   - Dwa duże przyciski na dole: po lewej „Nie wiedziałem”, po prawej „Wiedziałem”. Minimalna wysokość dotyku 48 px. Wyraźny stan focus.
   - Gest: przesunięcie poziome palcem/myszą (Pointer Events, próg 80 px) w prawo = „Wiedziałem”, w lewo = „Nie wiedziałem”; w trakcie przesuwania karta lekko się przechyla i pokazuje etykietę. Pionowe przewijanie pozostaje natywne (nie przechwytywać, gdy ruch jest głównie pionowy).
   - Po odpowiedzi: karta oznaczona (znacznik „Wiedziałeś” / „Nie wiedziałeś”), automatyczne płynne przewinięcie do następnej karty bez odpowiedzi (albo do karty pierścienia) po ~250 ms. Odpowiedzi zapisane w localStorage jako `{ [pageid]: true|false }` i przywracane przy każdym załadowaniu listy (także po przeładowaniu strony): karta z zapamiętaną odpowiedzią jest już oznaczona, a feed startuje od pierwszej karty bez odpowiedzi (gdy wszystkie załadowane mają odpowiedź — od ostatniej karty pierścienia, pod którą ładuje się następny pierścień).
   - Pierścienie: drabinka promieni **500 m → 1 km → 3 km → 5 km → 10 km**. Chip wybiera pierścień startowy. Gdy karty pierścienia się kończą — użytkownik odpowiedział na ostatnią załadowaną kartę albo jest w zasięgu 2 kart od końca załadowanego feedu (IntersectionObserver) — aplikacja sama dociąga następny pierścień tym samym `geosearch` (`gslimit=500` dla promieni ≥ 3 km, inaczej 100), odrzuca `pageid` obecne już w feedzie, zachowuje kolejność z API (po odległości) i dokleja karty na końcu. Tak aż do 10 km (maksimum geosearch). Pierścień bez nowych miejsc nie dostaje karty — od razu ładuje się kolejny. Na końcu załadowanego feedu zawsze stoi karta ładowania („Szukam miejsc 1–3 km stąd…”, `data-testid="loading-card"`); błąd pierścienia zamienia ją na kartę błędu z „Spróbuj ponownie” tylko dla tego pierścienia (`ring-error`, `ring-retry`), załadowane karty zostają.
   - Karta pierścienia (`data-testid="ring-card"`, `data-radius`) po kartach każdego pierścienia poza ostatnim: tytuł „To wszystko w promieniu 1 km”, wynik pierścienia „Znasz 83% (5 z 6 miejsc)” z tym samym miernikiem co karta końcowa (mniejszym), główny przycisk „Udostępnij” (`ring-share`; tekst z promieniem i procentem pierścienia) oraz linia „Dalej: miejsca 1–3 km stąd” ze strzałką w dół — bez przycisku „Dalej”, po prostu przewijasz. Gdy w pierścieniu nie padła żadna odpowiedź: „Przewinąłeś 6 miejsc w promieniu 1 km” (bez miernika i udostępniania). Pusty pierścień startowy: „W promieniu 500 m nic nie ma” + „Dalej: miejsca 500 m–1 km stąd”, a następny pierścień ładuje się dalej.
   - Wydajność: karty renderują się przyrostowo (bieżąca + ~40 następnych w DOM, reszta czeka w stanie); szczegóły stron wciąż leniwie — bieżąca karta + 3 następne.
   - Pasek u góry (sticky): „3 z 24 · znasz 2” — numer bieżącej karty miejsca i liczba wszystkich załadowanych kart miejsc (karty pierścieni i karta końcowa nie liczą się; po doklejeniu pierścienia suma rośnie). Chipsy promienia startowego: zmiana = przeładowanie feedu od tego pierścienia dla tych samych współrzędnych; miejsca, na które użytkownik już odpowiedział, nie są pytane ponownie — ich odpowiedzi wracają po `pageid`; pobrane szczegóły stron zostają w pamięci podręcznej. Przycisk „Zmień miejsce” (powrót do startu; wejście do feedu dodaje wpis historii, więc „wstecz” też wraca na start).

4. Karta końcowa
   - Dopiero po ostatnim pierścieniu (10 km): „To wszystko, co Wikipedia zna w promieniu 10 km”, łączny wynik wszystkich załadowanych pierścieni „Znasz 41% (23 z 56 miejsc)” (zaokrąglone do pełnych procentów), przyciski: „Udostępnij” (Web Share API; fallback: kopiowanie do schowka + toast „Skopiowano”), „Zmień miejsce”, „Jeszcze raz” (usuwa z localStorage odpowiedzi dla miejsc ze wszystkich załadowanych pierścieni i wraca na pierwszą kartę). Nie ma „Zwiększ promień” — feed sam doszedł do 10 km.
   - Tekst udostępnienia: `Znam 41% miejsc w promieniu 10 km od siebie. Sprawdź swoją okolicę: {location.href bez hasha}`; z karty pierścienia analogicznie, z promieniem i procentem tego pierścienia.

5. Stany puste i błędy
   - Pusty pierścień startowy nie jest stanem pustym (patrz karta pierścienia). Stan pusty pojawia się dopiero, gdy wszystkie pierścienie do 10 km są puste: „Wikipedia nie zna żadnego miejsca w promieniu 10 km od tego punktu. Zmień miejsce.” + chipsy.
   - Brak sieci / błąd API przy pierwszym pierścieniu: pełnoekranowy komunikat + „Spróbuj ponownie”; przy dociąganiu kolejnego pierścienia — karta błędu na końcu feedu z „Spróbuj ponownie”, bez utraty załadowanych kart.
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
- Dla testów: `window.WM = { state, loadAround(lat, lon, radiusM), answer(pageid, known), loadNextRing() }` oraz atrybuty `data-testid` na kluczowych elementach: `start-screen`, `radius-chip-500`, `radius-chip-1000`, `radius-chip-3000`, `radius-chip-5000`, `radius-chip-10000`, `start-button`, `place-input`, `place-submit`, `feed`, `card`, `card-title`, `card-distance`, `card-extract`, `card-navigate`, `btn-known`, `btn-unknown`, `progress`, `ring-card` (z `data-radius`), `ring-share`, `loading-card`, `ring-error`, `ring-retry`, `end-card`, `share-button`, `empty-state`, `error-state`, `retry-button`, `change-place`.
- Zmienna `const WIKI_BASE = 'https://pl.wikipedia.org'` na górze `app.js`, żeby dało się ją podmienić w testach.

## Ograniczenia środowiska budowy

- W tym kontenerze **nie ma dostępu sieciowego do Wikipedii** (proxy zwraca 403). Buduj na podstawie dokumentacji API i testuj lokalnie z mockami (Playwright `page.route` z fixture JSON w `tests/fixtures/`). Realny test z Wikipedią zrobi użytkownik na telefonie lub po odblokowaniu domen `pl.wikipedia.org` i `upload.wikimedia.org`.
- Chromium jest zainstalowane; Playwright szuka go w `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`. Nie uruchamiaj `playwright install`.

## Poza zakresem (nie buduj)

Album odwiedzonych miejsc, GPS check-in, liga znajomych, treści od użytkowników, konta, backend, service worker, analityka.
