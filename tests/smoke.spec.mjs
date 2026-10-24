// Testy dymne „Wokół mnie”. Wszystkie żądania do pl.wikipedia.org, upload.wikimedia.org i Google Fonts
// są mockowane przez page.route — kontener budowy nie ma dostępu do Wikipedii.
// Uruchomienie: `npm test` (projekty: mobile 390×844 i desktop 1280×800, zrzuty w tests/artifacts/).
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const FIX = {
  g1000: fixture('geosearch-1000.json'),
  g3000: fixture('geosearch-3000.json'),
  g5000: fixture('geosearch-5000.json'),
  g10000: fixture('geosearch-10000.json'),
  gEmpty: fixture('geosearch-empty.json'),
  gKrakow: fixture('geosearch-krakow.json'),
  summaries: fixture('summaries.json'),
  extracts: fixture('extracts.json'),
  searchKrakow: fixture('search-krakow.json'),
  searchNone: fixture('search-none.json'),
};
const PHOTOS = [1, 2, 3].map((i) => readFileSync(join(here, 'fixtures', `photo-${i}.svg`), 'utf8'));
const WARSAW = { latitude: 52.2497, longitude: 21.0122 };
const ARTIFACTS = join(here, 'artifacts');
const DISTANCE_RE = /\d+ m stąd|\d,\d km stąd/;
const NAVIGATE_RE = /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=-?\d{1,2}\.\d{5},-?\d{1,3}\.\d{5}&travelmode=walking$/;
const IDS_1000 = [35201, 123, 76112, 48803, 90455, 51277];

const json = (body, status = 200) => ({
  status,
  contentType: 'application/json; charset=utf-8',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Mock Wikipedii. Fixtury geosearch zależą od promienia (500 m → nic, 1 km → 6, 3 km → 9, 5 km → 11, 10 km → 14 miejsc;
   kolejne pierścienie zawierają miejsca poprzednich, co sprawdza odfiltrowanie duplikatów).
   Opcje: geosearchFailures (ile pierwszych geosearch ma zwrócić 500), empty (zawsze 0 wyników),
   failRadius (promień, którego pierwsze zapytanie zwraca 500), slowRadius + slowMs (opóźnienie odpowiedzi dla promienia). */
async function mockWikipedia(page, options = {}) {
  const opts = { geosearchFailures: 0, empty: false, failRadius: null, slowRadius: null, slowMs: 1200, ...options };
  const log = { requests: [] };

  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  await page.route('https://upload.wikimedia.org/**', (route) => {
    const url = route.request().url();
    let h = 0;
    for (const ch of url) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      headers: { 'access-control-allow-origin': '*' },
      body: PHOTOS[h % PHOTOS.length],
    });
  });

  await page.route('https://pl.wikipedia.org/**', async (route) => {
    const url = new URL(route.request().url());
    log.requests.push(url.href);

    if (url.pathname.startsWith('/api/rest_v1/page/summary/')) {
      const title = decodeURIComponent(url.pathname.slice('/api/rest_v1/page/summary/'.length)).replace(/_/g, ' ');
      const summary = FIX.summaries[title];
      if (summary) return route.fulfill(json(summary));
      return route.fulfill(json({
        type: 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found',
        title: 'Not found.',
        method: 'get',
        detail: 'Page or revision not found.',
        uri: url.pathname,
      }, 404));
    }

    if (url.pathname === '/w/api.php') {
      const p = url.searchParams;
      expect(p.get('format')).toBe('json');
      expect(p.get('formatversion')).toBe('2');
      expect(p.get('origin')).toBe('*');

      if (p.get('list') === 'geosearch') {
        const radius = Number(p.get('gsradius'));
        const fail = () => route.fulfill({ status: 500, contentType: 'text/html', headers: { 'access-control-allow-origin': '*' }, body: 'Internal Server Error' });
        if (opts.geosearchFailures > 0) { opts.geosearchFailures -= 1; return fail(); }
        if (opts.failRadius === radius) { opts.failRadius = null; return fail(); }
        if (opts.slowRadius === radius) await sleep(opts.slowMs);
        if (opts.empty) return route.fulfill(json(FIX.gEmpty));
        if ((p.get('gscoord') || '').startsWith('50.06')) return route.fulfill(json(FIX.gKrakow));
        if (radius >= 10000) return route.fulfill(json(FIX.g10000));
        if (radius >= 5000) return route.fulfill(json(FIX.g5000));
        if (radius >= 3000) return route.fulfill(json(FIX.g3000));
        if (radius >= 1000) return route.fulfill(json(FIX.g1000));
        return route.fulfill(json(FIX.gEmpty));
      }
      if (p.get('prop') === 'extracts|pageimages') {
        const pages = (p.get('pageids') || '').split('|').map((id) => FIX.extracts[id]).filter(Boolean);
        return route.fulfill(json({ batchcomplete: true, query: { pages } }));
      }
      if (p.get('generator') === 'search') {
        const q = (p.get('gsrsearch') || '').toLowerCase();
        return route.fulfill(json(/krak|rynek/.test(q) ? FIX.searchKrakow : FIX.searchNone));
      }
    }
    return route.fulfill(json({ error: { code: 'unmocked', info: `Niezamockowane żądanie: ${url.href}` } }, 404));
  });

  return log;
}

