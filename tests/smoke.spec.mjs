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

const json = (body, status = 200) => ({
  status,
  contentType: 'application/json; charset=utf-8',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
});

/* Mock Wikipedii. Opcje: geosearchFailures (ile pierwszych geosearch ma zwrócić 500), empty (zawsze 0 wyników). */
async function mockWikipedia(page, options = {}) {
  const opts = { geosearchFailures: 0, empty: false, ...options };
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

  await page.route('https://pl.wikipedia.org/**', (route) => {
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
        if (opts.geosearchFailures > 0) {
          opts.geosearchFailures -= 1;
          return route.fulfill({ status: 500, contentType: 'text/html', headers: { 'access-control-allow-origin': '*' }, body: 'Internal Server Error' });
        }
        if (opts.empty) return route.fulfill(json(FIX.gEmpty));
        const radius = Number(p.get('gsradius'));
        if ((p.get('gscoord') || '').startsWith('50.06')) return route.fulfill(json(FIX.gKrakow));
        if (radius <= 500) return route.fulfill(json(FIX.gEmpty));
        return route.fulfill(json(radius >= 3000 ? FIX.g3000 : FIX.g1000));
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
   (REST 404 dla jednej strony → ścieżka zapasowa; 500 w teście błędu API). */
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

  test('ekran startowy: 4 chipsy promienia, domyślnie 1 km', async ({ page }, testInfo) => {
    await mockWikipedia(page);
    await page.goto('./');
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Wokół mnie' })).toBeVisible();
    await expect(page.getByText('Co ciekawego jest kilkaset metrów od ciebie?')).toBeVisible();
    for (const r of [500, 1000, 3000, 5000]) {
      await expect(page.getByTestId(`radius-chip-${r}`)).toBeVisible();
    }
    await expect(page.getByTestId('radius-chip-1000')).toHaveAttribute('aria-checked', 'true');
    for (const r of [500, 3000, 5000]) {
      await expect(page.getByTestId(`radius-chip-${r}`)).toHaveAttribute('aria-checked', 'false');
    }
    await expect(page.getByTestId('radius-chip-1000')).toHaveText('1 km');
    await expect(page.getByTestId('start-button')).toBeVisible();
    await expect(page.getByTestId('start-button')).toHaveText(/Pokaż, co jest wokół/);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: shot(testInfo, '01-start') });
  });

  test('ścieżka GPS: ładuje co najmniej jedną kartę w ciągu 10 s', async ({ page, context }) => {
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
  });

  test('karta: tytuł, odległość, ekstrakt, zdjęcie albo placeholder', async ({ page }, testInfo) => {
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

  test('zmiana promienia ponawia geosearch z nowym gsradius', async ({ page }) => {
    await startFeed(page);
    const request = page.waitForRequest((r) => /list=geosearch/.test(r.url()) && /gsradius=3000/.test(r.url()));
    await page.getByTestId('radius-chip-3000').click();
    const url = new URL((await request).url());
    expect(url.searchParams.get('gsradius')).toBe('3000');
    expect(url.searchParams.get('gscoord')).toBe('52.2497|21.0122');
    await expect(page.getByTestId('radius-chip-3000')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('radius-chip-1000')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('card')).toHaveCount(9);
    await expect(page.getByTestId('progress')).toHaveText('1 z 9 · znasz 0');
    await expect(page.getByTestId('card').nth(6).getByTestId('card-distance')).toHaveText('1,4 km stąd');
    expect(await page.evaluate(() => localStorage.getItem('wm.radius'))).toBe('3000');
  });

  test('wszystkie karty → karta końcowa, procent i kopiowanie do schowka', async ({ page, context }, testInfo) => {
    await context.grantPermissions(['geolocation', 'clipboard-read', 'clipboard-write']);
    await startFeed(page);
    const ids = await page.evaluate(() => window.WM.state.places.map((p) => p.pageid));
    expect(ids).toHaveLength(6);
    // Pięć odpowiedzi hakiem (jedna „nie wiedziałem”), ostatnia przyciskiem.
    for (const [i, id] of ids.slice(0, 5).entries()) {
      await page.evaluate(([pageid, known]) => window.WM.answer(pageid, known), [id, i !== 1]);
    }
    const last = page.getByTestId('card').last();
    await expect(last).toBeInViewport({ ratio: 0.9 });
    await expect(page.getByTestId('progress')).toHaveText('6 z 6 · znasz 4');
    await last.getByTestId('btn-known').click();

    const end = page.getByTestId('end-card');
    await expect(end).toBeInViewport({ ratio: 0.9 });
    await expect(end).toContainText('Znasz 83% okolicy w promieniu 1 km');
    await expect(end).toContainText('Wiedziałeś o 5 z 6 miejsc');
    await expect(end.locator('.end-percent-num')).toHaveText('83');
    await expect(page.getByTestId('progress')).toHaveText('6 z 6 · znasz 5');
    await expect(end.getByRole('button', { name: 'Zwiększ promień' })).toBeVisible();
    await expect(end.getByRole('button', { name: 'Jeszcze raz' })).toBeVisible();
    await page.screenshot({ path: shot(testInfo, '03-end') });

    await page.getByTestId('share-button').click();
    await expect(page.locator('#toast')).toHaveText('Skopiowano');
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    const url = page.url().split('#')[0];
    expect(clipboard).toBe(`Znam 83% miejsc w promieniu 1 km od siebie. Sprawdź swoją okolicę: ${url}`);

    // „Jeszcze raz” czyści odpowiedzi dla tej listy i wraca na początek.
    await end.getByRole('button', { name: 'Jeszcze raz' }).click();
    await expect(page.getByTestId('card').first()).toBeInViewport({ ratio: 0.9 });
    await expect(page.getByTestId('progress')).toHaveText('1 z 6 · znasz 0');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wm.answers')))).toEqual({});
    await expect(page.getByTestId('card').first()).not.toHaveAttribute('data-answer', /.+/);
  });

  test('0 wyników → stan pusty, zmiana promienia wraca do kart', async ({ page }, testInfo) => {
    await mockWikipedia(page, { empty: true });
    await page.goto('./');
    await page.getByTestId('start-button').click();
    const empty = page.getByTestId('empty-state');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('W promieniu 1 km Wikipedia nie zna żadnego miejsca. Zwiększ promień.');
    await expect(empty.getByTestId('radius-chip-3000')).toBeVisible();
    await expect(page.getByTestId('feed')).toBeHidden();
    await expect(page.getByTestId('error-state')).toBeHidden();
    await page.screenshot({ path: shot(testInfo, '04-empty') });
  });

  test('promień 500 m bez wyników → stan pusty → 3 km → karty', async ({ page }) => {
    await startFeed(page);
    await page.getByTestId('radius-chip-500').click();
    const empty = page.getByTestId('empty-state');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('W promieniu 500 m Wikipedia nie zna żadnego miejsca.');
    await empty.getByTestId('radius-chip-3000').click();
    await expect(page.getByTestId('feed')).toBeVisible();
    await expect(page.getByTestId('card')).toHaveCount(9);
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
    await expect(page.getByTestId('card')).toHaveCount(4);
    await page.screenshot({ path: shot(testInfo, '07-place-feed') });
  });
});
