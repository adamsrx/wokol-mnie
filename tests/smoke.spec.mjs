// Testy dymne „Wokół mnie” (v0.2). Wszystkie żądania do pl.wikipedia.org, upload.wikimedia.org i Google Fonts
// są mockowane przez page.route — kontener budowy nie ma dostępu do Wikipedii.
// Uruchomienie: `npm test` (projekty: mobile 390×844 i desktop 1280×800, zrzuty w tests/artifacts/).
// Kolejność kart jest losowa; testy, którym zależy na kolejności, unieruchamiają losowanie przez window.WM.rng
// (0.9999 → kolejność z API), a jeden test sprawdza prawdziwą losowość.
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
const DISTANCE_RE = /^(\d+ m|\d+,\d km|\d+ km) stąd$/;
const NAVIGATE_RE = /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=-?\d{1,2}\.\d{5},-?\d{1,3}\.\d{5}&travelmode=walking$/;
const IDS_1000 = [35201, 123, 76112, 48803, 90455, 51277];
const IDS_3000_NEW = [62340, 17788, 29031];
const IDS_5000_NEW = [55870, 40120];
const IDS_10000_NEW = [73111, 71230, 68001];
const IDS_10000 = FIX.g10000.query.geosearch.map((p) => p.pageid);

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

/* Unieruchamia losowanie: 0.9999 w tasowaniu Fishera–Yatesa zostawia kolejność z API. */
const deterministic = (page) => page.evaluate(() => { window.WM.rng.next = () => 0.9999; });

/* Promienie wszystkich dotychczasowych zapytań geosearch, w kolejności. */
const geoRadii = (log) => log.requests.map((u) => new URL(u)).filter((u) => u.searchParams.get('list') === 'geosearch').map((u) => u.searchParams.get('gsradius'));

/* Kolejność elementów feedu: 'card' | 'ring-card:1000' | 'loading-card' | 'end-card'. */
const feedOrder = (page) => page.evaluate(() => [...document.querySelectorAll('#feed > *')]
  .map((el) => el.dataset.testid + (el.dataset.radius ? `:${el.dataset.radius}` : '')));

const placeIds = (page) => page.evaluate(() => window.WM.state.places.map((p) => p.pageid));
const stored = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key);
const cardFor = (page, pageid) => page.locator(`[data-testid="card"][data-pageid="${pageid}"]`);

/* Przewija feed na sam dół tak długo, aż załadują się wszystkie pierścienie i stanie karta końcowa. */
async function scrollToEnd(page) {
  await expect.poll(async () => {
    await page.evaluate(() => { const f = document.getElementById('feed'); f.scrollTo({ top: f.scrollHeight, behavior: 'auto' }); });
    return page.evaluate(() => window.WM.state.feedDone && Boolean(document.querySelector('[data-testid="end-card"]')));
  }, { timeout: 20_000, intervals: [200, 300, 500] }).toBe(true);
}

async function expectNoHorizontalScroll(page) {
  const m = await page.evaluate(() => ({
    docScroll: document.documentElement.scrollWidth,
    docClient: document.documentElement.clientWidth,
    bodyScroll: document.body.scrollWidth,
    feed: (() => { const f = document.getElementById('feed'); return f && !f.hidden ? [f.scrollWidth, f.clientWidth] : null; })(),
    panel: (() => { const p = document.getElementById('my-places-panel'); return p && !p.hidden ? [p.scrollWidth, p.clientWidth] : null; })(),
  }));
  expect(m.docScroll, 'scrollWidth dokumentu').toBeLessThanOrEqual(m.docClient);
  expect(m.bodyScroll, 'scrollWidth body').toBeLessThanOrEqual(m.docClient);
  if (m.feed) expect(m.feed[0], 'scrollWidth feedu').toBeLessThanOrEqual(m.feed[1]);
  if (m.panel) expect(m.panel[0], 'scrollWidth panelu').toBeLessThanOrEqual(m.panel[1]);
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

/* Czeka, aż feed przestanie się przewijać (dwa odczyty scrollTop w odstępie 250 ms bez zmiany). */
async function settle(page) {
  await expect.poll(async () => {
    const a = await page.evaluate(() => document.getElementById('feed').scrollTop);
    await sleep(250);
    const b = await page.evaluate(() => document.getElementById('feed').scrollTop);
    return a === b;
  }, { timeout: 5000 }).toBe(true);
}

/* Przesunięcie myszą po karcie (poziome). */
async function mouseSwipe(page, card, dx) {
  const box = await card.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height * 0.4;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 5 });
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
}