/* Każdy test zbiera błędy konsoli i pageerror; niepuste = test oblany.
   Dozwolone są wyłącznie wpisy „Failed to load resource” dla odpowiedzi, które mock celowo zwraca jako błąd
   (REST 404 dla jednej strony → ścieżka zapasowa; 500 w testach błędu API). */
const test = base.extend({
  consoleErrors: [async ({ page }, use) => {
    const errors = [];
    errors.allow = [/Failed to load resource.*rest_v1\/page\/summary\/Rynek_Starego_Miasta_w_Warszawie/];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`[console] ${msg.text()} (${msg.location().url})`);
    });
    page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
    await use(errors);
    const unexpected = errors.filter((e) => e.startsWith('[pageerror]') || !errors.allow.some((rx) => rx.test(e)));
    expect(unexpected, 'błędy w konsoli przeglądarki').toEqual([]);
  }, { auto: true }],
});

const shot = (testInfo, name) => join(ARTIFACTS, `${testInfo.project.name}-${name}.png`);

/* Promienie wszystkich dotychczasowych zapytań geosearch, w kolejności. */
const geoRadii = (log) => log.requests.map((u) => new URL(u)).filter((u) => u.searchParams.get('list') === 'geosearch').map((u) => u.searchParams.get('gsradius'));

/* Kolejność elementów feedu: 'card' | 'ring-card:1000' | 'loading-card' | 'end-card'. */
const feedOrder = (page) => page.evaluate(() => [...document.querySelectorAll('#feed > *')]
  .map((el) => el.dataset.testid + (el.dataset.radius ? `:${el.dataset.radius}` : '')));

const placeIds = (page) => page.evaluate(() => window.WM.state.places.map((p) => p.pageid));

/* Odpowiada hakiem testowym po kolei na podane miejsca: [[pageid, known], …]. */
async function answerIds(page, answers) {
  for (const pair of answers) {
    await page.evaluate(([pageid, known]) => window.WM.answer(pageid, known), pair);
  }
}

async function expectNoHorizontalScroll(page) {
  const m = await page.evaluate(() => ({
    docScroll: document.documentElement.scrollWidth,
    docClient: document.documentElement.clientWidth,
    bodyScroll: document.body.scrollWidth,
    feed: (() => { const f = document.getElementById('feed'); return f && !f.hidden ? [f.scrollWidth, f.clientWidth] : null; })(),
  }));
  expect(m.docScroll, 'scrollWidth dokumentu').toBeLessThanOrEqual(m.docClient);
  expect(m.bodyScroll, 'scrollWidth body').toBeLessThanOrEqual(m.docClient);
  if (m.feed) expect(m.feed[0], 'scrollWidth feedu').toBeLessThanOrEqual(m.feed[1]);
}

/* Gest dotykowy przez CDP (Input.dispatchTouchEvent) — page.mouse generuje tylko zdarzenia myszy. */
async function touchSwipe(page, from, dx, dy, steps = 12) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (dx * i) / steps, y: from.y + (dy * i) / steps }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

/* Ścieżka GPS: start → feed z kartami. Zwraca dziennik żądań mocka. */
async function startFeed(page, options) {
  const log = await mockWikipedia(page, options);
  await page.goto('./');
  await page.getByTestId('start-button').click();
  await expect(page.getByTestId('feed')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('card').first()).toBeVisible({ timeout: 10_000 });
  return log;
}

