# Wokół mnie

Lekka aplikacja webowa (statyczna PWA, bez backendu): pełnoekranowe karty z polskiej Wikipedii
o miejscach w wybranym promieniu od ciebie — 500 m, 1 km, 3 km albo 5 km. Przesuwasz karty jak
w TikToku, przy każdej odpowiadasz „Wiedziałem” / „Nie wiedziałem”, a na końcu dostajesz wynik
(„Znasz 23% okolicy w promieniu 1 km”) do udostępnienia.

Dane pochodzą wprost z API `pl.wikipedia.org` (geosearch + podsumowania stron), zdjęcia z Wikimedia
Commons. Odpowiedzi i wybrany promień zapisują się lokalnie w przeglądarce (localStorage).

## Pliki

- `index.html`, `styles.css`, `app.js` — cała aplikacja (czysty HTML/CSS/JS, bez frameworków i bez budowania),
- `manifest.webmanifest`, `icon.svg`, `apple-touch-icon.png` — PWA-lite (dodanie do ekranu głównego),
- `tools/make-apple-icon.mjs` — generator `apple-touch-icon.png` (bez zależności: `node tools/make-apple-icon.mjs`),
- `tests/` — testy dymne Playwright z mockami Wikipedii (`tests/fixtures/`), zrzuty ekranu trafiają do `tests/artifacts/`.

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

## Zakres v0

Bez kont, backendu, service workera i analityki. Treści i zdjęcia: Wikipedia / Wikimedia Commons
(licencja CC BY-SA), każda karta linkuje do źródłowego artykułu.