/* Ścieżka GPS: start → feed z kartami, z unieruchomionym losowaniem (chyba że options.random). Zwraca dziennik mocka. */
async function startFeed(page, options = {}) {
  const { random = false, ...mockOptions } = options;
  const log = await mockWikipedia(page, mockOptions);
  await page.goto('./');
  if (!random) await deterministic(page);
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

  test('ścieżka GPS: ładuje co najmniej jedną kartę w ciągu 10 s; bez licznika; tylko pierścień startowy', async ({ page, context }) => {
    const log = await mockWikipedia(page);
    await context.setGeolocation(WARSAW);
    await page.goto('./');
    const started = Date.now();
    await page.getByTestId('start-button').click();
    await expect(page.getByTestId('card').first()).toBeVisible({ timeout: 10_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect(page.getByTestId('start-screen')).toBeHidden();
    await expect(page.getByTestId('card')).toHaveCount(6);

    // Pasek: „Moje miejsca” (bez liczby przy 0 zapisanych) i „Zmień miejsce”; żadnego licznika „x z y”.
    await expect(page.getByTestId('progress')).toHaveCount(0);
    await expect(page.getByTestId('my-places')).toBeVisible();
    await expect(page.getByTestId('my-places-count')).toBeHidden();
    await expect(page.getByTestId('change-place')).toBeVisible();
    expect(await page.locator('#topbar').innerText()).not.toMatch(/\d+ z \d+/);

    const geo = log.requests.map((u) => new URL(u)).find((u) => u.searchParams.get('list') === 'geosearch');
    expect(geo).toBeTruthy();
    expect(geo.searchParams.get('gscoord')).toBe('52.2497|21.0122');
    expect(geo.searchParams.get('gsradius')).toBe('1000');
    expect(geo.searchParams.get('gslimit')).toBe('100');
    expect(geo.searchParams.get('gsnamespace')).toBe('0');
    const state = await page.evaluate(() => ({ screen: window.WM.state.screen, n: window.WM.state.places.length, radius: window.WM.state.radius }));
    expect(state).toEqual({ screen: 'feed', n: 6, radius: 1000 });
    expect([...await placeIds(page)].sort()).toEqual([...IDS_1000].sort());
    // Na pierwszej karcie następny pierścień jeszcze nie jest pobierany; na końcu feedu stoi karta ładowania.
    expect(geoRadii(log)).toEqual(['1000']);
    expect(await feedOrder(page)).toEqual(['card', 'card', 'card', 'card', 'card', 'card', 'ring-card:1000', 'loading-card']);
  });

  test('kolejność kart w pierścieniu jest losowa przy każdym załadowaniu', async ({ page }) => {
    await mockWikipedia(page);
    await page.goto('./');
    const orders = [];
    for (let i = 0; i < 5; i++) {
      orders.push(await page.evaluate(async () => {
        window.WM.clearSeen();
        const list = await window.WM.loadAround(52.2497, 21.0122, 10000);
        return list.map((p) => p.pageid);
      }));
    }
    for (const ids of orders) expect([...ids].sort()).toEqual([...IDS_10000].sort());   // ten sam zbiór, bez duplikatów
    const distinctOrders = new Set(orders.map((ids) => ids.join(',')));
    expect(distinctOrders.size, 'pięć załadowań, co najmniej dwie różne kolejności').toBeGreaterThan(1);
    expect(new Set(orders.map((ids) => ids[0])).size, 'pierwsza karta nie zawsze ta sama').toBeGreaterThan(1);
    // DOM odzwierciedla ostatnie losowanie.
    const domIds = await page.evaluate(() => [...document.querySelectorAll('[data-testid="card"]')].map((c) => Number(c.dataset.pageid)));
    expect(domIds).toEqual(orders[4]);
  });

  test('obejrzane miejsca (≥ 1,5 s na karcie) lądują na końcu pierścienia; wm.seen ma limit 2000', async ({ page }) => {
    await startFeed(page);
    expect(await placeIds(page)).toEqual(IDS_1000);
    // Pierwsza karta jest aktywna → po 1,5 s staje się obejrzana.
    await expect.poll(() => stored(page, 'wm.seen'), { timeout: 5000 }).toEqual([35201]);
    // Karta minięta w 300 ms nie liczy się; ta, na której się zatrzymujemy — tak.
    await page.evaluate(() => document.querySelectorAll('[data-testid="card"]')[1].scrollIntoView());
    await sleep(300);
    await page.evaluate(() => document.querySelectorAll('[data-testid="card"]')[2].scrollIntoView());
    await expect.poll(() => stored(page, 'wm.seen'), { timeout: 5000 }).toEqual([35201, 76112]);
    await sleep(400);
    expect(await stored(page, 'wm.seen')).toEqual([35201, 76112]);
    expect(await page.evaluate(() => window.WM.markSeen(48803))).toBe(true);

    // Ponowne załadowanie tego samego pierścienia: najpierw nieobejrzane (w kolejności z API), potem obejrzane.
    const ids = await page.evaluate(() => window.WM.loadAround(52.2497, 21.0122, 1000).then((l) => l.map((p) => p.pageid)));
    expect(ids).toEqual([123, 90455, 51277, 35201, 76112, 48803]);
    const domIds = await page.evaluate(() => [...document.querySelectorAll('[data-testid="card"]')].map((c) => Number(c.dataset.pageid)));
    expect(domIds).toEqual(ids);
    await expect(page.getByTestId('card').first().getByTestId('card-title')).toHaveText('Zamek Królewski w Warszawie');

    // Limit 2000 wpisów: najstarsze wypadają.
    const cap = await page.evaluate(() => {
      for (let i = 1; i <= 2005; i++) window.WM.markSeen(100000 + i);
      const s = JSON.parse(localStorage.getItem('wm.seen'));
      return { len: s.length, first: s[0], last: s[s.length - 1], hasOld: s.includes(35201) };
    });
    expect(cap).toEqual({ len: 2000, first: 100006, last: 102005, hasOld: false });
  });

  test('karta: tytuł, odległość, ekstrakt, zdjęcie albo placeholder, linki „Czytaj w Wikipedii” i „Nawiguj”, przyciski „Zapisz” i „Lubię”', async ({ page }, testInfo) => {
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

    // Przyciski-przełączniki zamiast quizu: „Zapisz” po lewej, „Lubię” po prawej, bez żadnej liczby polubień.
    const save = first.getByTestId('btn-save');
    const like = first.getByTestId('btn-like');
    await expect(save).toHaveText(/Zapisz/);
    await expect(like).toHaveText(/Lubię/);
    await expect(save).toHaveAttribute('aria-pressed', 'false');
    await expect(like).toHaveAttribute('aria-pressed', 'false');
    await expect(first.getByTestId('like-count')).toBeHidden();
    await expect(first.getByTestId('btn-known')).toHaveCount(0);
    for (const b of [save, like]) {
      const box = await b.boundingBox();
      expect(box.height, 'przycisk ≥ 48 px').toBeGreaterThanOrEqual(48);
    }
    const [saveBox, likeBox] = [await save.boundingBox(), await like.boundingBox()];
    expect(saveBox.x).toBeLessThan(likeBox.x);
    expect(first.getByText(/Wiedziałem|Nie wiedziałem/)).toHaveCount(0);

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

  test('„Lubię” przełącza polubienie bez przewijania; zapis w wm.likes jako pageid → czas', async ({ page }) => {
    await startFeed(page);
    const first = page.getByTestId('card').first();
    const like = first.getByTestId('btn-like');
    const before = Date.now();
    await like.click();
    await expect(like).toHaveAttribute('aria-pressed', 'true');
    await expect(like).toHaveText(/Lubisz/);
    await expect(first).toHaveClass(/is-liked/);
    const likesStored = await stored(page, 'wm.likes');
    expect(Object.keys(likesStored)).toEqual(['35201']);
    expect(likesStored[35201]).toBeGreaterThanOrEqual(before - 1000);
    // Brak automatycznego przewijania: użytkownik dalej ogląda tę kartę.
    await sleep(600);
    expect(await page.evaluate(() => ({ top: document.getElementById('feed').scrollTop, index: window.WM.state.index }))).toEqual({ top: 0, index: 0 });
    await expect(first).toBeInViewport({ ratio: 0.9 });
    // Drugie kliknięcie cofa polubienie.
    await like.click();
    await expect(like).toHaveAttribute('aria-pressed', 'false');
    await expect(like).toHaveText(/Lubię/);
    expect(await stored(page, 'wm.likes')).toEqual({});
    // Hak testowy działa też dla karty poza widokiem.
    expect(await page.evaluate(() => window.WM.like(123))).toBe(true);
    await expect(cardFor(page, 123).getByTestId('btn-like')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.WM.likes.isLiked(123))).toBe(true);
    expect(await page.evaluate(() => window.WM.likes.counts([123, 35201]).then((m) => m.size))).toBe(0);
  });

  test('podwójne stuknięcie w zdjęcie polubia (tylko raz) i pokazuje serce', async ({ page }) => {
    await startFeed(page);
    const first = page.getByTestId('card').first();
    const box = await first.boundingBox();
    const pos = { x: box.width / 2, y: box.height * 0.3 };
    await first.dblclick({ position: pos });
    await expect(first.getByTestId('btn-like')).toHaveAttribute('aria-pressed', 'true');
    await expect(first).toHaveClass(/is-burst/);
    await expect(first).not.toHaveClass(/is-burst/, { timeout: 3000 });
    // Kolejne podwójne stuknięcie nie cofa polubienia; pojedyncze stuknięcie nic nie zmienia.
    await first.dblclick({ position: pos });
    await expect(first.getByTestId('btn-like')).toHaveAttribute('aria-pressed', 'true');
    await sleep(400);
    await first.click({ position: pos });
    await sleep(400);
    await expect(first.getByTestId('btn-like')).toHaveAttribute('aria-pressed', 'true');
    expect(Object.keys(await stored(page, 'wm.likes'))).toEqual(['35201']);
    expect(await page.evaluate(() => window.WM.state.index)).toBe(0);
  });

  test('przesunięcie w prawo polubia (serce), w lewo przechodzi do następnej karty, krótkie nic nie robi', async ({ page }) => {
    await startFeed(page);
    const first = page.getByTestId('card').first();
    const box = await first.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height * 0.4;

    // Krótkie przesunięcie (40 px): karta wraca, nic się nie dzieje.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y, { steps: 5 });
    await expect(first).toHaveClass(/is-dragging/);
    await page.mouse.up();
    await expect(first).not.toHaveClass(/is-dragging/);
    await expect(first.getByTestId('btn-like')).toHaveAttribute('aria-pressed', 'false');

    // W prawo o 130 px = polubienie; etykieta „Lubię” widoczna w trakcie; karta zostaje w widoku.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 50, y, { steps: 5 });
    await expect(first.locator('.swipe-label-like')).toHaveCSS('opacity', /0\.[5-9]|1/);
    await page.mouse.move(x + 130, y, { steps: 8 });
    await page.mouse.up();
    await expect(first.getByTestId('btn-like')).toHaveAttribute('aria-pressed', 'true');
    await expect(first).toHaveClass(/is-burst/);
    await sleep(500);
    expect(await page.evaluate(() => window.WM.state.index)).toBe(0);

    // W lewo o 130 px = następna karta, bez zapisu stanu.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 50, y, { steps: 5 });
    await expect(first.locator('.swipe-label-skip')).toHaveCSS('opacity', /0\.[5-9]|1/);
    await page.mouse.move(x - 130, y, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByTestId('card').nth(1)).toBeInViewport({ ratio: 0.9 });
    await expect.poll(() => page.evaluate(() => window.WM.state.index)).toBe(1);
    expect(Object.keys(await stored(page, 'wm.likes'))).toEqual(['35201']);
    expect(await stored(page, 'wm.saved')).toBeNull();
    await expect(page.getByTestId('card').nth(1).getByTestId('btn-like')).toHaveAttribute('aria-pressed', 'false');
  });

  test('dotyk: palec w prawo polubia, w lewo przechodzi dalej, pionowo przewija feed', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'gesty dotykowe tylko w projekcie mobilnym');
    await startFeed(page);
    const vp = page.viewportSize();
    const first = page.getByTestId('card').first();
    const box = await first.boundingBox();
    // Palec w prawo o 160 px → polubienie (dotyk jest niejawnie przechwytywany przez element pod palcem).
    await touchSwipe(page, { x: box.x + box.width * 0.3, y: box.y + box.height * 0.4 }, 160, 4);
    await expect(first.getByTestId('btn-like')).toHaveAttribute('aria-pressed', 'true');
    await sleep(400);
    expect(await page.evaluate(() => window.WM.state.index)).toBe(0);
    // Pionowy ruch palcem nad kartą to zwykłe przewijanie: feed idzie dalej, nic się nie polubia.
    await touchSwipe(page, { x: vp.width / 2, y: vp.height * 0.6 }, 0, -420, 14);
    await expect.poll(() => page.evaluate(() => window.WM.state.index)).toBeGreaterThanOrEqual(1);
    expect(await page.locator('.card.is-liked').count()).toBe(1);
    expect(await page.locator('.card.is-dragging').count()).toBe(0);
    await settle(page);   // dociągnięcie przyciągania (scroll-snap) po geście
    // Palec w lewo na bieżącej karcie → następna karta.
    const idx = await page.evaluate(() => window.WM.state.index);
    const current = page.getByTestId('card').nth(idx);
    const b2 = await current.boundingBox();
    await touchSwipe(page, { x: b2.x + b2.width * 0.7, y: b2.y + b2.height * 0.4 }, -150, 2);
    await expect.poll(() => page.evaluate(() => window.WM.state.index)).toBe(idx + 1);
    await expect(current.getByTestId('btn-like')).toHaveAttribute('aria-pressed', 'false');
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
    await expect(cardFor(page, 62340).getByTestId('card-distance')).toHaveText('1,4 km stąd');
    expect(await page.evaluate(() => localStorage.getItem('wm.radius'))).toBe('3000');
    expect(await feedOrder(page)).toEqual([...Array(9).fill('card'), 'ring-card:3000', 'loading-card']);
  });

  test('„Zapisz” i panel „Moje miejsca”: lista z odległością i linkami, usuwanie, Escape, trwałość po przeładowaniu', async ({ page }, testInfo) => {
    await startFeed(page);
    const first = page.getByTestId('card').first();
    const save = first.getByTestId('btn-save');
    const myPlaces = page.getByTestId('my-places');
    const badge = page.getByTestId('my-places-count');
    await expect(first.getByTestId('card-extract')).not.toHaveClass(/is-skeleton/);
    await save.click();
    await expect(save).toHaveAttribute('aria-pressed', 'true');
    await expect(save).toHaveText(/Zapisane/);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('1');
    await expect(myPlaces).toHaveAttribute('aria-label', 'Moje miejsca, zapisanych: 1');
    await sleep(600);
    expect(await page.evaluate(() => window.WM.state.index), 'zapisanie nie przewija').toBe(0);
    expect(await page.evaluate(() => window.WM.save(123))).toBe(true);
    await expect(badge).toHaveText('2');
    const savedStored = await stored(page, 'wm.saved');
    expect(Object.keys(savedStored).sort()).toEqual(['123', '35201']);
    expect(typeof savedStored[35201]).toBe('number');

    // Panel: od najnowszego; tytuł, odległość od bieżącego położenia, linki, „Usuń”.
    await myPlaces.click();
    const panel = page.getByTestId('my-places-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('role', 'dialog');
    await expect(myPlaces).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('panel-close')).toBeFocused();
    const rows = page.getByTestId('saved-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Zamek Królewski w Warszawie');
    await expect(rows.nth(1)).toContainText('Kolumna Zygmunta III Wazy w Warszawie');
    await expect(rows.nth(1).locator('.saved-distance')).toHaveText(DISTANCE_RE);
    await expect(rows.nth(1).getByRole('link', { name: /Czytaj w Wikipedii/ })).toHaveAttribute('href', 'https://pl.m.wikipedia.org/wiki/Kolumna_Zygmunta_III_Wazy_w_Warszawie');
    await expect(rows.nth(1).getByTestId('saved-navigate')).toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=52.24761,21.01413&travelmode=walking');
    await expect(rows.nth(0).getByTestId('saved-navigate')).toHaveAttribute('href', NAVIGATE_RE);
    await expect(rows.nth(0).getByTestId('saved-remove')).toHaveText('Usuń');
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: shot(testInfo, '08-my-places') });

    // Escape zamyka i oddaje fokus przyciskowi „Moje miejsca”.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(myPlaces).toBeFocused();
    await expect(myPlaces).toHaveAttribute('aria-expanded', 'false');

    // Usuwanie z listy odbija się na karcie i liczniku; pusta lista ma komunikat.
    await myPlaces.click();
    await rows.nth(0).getByTestId('saved-remove').click();
    await expect(rows).toHaveCount(1);
    await expect(badge).toHaveText('1');
    expect(await page.evaluate(() => window.WM.saved.isSaved(123))).toBe(false);
    await rows.nth(0).getByTestId('saved-remove').click();
    await expect(rows).toHaveCount(0);
    await expect(page.getByTestId('my-places-empty')).toHaveText('Nic jeszcze nie zapisałeś. Stuknij „Zapisz” na karcie miejsca.');
    await expect(badge).toBeHidden();
    await expect(save).toHaveAttribute('aria-pressed', 'false');
    await expect(save).toHaveText(/Zapisz/);
    expect(await stored(page, 'wm.saved')).toEqual({});
    await page.getByTestId('panel-close').click();
    await expect(panel).toBeHidden();

    // Trwałość: zapis przeżywa przeładowanie, lista działa jeszcze przed pobraniem szczegółów.
    await save.click();
    await expect(badge).toHaveText('1');
    await page.reload();
    await deterministic(page);
    await page.getByTestId('start-button').click();
    await expect(page.getByTestId('card').first()).toBeVisible();
    await expect(badge).toHaveText('1');
    await expect(cardFor(page, 35201).getByTestId('btn-save')).toHaveAttribute('aria-pressed', 'true');
    await myPlaces.click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Kolumna Zygmunta III Wazy w Warszawie');
    await expect(rows.first().getByTestId('saved-navigate')).toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=52.24761,21.01413&travelmode=walking');
    // Stuknięcie w tło zamyka panel.
    await panel.click({ position: { x: 10, y: 10 } });
    await expect(panel).toBeHidden();
  });

  test('klawiatura: Tab dochodzi do „Zapisz” i „Lubię”, Enter/Spacja przełączają; panel krąży fokusem i zamyka się Escape', async ({ page }) => {
    await startFeed(page);
    const active = () => page.evaluate(() => document.activeElement && (document.activeElement.dataset.testid || document.activeElement.id || document.activeElement.tagName));
    let a = '';
    for (let i = 0; i < 12 && a !== 'btn-save'; i++) {
      await page.keyboard.press('Tab');
      a = await active();
    }
    expect(a).toBe('btn-save');
    await page.keyboard.press('Enter');
    const first = page.getByTestId('card').first();
    await expect(first.getByTestId('btn-save')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Tab');
    expect(await active()).toBe('btn-like');
    await page.keyboard.press('Space');
    await expect(first.getByTestId('btn-like')).toHaveAttribute('aria-pressed', 'true');
    expect(await active(), 'fokus zostaje na przycisku').toBe('btn-like');
    expect(await page.evaluate(() => document.getElementById('feed').scrollTop)).toBe(0);
    const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return { fv: document.activeElement.matches(':focus-visible'), shadow: cs.boxShadow }; });
    expect(ring.fv).toBe(true);
    expect(ring.shadow).not.toBe('none');

    // Panel z klawiatury: Enter otwiera, fokus na „Zamknij”, Tab krąży po panelu, Escape zamyka i wraca.
    await page.getByTestId('my-places').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('my-places-panel')).toBeVisible();
    expect(await active()).toBe('panel-close');
    const seen = [];
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); seen.push(await active()); }
    expect(seen).toEqual(['A', 'saved-navigate', 'saved-remove', 'panel-close']);
    await page.keyboard.press('Shift+Tab');
    expect(await active()).toBe('saved-remove');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('my-places-panel')).toBeHidden();
    expect(await active()).toBe('my-places');
  });

  test('pierścienie: karta pierścienia po 1 km, dociąganie 3 → 5 → 10 km bez duplikatów, karta końcowa i „Od nowa”', async ({ page, context }, testInfo) => {
    await context.grantPermissions(['geolocation', 'clipboard-read', 'clipboard-write']);
    const log = await startFeed(page);
    expect(await placeIds(page)).toEqual(IDS_1000);
    const first = page.getByTestId('card').first();
    await expect(first.getByTestId('card-extract')).not.toHaveClass(/is-skeleton/);
    await first.getByTestId('btn-like').click();
    expect(await page.evaluate(() => window.WM.save(123))).toBe(true);

    // Dojście na 2 karty przed koniec dociąga 3 km: gsradius=3000 z gslimit=500; nowe karty za kartą pierścienia;
    // duplikaty z 1 km odfiltrowane.
    const ringRequest = page.waitForRequest((r) => /list=geosearch/.test(r.url()) && /gsradius=3000/.test(r.url()));
    await page.evaluate(() => document.querySelectorAll('[data-testid="card"]')[5].scrollIntoView());
    const url = new URL((await ringRequest).url());
    expect(url.searchParams.get('gslimit')).toBe('500');
    expect(url.searchParams.get('gscoord')).toBe('52.2497|21.0122');
    await expect(page.getByTestId('card')).toHaveCount(9);
    expect(await feedOrder(page)).toEqual([...Array(6).fill('card'), 'ring-card:1000', 'card', 'card', 'card', 'ring-card:3000', 'loading-card']);
    const after = await placeIds(page);
    expect(after).toEqual([...IDS_1000, ...IDS_3000_NEW]);
    expect(new Set(after).size).toBe(after.length);
    await expect(cardFor(page, 62340).getByTestId('card-distance')).toHaveText('1,4 km stąd');

    // Karta pierścienia 1 km: podsumowanie bez quizu, pasek polubionych, „Udostępnij”, zapowiedź następnego pierścienia.
    const ring = page.getByTestId('ring-card').first();
    await page.evaluate(() => document.querySelector('[data-testid="ring-card"]').scrollIntoView());
    await expect(ring).toBeInViewport({ ratio: 0.9 });
    await expect(ring).toHaveAttribute('data-radius', '1000');
    await expect(ring).toContainText('To wszystko w promieniu 1 km');
    await expect(ring).toContainText('Przejrzałeś 6 miejsc, polubiłeś 1, zapisałeś 1');
    await expect(ring).not.toContainText(/%|Znasz|Wiedziałeś/);
    await expect(ring.locator('.liked-thumb')).toHaveCount(1);
    await expect(ring.locator('.liked-thumb img')).toHaveCount(1);
    await expect(ring).toContainText('Dalej: miejsca 1–3 km stąd');
    await expect(ring.getByRole('button')).toHaveCount(1);
    await expect(ring.getByTestId('ring-share')).toHaveText(/Udostępnij/);
    await page.screenshot({ path: shot(testInfo, '03-ring') });
    await ring.getByTestId('ring-share').click();
    await expect(page.locator('#toast')).toHaveText('Skopiowano');
    const pageUrl = page.url().split('#')[0];
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`Odkryłem 6 miejsc w promieniu 1 km od siebie, 1 z nich polubiłem. Sprawdź swoją okolicę: ${pageUrl}`);

    // Dalej przez 5 km (2 nowe) i 10 km (3 nowe: Cytadela 2,2 km, lotnisko, Wilanów) do karty końcowej.
    await scrollToEnd(page);
    expect(await feedOrder(page)).toEqual([
      ...Array(6).fill('card'), 'ring-card:1000', 'card', 'card', 'card', 'ring-card:3000', 'card', 'card', 'ring-card:5000',
      'card', 'card', 'card', 'end-card',
    ]);
    const all = await placeIds(page);
    expect(all).toEqual([...IDS_1000, ...IDS_3000_NEW, ...IDS_5000_NEW, ...IDS_10000_NEW]);
    expect(new Set(all).size).toBe(14);
    await expect(cardFor(page, 73111).getByTestId('card-distance')).toHaveText('2,2 km stąd');
    await expect(cardFor(page, 68001).getByTestId('card-distance')).toHaveText('9,1 km stąd');
    expect(geoRadii(log)).toEqual(['1000', '3000', '5000', '10000']);
    await expect(page.getByTestId('ring-card').nth(1)).toContainText('Przejrzałeś 3 miejsca, polubiłeś 0');
    await expect(page.getByTestId('ring-card').nth(1)).toContainText('Dalej: miejsca 3–5 km stąd');
    await expect(page.getByTestId('ring-card').nth(2)).toContainText('Przejrzałeś 2 miejsca, polubiłeś 0');
    await expect(page.getByTestId('loading-card')).toHaveCount(0);

    const end = page.getByTestId('end-card');
    await expect(end).toBeInViewport({ ratio: 0.9 });
    await expect(end).toContainText('To wszystko, co Wikipedia zna w promieniu 10 km');
    await expect(end).toContainText('Przejrzałeś 14 miejsc, polubiłeś 1, zapisałeś 1');
    await expect(end).not.toContainText(/%|Znasz/);
    await expect(end.locator('.liked-thumb')).toHaveCount(1);
    await expect(end.getByRole('button', { name: 'Udostępnij' })).toBeVisible();
    await expect(end.getByRole('button', { name: 'Zmień miejsce' })).toBeVisible();
    await expect(end.getByRole('button', { name: 'Od nowa' })).toBeVisible();
    await expect(end.getByRole('button', { name: /Jeszcze raz|Zwiększ promień/ })).toHaveCount(0);
    await page.screenshot({ path: shot(testInfo, '03b-end') });
    await page.getByTestId('share-button').click();
    await expect(page.locator('#toast')).toHaveText('Skopiowano');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`Odkryłem 14 miejsc w promieniu 10 km od siebie, 1 z nich polubiłem. Sprawdź swoją okolicę: ${pageUrl}`);

    // „Od nowa”: czyści tylko obejrzane (polubienia i zapisane zostają) i losuje feed od pierścienia startowego.
    await page.evaluate(() => window.WM.markSeen(35201));
    expect((await stored(page, 'wm.seen')).length).toBeGreaterThan(0);
    await page.getByTestId('end-restart').click();
    await expect(page.getByTestId('card')).toHaveCount(6);
    expect(await stored(page, 'wm.seen')).toEqual([]);
    expect(Object.keys(await stored(page, 'wm.likes'))).toEqual(['35201']);
    expect(Object.keys(await stored(page, 'wm.saved'))).toEqual(['123']);
    await expect(page.getByTestId('card').first()).toBeInViewport({ ratio: 0.9 });
    expect(await page.evaluate(() => window.WM.state.index)).toBe(0);
    await expect(cardFor(page, 35201).getByTestId('btn-like')).toHaveAttribute('aria-pressed', 'true');
    await expect(cardFor(page, 123).getByTestId('btn-save')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('my-places-count')).toHaveText('1');
  });

  test('przewinięcie na koniec dociąga następny pierścień; karta ładowania i karta pierścienia bez polubień', async ({ page }, testInfo) => {
    const log = await startFeed(page, { slowRadius: 3000, slowMs: 1500 });
    expect(geoRadii(log)).toEqual(['1000']);
    await page.evaluate(() => document.querySelectorAll('[data-testid="card"]')[5].scrollIntoView());
    await expect.poll(() => geoRadii(log)).toEqual(['1000', '3000']);
    const loading = page.getByTestId('loading-card');
    await expect(loading).toContainText('Szukam miejsc 1–3 km stąd…');
    await expect(page.getByTestId('feed')).toHaveAttribute('aria-busy', 'true');
    const ring = page.getByTestId('ring-card').first();
    await expect(ring).toContainText('Przejrzałeś 6 miejsc, polubiłeś 0');
    await expect(ring).not.toContainText('zapisałeś');
    await expect(ring.locator('.liked-strip')).toBeHidden();
    await expect(ring.getByTestId('ring-share')).toBeVisible();
    await expect(ring).toContainText('Dalej: miejsca 1–3 km stąd');
    await page.evaluate(() => document.querySelector('[data-testid="ring-card"]').scrollIntoView());
    await expect(ring).toBeInViewport({ ratio: 0.9 });
    await page.screenshot({ path: shot(testInfo, '03c-ring-scrolled') });
    await expect(page.getByTestId('card')).toHaveCount(9);
    await expect(page.getByTestId('feed')).toHaveAttribute('aria-busy', 'false');
    expect(await feedOrder(page)).toEqual([...Array(6).fill('card'), 'ring-card:1000', 'card', 'card', 'card', 'ring-card:3000', 'loading-card']);
    // Polubienie doklejonej karty aktualizuje kartę pierścienia 3 km (linia i pasek z placeholderem albo miniaturą).
    await page.evaluate(() => window.WM.like(62340));
    await expect(page.getByTestId('ring-card').nth(1)).toContainText('Przejrzałeś 3 miejsca, polubiłeś 1');
    await expect(page.getByTestId('ring-card').nth(1).locator('.liked-thumb')).toHaveCount(1);
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

  test('po przeładowaniu: polubienia i zapisane wracają po pageid, obejrzane idą na koniec', async ({ page }) => {
    await startFeed(page);
    await page.evaluate(() => { window.WM.like(35201); window.WM.save(123); window.WM.markSeen(35201); window.WM.markSeen(123); });
    await page.reload();
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await deterministic(page);
    await page.getByTestId('start-button').click();
    await expect(page.getByTestId('card')).toHaveCount(6);
    expect(await placeIds(page)).toEqual([76112, 48803, 90455, 51277, 35201, 123]);
    await expect(page.getByTestId('card').first().getByTestId('card-title')).toHaveText('Plac Zamkowy w Warszawie');
    await expect(cardFor(page, 35201).getByTestId('btn-like')).toHaveAttribute('aria-pressed', 'true');
    await expect(cardFor(page, 35201).getByTestId('btn-like')).toHaveText(/Lubisz/);
    await expect(cardFor(page, 123).getByTestId('btn-save')).toHaveAttribute('aria-pressed', 'true');
    await expect(cardFor(page, 123).getByTestId('btn-like')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('my-places-count')).toHaveText('1');
  });

  test('pusty pierścień startowy 500 m → karta „nic nie ma”, dalej automatycznie 1 km, bez stanu pustego', async ({ page }, testInfo) => {
    const log = await mockWikipedia(page);
    await page.goto('./');
    await deterministic(page);
    await page.getByTestId('radius-chip-500').click();
    await expect(page.getByTestId('radius-chip-500')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('start-button').click();
    const ring = page.getByTestId('ring-card').first();
    await expect(ring).toBeInViewport({ ratio: 0.9 });
    await expect(ring).toHaveAttribute('data-radius', '500');
    await expect(ring).toContainText('W promieniu 500 m nic nie ma');
    await expect(ring).toContainText('Dalej: miejsca 500 m–1 km stąd');
    await expect(ring.getByTestId('ring-share')).toBeHidden();
    await expect(page.getByTestId('empty-state')).toBeHidden();
    await expect(page.getByTestId('card')).toHaveCount(6);
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
    expect(await page.evaluate(() => localStorage.getItem('wm.radius'))).toBe('3000');
  });

  test('0 wyników we wszystkich pierścieniach → stan pusty dopiero po 10 km', async ({ page }, testInfo) => {
    const log = await mockWikipedia(page, { empty: true });
    await page.goto('./');
    await page.getByTestId('start-button').click();
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
    await expect(page.getByTestId('card')).toHaveCount(6);
  });

  test('„Zmień miejsce” wraca na ekran startowy (i zamyka panel)', async ({ page }) => {
    await startFeed(page);
    await page.getByTestId('my-places').click();
    await expect(page.getByTestId('my-places-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByTestId('change-place').click();
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await expect(page.getByTestId('feed')).toBeHidden();
    await expect(page.getByTestId('my-places-panel')).toBeHidden();
    await expect(page.getByTestId('radius-chip-1000')).toBeVisible();
    await expect(page.getByTestId('card')).toHaveCount(0);
  });

  test('brak poziomego przewijania strony na starcie, w feedzie i w panelu', async ({ page }) => {
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
    // Pasek: oba przyciski mieszczą się w kolumnie i nie nachodzą na siebie.
    const mp = await page.getByTestId('my-places').boundingBox();
    const cp = await page.getByTestId('change-place').boundingBox();
    expect(mp.x).toBeGreaterThanOrEqual(app.x);
    expect(cp.x + cp.width).toBeLessThanOrEqual(app.x + app.width + 0.5);
    expect(mp.x + mp.width).toBeLessThanOrEqual(cp.x);
    await page.getByTestId('card').first().getByTestId('btn-save').click();
    await page.getByTestId('my-places').click();
    await expect(page.getByTestId('my-places-panel')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test.describe('bez zgody na lokalizację', () => {
  test.use({ permissions: [] });

  test('odmowa geolokalizacji → wpisanie miejsca działa od początku do końca', async ({ page }, testInfo) => {
    const log = await mockWikipedia(page);
    await page.goto('./');
    await deterministic(page);
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
    // Zapisane miejsce z innego środka ma odległość liczoną od nowego położenia.
    await first.getByTestId('btn-save').click();
    await page.getByTestId('my-places').click();
    await expect(page.getByTestId('saved-row').first().locator('.saved-distance')).toHaveText(DISTANCE_RE);
    await page.screenshot({ path: shot(testInfo, '07-place-feed') });
  });
});