test.describe('Wokół mnie — smoke', () => {
  test.use({ geolocation: WARSAW, permissions: ['geolocation'] });

  test('ekran startowy: 5 chipsów promienia startowego, domyślnie 1 km', async ({ page }, testInfo) => {
    await mockWikipedia(page);
    await page.goto('./');
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Wokół mnie' })).toBeVisible();
    await expect(page.getByText('Co ciekawego jest kilkaset metrów od ciebie?')).toBeVisible();
    for (const r of [500, 1000, 3000, 5000, 10000]) {
      await expect(page.getByTestId(`radius-chip-${r}`)).toBeVisible();
    }
    await expect(page.getByTestId('radius-chip-1000')).toHaveAttribute('aria-checked', 'true');
    for (const r of [500, 3000, 5000, 10000]) {
      await expect(page.getByTestId(`radius-chip-${r}`)).toHaveAttribute('aria-checked', 'false');
    }
    await expect(page.getByTestId('radius-chip-1000')).toHaveText('1 km');
    await expect(page.getByTestId('radius-chip-10000')).toHaveText('10 km');
    await expect(page.getByTestId('start-button')).toBeVisible();
    await expect(page.getByTestId('start-button')).toHaveText(/Pokaż, co jest wokół/);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: shot(testInfo, '01-start') });
  });

  test('ścieżka GPS: ładuje co najmniej jedną kartę w ciągu 10 s; tylko pierścień startowy', async ({ page, context }) => {
    const log = await mockWikipedia(page);
    await context.setGeolocation(WARSAW);
    await page.goto('./');
    const started = Date.now();
    await page.getByTestId('start-button').click();
    await expect(page.getByTestId('card').first()).toBeVisible({ timeout: 10_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect(page.getByTestId('start-screen')).toBeHidden();
    await expect(page.getByTestId('card')).toHaveCount(6);
    await expect(page.getByTestId('progress')).toHaveText('1 z 6 · znasz 0');

    const geo = log.requests.map((u) => new URL(u)).find((u) => u.searchParams.get('list') === 'geosearch');
    expect(geo).toBeTruthy();
    expect(geo.searchParams.get('gscoord')).toBe('52.2497|21.0122');
    expect(geo.searchParams.get('gsradius')).toBe('1000');
    expect(geo.searchParams.get('gslimit')).toBe('100');
    expect(geo.searchParams.get('gsnamespace')).toBe('0');
    const state = await page.evaluate(() => ({ screen: window.WM.state.screen, n: window.WM.state.places.length, radius: window.WM.state.radius }));
    expect(state).toEqual({ screen: 'feed', n: 6, radius: 1000 });
    // Na pierwszej karcie następny pierścień jeszcze nie jest pobierany; na końcu feedu stoi karta ładowania.
    expect(geoRadii(log)).toEqual(['1000']);
    expect(await feedOrder(page)).toEqual(['card', 'card', 'card', 'card', 'card', 'card', 'ring-card:1000', 'loading-card']);
  });

  test('karta: tytuł, odległość, ekstrakt, zdjęcie albo placeholder, linki „Czytaj w Wikipedii” i „Nawiguj”', async ({ page }, testInfo) => {
    await startFeed(page);
    const cards = page.getByTestId('card');
    const first = cards.first();

    await expect(first.getByTestId('card-title')).toHaveText('Kolumna Zygmunta III Wazy w Warszawie');
    await expect(first.getByTestId('card-distance')).toHaveText(DISTANCE_RE);
    await expect(first.getByTestId('card-distance')).toHaveText('90 m stąd');
    await expect(cards.nth(5).getByTestId('card-distance')).toHaveText('680 m stąd');

    const extract = first.getByTestId('card-extract');
    await expect(extract).not.toHaveClass(/is-skeleton/);
    await expect(extract).toContainText('Kolumna Zygmunta III Wazy – kolumna z posągiem');
    await expect(first.locator('.card-photo')).toHaveClass(/is-loaded/);
    await expect(first.locator('.card-photo')).toBeVisible();
    const link = first.getByRole('link', { name: /Czytaj w Wikipedii/ });
    await expect(link).toHaveAttribute('href', 'https://pl.m.wikipedia.org/wiki/Kolumna_Zygmunta_III_Wazy_w_Warszawie');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);

    // „Nawiguj”: trasa piesza w Mapach Google; współrzędne z REST (dokładniejsze) mają pierwszeństwo przed geosearch.
    const nav = first.getByTestId('card-navigate');
    await expect(nav).toHaveText(/Nawiguj/);
    await expect(nav).toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=52.24761,21.01413&travelmode=walking');
    await expect(nav).toHaveAttribute('href', NAVIGATE_RE);
    await expect(nav).toHaveAttribute('target', '_blank');
    await expect(nav).toHaveAttribute('rel', /noopener/);
    await expect(nav).toHaveAttribute('aria-label', 'Nawiguj do: Kolumna Zygmunta III Wazy w Warszawie');
    // Strona bez współrzędnych w REST → współrzędne z geosearch (52.2479, 21.015), kropka dziesiętna, 5 miejsc.
    await expect(cards.nth(1).getByTestId('card-navigate')).toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=52.24790,21.01500&travelmode=walking');
    const [linkBox, navBox] = [await link.boundingBox(), await nav.boundingBox()];
    expect(Math.abs(linkBox.y - navBox.y), 'oba linki w jednym rzędzie').toBeLessThan(2);
    expect(navBox.x).toBeGreaterThan(linkBox.x + linkBox.width);

    await expect(first.getByTestId('btn-known')).toBeVisible();
    await expect(first.getByTestId('btn-unknown')).toBeVisible();
    for (const id of ['btn-known', 'btn-unknown']) {
      const box = await first.getByTestId(id).boundingBox();
      expect(box.height, `${id} ≥ 48 px`).toBeGreaterThanOrEqual(48);
    }

    // Skrócenie ekstraktu: maks. 3 zdania / ~280 znaków z wielokropkiem.
    const long = await cards.nth(1).getByTestId('card-extract').textContent();
    expect(long.length).toBeLessThanOrEqual(281);
    expect(long.endsWith('…')).toBe(true);

    // Strona bez miniatury: placeholder z pierwszą literą, zdjęcie ukryte.
    const third = cards.nth(2);
    await expect(third.getByTestId('card-title')).toHaveText('Plac Zamkowy w Warszawie');
    await expect(third.getByTestId('card-extract')).not.toHaveClass(/is-skeleton/);
    await expect(third.locator('.card-letter')).toHaveText('P');
    await expect(third.locator('.card-photo')).toBeHidden();
    const ph = await third.locator('.card-placeholder').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(ph).not.toBe('rgba(0, 0, 0, 0)');

    // Szczegóły pobierane leniwie: bieżąca karta + 3 następne, nie wszystkie.
    const fetched = await page.evaluate(() => Object.keys(window.WM.state.details).length);
    expect(fetched).toBe(4);

    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: shot(testInfo, '02-card') });
    await third.scrollIntoViewIfNeeded();
    await expect(third).toBeInViewport({ ratio: 0.9 });
    await page.screenshot({ path: shot(testInfo, '02b-placeholder') });
  });

  test('„Wiedziałem” aktualizuje licznik i przewija do następnej karty', async ({ page }) => {
    await startFeed(page);
    const first = page.getByTestId('card').first();
    await first.getByTestId('btn-known').click();
    await expect(first).toHaveAttribute('data-answer', 'true');
    await expect(first.locator('.card-stamp-text')).toHaveText('Wiedziałeś');
    await expect(page.getByTestId('progress')).toHaveText(/znasz 1$/);
    await expect(page.getByTestId('card').nth(1)).toBeInViewport({ ratio: 0.9 });
    await expect(page.getByTestId('progress')).toHaveText('2 z 6 · znasz 1');
    const persisted = await page.evaluate(() => ({
      answers: window.WM.state.answers,
      stored: JSON.parse(localStorage.getItem('wm.answers')),
    }));
    expect(persisted.answers).toEqual({ 35201: true });
    expect(persisted.stored).toEqual({ 35201: true });
    // Druga odpowiedź przez hak testowy, „Nie wiedziałem”.
    const second = page.getByTestId('card').nth(1);
    await page.evaluate(() => window.WM.answer(123, false));
    await expect(second).toHaveAttribute('data-answer', 'false');
    await expect(second.locator('.card-stamp-text')).toHaveText('Nie wiedziałeś');
    await expect(page.getByTestId('card').nth(2)).toBeInViewport({ ratio: 0.9 });
    await expect(page.getByTestId('progress')).toHaveText('3 z 6 · znasz 1');
  });

  test('przesunięcie poziome > 80 px odpowiada na kartę', async ({ page }) => {
    await startFeed(page);
    const first = page.getByTestId('card').first();
    const box = await first.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height * 0.4;

    // Krótkie przesunięcie (40 px) nie odpowiada.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y, { steps: 5 });
    await expect(first).toHaveClass(/is-dragging/);
    await page.mouse.up();
    await expect(first).not.toHaveClass(/is-dragging/);
    await expect(first).not.toHaveAttribute('data-answer', /.+/);

    // Przesunięcie w lewo o 130 px = „Nie wiedziałem”.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 50, y, { steps: 5 });
    await expect(first.locator('.swipe-label-unknown')).toHaveCSS('opacity', /0\.[5-9]|1/);
    await page.mouse.move(x - 130, y, { steps: 8 });
    await page.mouse.up();
    await expect(first).toHaveAttribute('data-answer', 'false');
    await expect(first.locator('.card-stamp-text')).toHaveText('Nie wiedziałeś');
    await expect(page.getByTestId('card').nth(1)).toBeInViewport({ ratio: 0.9 });
    await expect(page.getByTestId('progress')).toHaveText('2 z 6 · znasz 0');

    // Przesunięcie w prawo na drugiej karcie = „Wiedziałem”.
    const second = page.getByTestId('card').nth(1);
    const b2 = await second.boundingBox();
    const x2 = b2.x + b2.width / 2;
    const y2 = b2.y + b2.height * 0.4;
    await page.mouse.move(x2, y2);
    await page.mouse.down();
    await page.mouse.move(x2 + 140, y2, { steps: 10 });
    await page.mouse.up();
    await expect(second).toHaveAttribute('data-answer', 'true');
    await expect(page.getByTestId('progress')).toHaveText('3 z 6 · znasz 1');
  });

  test('dotyk: poziomy swipe palcem odpowiada, pionowy przewija feed', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'gesty dotykowe tylko w projekcie mobilnym');
    await startFeed(page);
    const vp = page.viewportSize();
    const first = page.getByTestId('card').first();
    const box = await first.boundingBox();
    // Palec w prawo o 160 px → „Wiedziałem” (dotyk jest niejawnie przechwytywany przez element pod palcem).
    await touchSwipe(page, { x: box.x + box.width * 0.3, y: box.y + box.height * 0.4 }, 160, 4);
    await expect(first).toHaveAttribute('data-answer', 'true');
    await expect(first.locator('.card-stamp-text')).toHaveText('Wiedziałeś');
    await expect(page.getByTestId('card').nth(1)).toBeInViewport({ ratio: 0.9 });
    await expect(page.getByTestId('progress')).toHaveText('2 z 6 · znasz 1');
    // Pionowy ruch palcem nad kartą to zwykłe przewijanie: brak odpowiedzi, feed idzie dalej.
    await touchSwipe(page, { x: vp.width / 2, y: vp.height * 0.6 }, 0, -420, 14);
    await expect.poll(() => page.evaluate(() => window.WM.state.index)).toBeGreaterThanOrEqual(2);
    expect(await page.locator('.card.is-answered').count()).toBe(1);
    expect(await page.locator('.card.is-dragging').count()).toBe(0);
    // Palec w lewo na bieżącej karcie → „Nie wiedziałeś”.
    const idx = await page.evaluate(() => window.WM.state.index);
    const current = page.getByTestId('card').nth(idx);
    const b2 = await current.boundingBox();
    await touchSwipe(page, { x: b2.x + b2.width * 0.7, y: b2.y + b2.height * 0.4 }, -150, 2);
    await expect(current).toHaveAttribute('data-answer', 'false');
  });

  test('zmiana promienia startowego ponawia geosearch z nowym gsradius (gslimit 500 od 3 km)', async ({ page }) => {
    await startFeed(page);
    const request = page.waitForRequest((r) => /list=geosearch/.test(r.url()) && /gsradius=3000/.test(r.url()));
    await page.getByTestId('radius-chip-3000').click();
    const url = new URL((await request).url());
    expect(url.searchParams.get('gsradius')).toBe('3000');
    expect(url.searchParams.get('gslimit')).toBe('500');
    expect(url.searchParams.get('gscoord')).toBe('52.2497|21.0122');
    await expect(page.getByTestId('radius-chip-3000')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('radius-chip-1000')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('card')).toHaveCount(9);
    await expect(page.getByTestId('progress')).toHaveText('1 z 9 · znasz 0');
    await expect(page.getByTestId('card').nth(6).getByTestId('card-distance')).toHaveText('1,4 km stąd');
    expect(await page.evaluate(() => localStorage.getItem('wm.radius'))).toBe('3000');
    expect(await feedOrder(page)).toEqual([...Array(9).fill('card'), 'ring-card:3000', 'loading-card']);
  });

  test('pierścienie: karta pierścienia po 1 km, dociąganie 3 → 5 → 10 km bez duplikatów, karta końcowa', async ({ page, context }, testInfo) => {
    await context.grantPermissions(['geolocation', 'clipboard-read', 'clipboard-write']);
    const log = await startFeed(page);
    expect(await placeIds(page)).toEqual(IDS_1000);
    await expect(page.getByTestId('progress')).toHaveText('1 z 6 · znasz 0');
    // Pięć odpowiedzi hakiem (jedna „nie wiedziałem”), ostatnia przyciskiem.
    const ringRequest = page.waitForRequest((r) => /list=geosearch/.test(r.url()) && /gsradius=3000/.test(r.url()));
    await answerIds(page, IDS_1000.slice(0, 5).map((id, i) => [id, i !== 1]));
    const last = page.getByTestId('card').nth(5);
    await expect(last).toBeInViewport({ ratio: 0.9 });

    // Dojście na 2 karty przed koniec dociąga 3 km, zanim padnie ostatnia odpowiedź: gsradius=3000 z gslimit=500;
    // nowe karty za kartą pierścienia; duplikaty z 1 km odfiltrowane; (f) licznik rośnie o doklejony pierścień.
    const url = new URL((await ringRequest).url());
    expect(url.searchParams.get('gslimit')).toBe('500');
    expect(url.searchParams.get('gscoord')).toBe('52.2497|21.0122');
    await expect(page.getByTestId('card')).toHaveCount(9);
    expect(await feedOrder(page)).toEqual([...Array(6).fill('card'), 'ring-card:1000', 'card', 'card', 'card', 'ring-card:3000', 'loading-card']);
    const after = await placeIds(page);
    expect(after).toEqual([...IDS_1000, 62340, 17788, 29031]);
    expect(new Set(after).size).toBe(after.length);
    await expect(page.getByTestId('card').nth(6).getByTestId('card-distance')).toHaveText('1,4 km stąd');
    await expect(page.getByTestId('progress')).toHaveText('6 z 9 · znasz 4');
    await last.getByTestId('btn-known').click();

    // (a) Karta pierścienia 1 km: wynik pierścienia, „Udostępnij”, zapowiedź następnego pierścienia, bez przycisku „Dalej”.
    const ring = page.getByTestId('ring-card').first();
    await expect(ring).toBeInViewport({ ratio: 0.9 });
    await expect(ring).toHaveAttribute('data-radius', '1000');
    await expect(ring).toContainText('To wszystko w promieniu 1 km');
    await expect(ring).toContainText('Znasz 83% (5 z 6 miejsc)');
    await expect(ring.locator('.end-percent-num')).toHaveText('83');
    await expect(ring).toContainText('Dalej: miejsca 1–3 km stąd');
    await expect(ring.getByRole('button')).toHaveCount(1);
    await expect(ring.getByTestId('ring-share')).toHaveText(/Udostępnij/);
    // Na karcie pierścienia licznik pokazuje numer ostatniej karty miejsca.
    await expect(page.getByTestId('progress')).toHaveText('6 z 9 · znasz 5');
    await page.screenshot({ path: shot(testInfo, '03-ring') });

    // Udostępnienie wyniku pierścienia (fallback: schowek + toast).
    await ring.getByTestId('ring-share').click();
    await expect(page.locator('#toast')).toHaveText('Skopiowano');
    const pageUrl = page.url().split('#')[0];
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`Znam 83% miejsc w promieniu 1 km od siebie. Sprawdź swoją okolicę: ${pageUrl}`);

    // 3 km: 2 z 3 → 67 %; 5 km: 2 nowe; 10 km: 3 nowe (Cytadela 2,2 km w kolejności z API, lotnisko, Wilanów).
    await answerIds(page, [[62340, true], [17788, false], [29031, true]]);
    const ring3 = page.getByTestId('ring-card').nth(1);
    await expect(ring3).toContainText('Znasz 67% (2 z 3 miejsc)');
    await expect(ring3).toContainText('Dalej: miejsca 3–5 km stąd');
    await expect(page.getByTestId('card')).toHaveCount(11);
    expect((await placeIds(page)).slice(9)).toEqual([55870, 40120]);
    await answerIds(page, [[55870, true], [40120, false]]);
    await expect(page.getByTestId('ring-card').nth(2)).toContainText('Znasz 50% (1 z 2 miejsc)');
    await expect(page.getByTestId('card')).toHaveCount(14);
    expect((await placeIds(page)).slice(11)).toEqual([73111, 71230, 68001]);
    await expect(page.getByTestId('card').nth(11).getByTestId('card-distance')).toHaveText('2,2 km stąd');
    await expect(page.getByTestId('card').nth(13).getByTestId('card-distance')).toHaveText('9,1 km stąd');
    await answerIds(page, [[73111, true], [71230, true], [68001, false]]);

    // (c) Karta końcowa po pierścieniu 10 km: wynik łączny, trzy przyciski, bez „Zwiększ promień”.
    const end = page.getByTestId('end-card');
    await expect(end).toBeInViewport({ ratio: 0.9 });
    await expect(page.getByTestId('ring-card')).toHaveCount(3);
    await expect(page.getByTestId('loading-card')).toHaveCount(0);
    await expect(end).toContainText('To wszystko, co Wikipedia zna w promieniu 10 km');
    await expect(end).toContainText('Znasz 71% (10 z 14 miejsc)');
    await expect(end.locator('.end-percent-num')).toHaveText('71');
    await expect(page.getByTestId('progress')).toHaveText('14 z 14 · znasz 10');
    await expect(end.getByRole('button', { name: 'Udostępnij' })).toBeVisible();
    await expect(end.getByRole('button', { name: 'Zmień miejsce' })).toBeVisible();
    await expect(end.getByRole('button', { name: 'Jeszcze raz' })).toBeVisible();
    await expect(end.getByRole('button', { name: 'Zwiększ promień' })).toHaveCount(0);
    expect(geoRadii(log)).toEqual(['1000', '3000', '5000', '10000']);
    await page.screenshot({ path: shot(testInfo, '03b-end') });

    await page.getByTestId('share-button').click();
    await expect(page.locator('#toast')).toHaveText('Skopiowano');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`Znam 71% miejsc w promieniu 10 km od siebie. Sprawdź swoją okolicę: ${pageUrl}`);

    // „Jeszcze raz” czyści odpowiedzi wszystkich załadowanych pierścieni i wraca na pierwszą kartę.
    await end.getByRole('button', { name: 'Jeszcze raz' }).click();
    await expect(page.getByTestId('card').first()).toBeInViewport({ ratio: 0.9 });
    await expect(page.getByTestId('progress')).toHaveText('1 z 14 · znasz 0');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wm.answers')))).toEqual({});
    await expect(page.getByTestId('card').first()).not.toHaveAttribute('data-answer', /.+/);
    expect(await page.locator('.card.is-answered').count()).toBe(0);
    await expect(ring).toContainText('Przewinąłeś 6 miejsc w promieniu 1 km');
  });

  test('przewinięcie na koniec bez odpowiedzi dociąga następny pierścień; karta pierścienia mówi „Przewinąłeś…”', async ({ page }, testInfo) => {
    const log = await startFeed(page, { slowRadius: 3000, slowMs: 1500 });
    expect(geoRadii(log)).toEqual(['1000']);
    // (b) Ostatnia karta w widoku → zapytanie o 3 km; w tym czasie na końcu feedu karta ładowania.
    await page.evaluate(() => document.querySelectorAll('[data-testid="card"]')[5].scrollIntoView());
    await expect.poll(() => geoRadii(log)).toEqual(['1000', '3000']);
    const loading = page.getByTestId('loading-card');
    await expect(loading).toContainText('Szukam miejsc 1–3 km stąd…');
    await expect(page.getByTestId('feed')).toHaveAttribute('aria-busy', 'true');
    const ring = page.getByTestId('ring-card').first();
    await expect(ring).toContainText('Przewinąłeś 6 miejsc w promieniu 1 km');
    await expect(ring.locator('.end-meter')).toBeHidden();
    await expect(ring.getByTestId('ring-share')).toBeHidden();
    await expect(ring).toContainText('Dalej: miejsca 1–3 km stąd');
    await page.evaluate(() => document.querySelector('[data-testid="ring-card"]').scrollIntoView());
    await expect(ring).toBeInViewport({ ratio: 0.9 });
    await page.screenshot({ path: shot(testInfo, '03c-ring-scrolled') });
    await expect(page.getByTestId('card')).toHaveCount(9);
    await expect(page.getByTestId('feed')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByTestId('progress')).toHaveText('6 z 9 · znasz 0');
    expect(await feedOrder(page)).toEqual([...Array(6).fill('card'), 'ring-card:1000', 'card', 'card', 'card', 'ring-card:3000', 'loading-card']);
    // Pierwsza doklejona karta jest zaraz za kartą pierścienia; odpowiedź na niej aktualizuje kartę pierścienia 3 km.
    await page.evaluate(() => window.WM.answer(62340, true));
    await expect(page.getByTestId('ring-card').nth(1)).toContainText('Znasz 33% (1 z 3 miejsc)');
    // Po odpowiedzi widok idzie na 8. kartę — 2 karty przed końcem, więc w tle dociąga się już 5 km (suma 9 → 11).
    await expect(page.getByTestId('progress')).toHaveText(/^8 z (9|11) · znasz 1$/);
    await expect(page.getByTestId('card')).toHaveCount(11);
  });

  test('błąd przy dociąganiu pierścienia → karta błędu w feedzie, „Spróbuj ponownie” tylko dla tego pierścienia', async ({ page, consoleErrors }, testInfo) => {
    consoleErrors.allow.push(/Failed to load resource.*list=geosearch/);
    const log = await startFeed(page, { failRadius: 3000 });
    await page.evaluate(() => document.querySelectorAll('[data-testid="card"]')[5].scrollIntoView());
    const error = page.getByTestId('ring-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('Wikipedia odpowiedziała błędem (500). Odczekaj chwilę i spróbuj ponownie.');
    await expect(page.getByTestId('error-state')).toBeHidden();
    await expect(page.getByTestId('card')).toHaveCount(6);
    await page.evaluate(() => document.querySelector('[data-testid="loading-card"]').scrollIntoView());
    await page.screenshot({ path: shot(testInfo, '05b-ring-error') });
    await page.getByTestId('ring-retry').click();
    await expect(page.getByTestId('card')).toHaveCount(9);
    await expect(error).toBeHidden();
    expect(geoRadii(log)).toEqual(['1000', '3000', '3000']);
  });

  test('odpowiedzi z poprzedniej sesji: po ponownym starcie feed zaczyna od karty pierścienia i dociąga następny', async ({ page }) => {
    await startFeed(page);
    await page.evaluate(() => { for (const p of window.WM.state.places) window.WM.answer(p.pageid, p.pageid !== 123); });
    await expect(page.getByTestId('ring-card').first()).toBeInViewport({ ratio: 0.9 });
    await expect(page.getByTestId('card')).toHaveCount(9);
    await page.reload();
    await page.getByTestId('start-button').click();
    const ring = page.getByTestId('ring-card').first();
    await expect(ring).toBeInViewport({ ratio: 0.9 });
    await expect(ring).toContainText('Znasz 83% (5 z 6 miejsc)');
    await expect(page.getByTestId('card').first()).toHaveAttribute('data-answer', 'true');
    await expect(page.getByTestId('card').nth(1)).toHaveAttribute('data-answer', 'false');
    await expect(page.getByTestId('card')).toHaveCount(9);
    await expect(page.getByTestId('card').nth(6)).not.toHaveAttribute('data-answer', /.+/);
    await expect(page.getByTestId('progress')).toHaveText('6 z 9 · znasz 5');
  });

  test('pusty pierścień startowy 500 m → karta „nic nie ma”, dalej automatycznie 1 km, bez stanu pustego', async ({ page }, testInfo) => {
    const log = await mockWikipedia(page);
    await page.goto('./');
    await page.getByTestId('radius-chip-500').click();
    await expect(page.getByTestId('radius-chip-500')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('start-button').click();
    // (d) Karta pierścienia zamiast stanu pustego; 1 km dociąga się od razu.
    const ring = page.getByTestId('ring-card').first();
    await expect(ring).toBeInViewport({ ratio: 0.9 });
    await expect(ring).toHaveAttribute('data-radius', '500');
    await expect(ring).toContainText('W promieniu 500 m nic nie ma');
    await expect(ring).toContainText('Dalej: miejsca 500 m–1 km stąd');
    await expect(ring.locator('.end-meter')).toBeHidden();
    await expect(page.getByTestId('empty-state')).toBeHidden();
    await expect(page.getByTestId('card')).toHaveCount(6);
    await expect(page.getByTestId('progress')).toHaveText('1 z 6 · znasz 0');
    expect(await feedOrder(page)).toEqual(['ring-card:500', ...Array(6).fill('card'), 'ring-card:1000', 'loading-card']);
    expect(geoRadii(log)).toEqual(['500', '1000']);
    expect(await page.evaluate(() => [window.WM.state.radius, localStorage.getItem('wm.radius')])).toEqual([500, '500']);
    await page.screenshot({ path: shot(testInfo, '04-empty-ring') });
    await page.getByTestId('card').first().scrollIntoViewIfNeeded();
    await expect(page.getByTestId('card').first()).toBeInViewport({ ratio: 0.9 });
    await expect(page.getByTestId('card').first().getByTestId('card-distance')).toHaveText('90 m stąd');
  });

  test('promień 500 m w feedzie → karta „nic nie ma” i karty z 1 km; chip 3 km → 9 kart', async ({ page }) => {
    await startFeed(page);
    await page.getByTestId('radius-chip-500').click();
    const ring = page.getByTestId('ring-card').first();
    await expect(ring).toContainText('W promieniu 500 m nic nie ma');
    await expect(page.getByTestId('empty-state')).toBeHidden();
    await expect(page.getByTestId('card')).toHaveCount(6);
    await page.getByTestId('radius-chip-3000').click();
    await expect(page.getByTestId('card')).toHaveCount(9);
    await expect(page.getByTestId('ring-card')).toHaveCount(1);
    await expect(page.getByTestId('ring-card').first()).toHaveAttribute('data-radius', '3000');
    await expect(page.getByTestId('progress')).toHaveText('1 z 9 · znasz 0');
    expect(await page.evaluate(() => localStorage.getItem('wm.radius'))).toBe('3000');
  });

  test('0 wyników we wszystkich pierścieniach → stan pusty dopiero po 10 km', async ({ page }, testInfo) => {
    const log = await mockWikipedia(page, { empty: true });
    await page.goto('./');
    await page.getByTestId('start-button').click();
    // (e) Dopóki są dalsze pierścienie, nie ma stanu pustego; po 10 km — komunikat ze „Zmień miejsce”.
    const empty = page.getByTestId('empty-state');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('Wikipedia nie zna żadnego miejsca w promieniu 10 km od tego punktu. Zmień miejsce.');
    await expect(empty.getByTestId('radius-chip-3000')).toBeVisible();
    await expect(page.getByTestId('feed')).toBeHidden();
    await expect(page.getByTestId('error-state')).toBeHidden();
    expect(geoRadii(log)).toEqual(['1000', '3000', '5000', '10000']);
    await page.screenshot({ path: shot(testInfo, '04-empty') });
    await page.getByTestId('change-place').click();
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await expect(empty).toBeHidden();
  });

  test('błąd API 500 → stan błędu i działające „Spróbuj ponownie”', async ({ page, consoleErrors }, testInfo) => {
    consoleErrors.allow.push(/Failed to load resource.*list=geosearch/);
    await mockWikipedia(page, { geosearchFailures: 1 });
    await page.goto('./');
    await page.getByTestId('start-button').click();
    const error = page.getByTestId('error-state');
    await expect(error).toBeVisible();
    await expect(error).toContainText('Wikipedia odpowiedziała błędem (500). Odczekaj chwilę i spróbuj ponownie.');
    await expect(page.getByTestId('feed')).toBeHidden();
    await page.screenshot({ path: shot(testInfo, '05-error') });
    await page.getByTestId('retry-button').click();
    await expect(page.getByTestId('feed')).toBeVisible();
    await expect(page.getByTestId('card').first()).toBeVisible();
    await expect(error).toBeHidden();
    await expect(page.getByTestId('progress')).toHaveText('1 z 6 · znasz 0');
  });

  test('„Zmień miejsce” wraca na ekran startowy', async ({ page }) => {
    await startFeed(page);
    await page.getByTestId('change-place').click();
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await expect(page.getByTestId('feed')).toBeHidden();
    await expect(page.getByTestId('radius-chip-1000')).toBeVisible();
    await expect(page.getByTestId('card')).toHaveCount(0);
  });

  test('brak poziomego przewijania strony na starcie i w feedzie', async ({ page }) => {
    await mockWikipedia(page);
    await page.goto('./');
    await expectNoHorizontalScroll(page);
    await page.getByTestId('start-button').click();
    await expect(page.getByTestId('card').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    const app = await page.locator('#app').boundingBox();
    expect(app.width).toBeLessThanOrEqual(520);
    const vw = page.viewportSize().width;
    if (vw >= 720) expect(Math.abs(app.x + app.width / 2 - vw / 2)).toBeLessThan(2); // kolumna wyśrodkowana na desktopie
  });
});

test.describe('bez zgody na lokalizację', () => {
  test.use({ permissions: [] });

  test('odmowa geolokalizacji → wpisanie miejsca działa od początku do końca', async ({ page }, testInfo) => {
    const log = await mockWikipedia(page);
    await page.goto('./');
    await page.getByTestId('start-button').click();

    const input = page.getByTestId('place-input');
    await expect(input).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#geo-message')).toBeVisible();
    await expect(page.locator('#geo-message')).toContainText('Wpisz miejsce poniżej');
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await expect(page.getByTestId('feed')).toBeHidden();
    await page.screenshot({ path: shot(testInfo, '06-denied') });

    // Puste pole → komunikat, bez żądań.
    await page.getByTestId('place-submit').click();
    await expect(page.locator('#place-message')).toContainText('Wpisz nazwę miejsca');

    // Zapytanie bez stron ze współrzędnymi → komunikat.
    await input.fill('Pojęcie abstrakcyjne');
    await page.getByTestId('place-submit').click();
    await expect(page.locator('#place-message')).toContainText('Nie znaleziono miejsca „Pojęcie abstrakcyjne”');

    // Właściwe miejsce: pierwsza strona ze współrzędnymi staje się środkiem.
    await input.fill('Rynek Główny Kraków');
    const geo = page.waitForRequest((r) => /list=geosearch/.test(r.url()));
    await page.getByTestId('place-submit').click();
    const url = new URL((await geo).url());
    expect(url.searchParams.get('gscoord')).toBe('50.0617|19.9373');
    expect(url.searchParams.get('gsradius')).toBe('1000');
    const search = log.requests.map((u) => new URL(u)).findLast((u) => u.searchParams.get('generator') === 'search');
    expect(search.searchParams.get('gsrsearch')).toBe('Rynek Główny Kraków');
    expect(search.searchParams.get('gsrlimit')).toBe('5');
    expect(search.searchParams.get('prop')).toBe('coordinates');

    await expect(page.getByTestId('feed')).toBeVisible();
    const first = page.getByTestId('card').first();
    await expect(first).toBeVisible();
    await expect(first.getByTestId('card-title')).toHaveText('Sukiennice w Krakowie');
    await expect(first.getByTestId('card-distance')).toHaveText(DISTANCE_RE);
    await expect(first.getByTestId('card-navigate')).toHaveAttribute('href', NAVIGATE_RE);
    await expect(page.getByTestId('card')).toHaveCount(4);
    await page.screenshot({ path: shot(testInfo, '07-place-feed') });
  });
});
