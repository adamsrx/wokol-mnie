# Wokół mnie

Lekka aplikacja webowa (statyczna PWA, bez backendu): pełnoekranowe karty z polskiej Wikipedii
o miejscach wokół ciebie. Przesuwasz karty jak w TikToku, polubiasz to, co cię zaciekawi („Lubię”),
zapisujesz miejsca na później („Zapisz” → „Moje miejsca”), a feed nie ma końca w zasięgu Wikipedii:
zaczyna od wybranego promienia (500 m, 1 km, 3 km, 5 km albo 10 km) i gdy karty się kończą, sam
dociąga kolejne pierścienie — aż do 10 km. Każde uruchomienie zaczyna inaczej: karty w pierścieniu
są tasowane, a miejsca, które już oglądałeś, idą na koniec. Każda karta ma link „Czytaj w Wikipedii”
i „Nawiguj” (trasa piesza w Mapach Google).

Dane pochodzą wprost z API `pl.wikipedia.org` (geosearch + podsumowania stron), zdjęcia z Wikimedia
Commons. Polubienia, zapisane miejsca, obejrzane karty i promień startowy zapisują się lokalnie
w przeglądarce (localStorage) — nic nie opuszcza telefonu.

## Jak działa feed (v0.2)

- Promienie idą drabinką **500 m → 1 km → 3 km → 5 km → 10 km**; chip na starcie (i w pasku) wybiera
  pierścień startowy. Gdy jesteś 2 karty od końca, aplikacja pobiera następny pierścień, pomija
  miejsca już pokazane i dokleja nowe karty — przetasowane, nieobejrzane najpierw.
- „Obejrzana” karta to taka, na której zatrzymałeś się na co najmniej 1,5 s (pamiętanych jest
  2000 ostatnich). Przy kolejnym uruchomieniu takie miejsca lądują na końcu pierścienia.
- Na karcie: **„Zapisz”** (trafia do „Moje miejsca” w pasku, z odległością i linkami) i **„Lubię”**.
  Polubić można też podwójnym stuknięciem w zdjęcie albo przesunięciem karty w prawo; przesunięcie
  w lewo przechodzi do następnej karty. Polubienia są na razie tylko lokalne — żadnych liczb.
- Po kartach pierścienia jest karta podsumowania: „Przejrzałeś 16 miejsc, polubiłeś 3, zapisałeś 2”,
  miniatury polubionych miejsc, „Udostępnij” i zapowiedź „Dalej: miejsca 1–3 km stąd” — wystarczy
  przewinąć dalej. Pusty pierścień startowy pokazuje „W promieniu 500 m nic nie ma” i od razu szuka
  dalej; pusty dalszy pierścień jest pomijany.
- Po 10 km (maksimum Wikipedii) pojawia się karta końcowa: „To wszystko, co Wikipedia zna w promieniu
  10 km”, podsumowanie łączne, „Udostępnij”, „Zmień miejsce”, „Od nowa” (zapomina obejrzane karty —
  polubienia i zapisane zostają — i losuje feed jeszcze raz). Stan „Tu jest pusto” pojawia się tylko
  wtedy, gdy w żadnym pierścieniu do 10 km nic nie ma.
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
(1280×800). Każdy test oblewa się na dowolnym błędzie w konsoli przeglądarki. Losowanie kolejności
testy unieruchamiają przez `window.WM.rng.next` (osobny test sprawdza prawdziwą losowość).

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

Bez kont, backendu, wspólnego licznika polubień, service workera i analityki. Treści i zdjęcia:
Wikipedia / Wikimedia Commons (licencja CC BY-SA), każda karta linkuje do źródłowego artykułu.
