# Wokół mnie

Lekka aplikacja webowa (statyczna PWA, bez backendu): pełnoekranowe karty z polskiej Wikipedii
o miejscach wokół ciebie. Przesuwasz karty jak w TikToku, przy każdej odpowiadasz „Wiedziałem” /
„Nie wiedziałem”, a feed nie ma końca w zasięgu Wikipedii: zaczyna od wybranego promienia (500 m,
1 km, 3 km, 5 km albo 10 km) i gdy karty się kończą, sam dociąga kolejne pierścienie — aż do 10 km.
Między pierścieniami dostajesz podsumowanie („Znasz 83% (5 z 6 miejsc)” w promieniu 1 km) do
udostępnienia, a po 10 km kartę końcową z wynikiem łącznym. Każda karta ma link „Czytaj w Wikipedii”
i „Nawiguj” (trasa piesza w Mapach Google).

Dane pochodzą wprost z API `pl.wikipedia.org` (geosearch + podsumowania stron), zdjęcia z Wikimedia
Commons. Odpowiedzi i wybrany promień startowy zapisują się lokalnie w przeglądarce (localStorage).

## Jak działa feed (v0.1 „nieskończony feed”)

- Promienie idą drabinką **500 m → 1 km → 3 km → 5 km → 10 km**; chip na starcie (i w pasku) wybiera
  pierścień startowy. Gdy jesteś 2 karty od końca albo odpowiesz na ostatnią kartę, aplikacja pobiera
  następny pierścień, pomija miejsca już pokazane i dokleja nowe karty w kolejności odległości.
- Po kartach pierścienia jest karta podsumowania: wynik tego pierścienia, „Udostępnij” i zapowiedź
  „Dalej: miejsca 1–3 km stąd” — wystarczy przewinąć dalej. Pusty pierścień startowy pokazuje
  „W promieniu 500 m nic nie ma” i od razu szuka dalej; pusty dalszy pierścień jest pomijany.
- Po 10 km (maksimum Wikipedii) pojawia się karta końcowa: „To wszystko, co Wikipedia zna w promieniu
  10 km”, łączny wynik, „Udostępnij”, „Zmień miejsce”, „Jeszcze raz”. Stan „Tu jest pusto” pojawia się
  tylko wtedy, gdy w żadnym pierścieniu do 10 km nic nie ma.
- Licznik w pasku („3 z 24 · znasz 2”) liczy karty miejsc ze wszystkich załadowanych pierścieni.
- „Nawiguj” otwiera `https://www.google.com/maps/dir/?api=1&destination=LAT,LON&travelmode=walking`
  ze współrzędnymi miejsca (z geosearch, a gdy Wikipedia poda dokładniejsze w podsumowaniu — z nich).

## Pliki

- `index.html`, `styles.css`, `app.js` — cała aplikacja (czysty HTML/CSS/JS, bez frameworków i bez budowania),
- `manifest.webmanifest`, `icon.svg`, `apple-touch-icon.png` — PWA-lite (dodanie do ekranu głównego),
- `tools/make-apple-icon.mjs` — generator `apple-touch-icon.png` (bez zależności: `node tools/make-apple-icon.mjs`),
- `tests/` — testy dymne Playwright z mockami Wikipedii (`tests/fixtures/`: geosearch dla 1, 3, 5 i 10 km z nakładającymi się miejscami, podsumowania, zdjęcia), zrzuty ekranu trafiają do `tests/artifacts/`.

## Uruchomienie lokalne

Wystarczy dowolny statyczny serwer. Na przykład:

```bash
python3 -m http.server 8080
```

i otwórz `http://localhost:8080/`. Geolokalizacja działa na `localhost` i na HTTPS; po wejściu
z telefonu przez adres IP w sieci lokalnej (HTTP) przeglądarka nie udostępni GPS — wtedy użyj
pola „Wpisz miejsce”. Plik `index.html` otwiera się też bezpośrednio z dysku (`file://`).

## Testy

```bash
npm install          # instaluje Playwright (przeglądarki: `npx playwright install chromium`, jeśli ich nie masz)
npm test
```

`npm test` uruchamia `playwright test`: serwuje katalog przez `python3 -m http.server`, a każde
żądanie do `pl.wikipedia.org`, `upload.wikimedia.org` i Google Fonts przechwytuje i zastępuje
danymi z `tests/fixtures/`. Testy przechodzą dwa razy: w widoku telefonu (390×844) i desktopu
(1280×800). Każdy test oblewa się na dowolnym błędzie w konsoli przeglądarki.

Dodatkowy zestaw QA (API, funkcje, UX na 360×640 / 430×932 / desktop):

```bash
npx playwright test -c tests/qa/playwright.qa.config.mjs
```

## Wdrożenie na GitHub Pages

To są wyłącznie pliki statyczne, bez kroku budowania:

1. Wypchnij repozytorium na GitHub.
2. W ustawieniach repozytorium: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   gałąź `main`, katalog `/ (root)`.
3. Po chwili aplikacja będzie pod `https://<użytkownik>.github.io/<repozytorium>/`.

Wszystkie ścieżki w aplikacji są względne, więc działa zarówno z podkatalogu (`/wokol-mnie/`),
jak i z roota własnej domeny. `node_modules/` i `tests/artifacts/` są w `.gitignore` i nie
trafiają na Pages.

## Zakres

Bez kont, backendu, service workera i analityki. Treści i zdjęcia: Wikipedia / Wikimedia Commons
(licencja CC BY-SA), każda karta linkuje do źródłowego artykułu.
