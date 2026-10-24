// Wspólny mock Wikipedii dla testów QA — bardziej konfigurowalny niż ten w smoke.spec.mjs.
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const here = dirname(fileURLToPath(import.meta.url));
export const ARTIFACTS = join(here, '..', 'artifacts');
const fixturesDir = join(here, '..', 'fixtures');
export const fixture = (name) => JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
export const FIX = {
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
export const WARSAW = { latitude: 52.2497, longitude: 21.0122 };
export const PHOTO = readFileSync(join(fixturesDir, 'photo-1.svg'), 'utf8');
export const WHITE_PHOTO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1500" width="1000" height="1500">'
  + '<rect width="1000" height="1500" fill="#f6f5f0"/><circle cx="500" cy="700" r="380" fill="#ffffff"/>'
  + '<rect x="0" y="1150" width="1000" height="350" fill="#e9e6dc"/></svg>';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const json = (body, status = 200, headers = {}) => ({
  status,
  contentType: 'application/json; charset=utf-8',
  headers: { 'access-control-allow-origin': '*', ...headers },
  body: JSON.stringify(body),
});

/* Generatory danych. */
export function makePlaces(n, { prefix = 'Miejsce', startId = 1000, startDist = 40, step = 47 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    pageid: startId + i,
    ns: 0,
    title: `${prefix} ${i + 1}`,
    lat: 52.25 + i * 0.0001,
    lon: 21.01 + i * 0.0001,
    dist: startDist + i * step,
    primary: true,
  }));
}

export function makeSummary(place, extra = {}) {
  const t = place.title;
  const file = encodeURIComponent(t.replace(/ /g, '_')).replace(/%/g, '') + '.jpg';
  return {
    type: 'standard',
    title: t,
    pageid: place.pageid,
    extract: `${t} – obiekt w Warszawie, znany z testów. Powstał w 1900 roku. Zdanie trzecie opisu. Zdanie czwarte, którego nie powinno być widać.`,
    thumbnail: { source: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${file}/320px-${file}`, width: 320, height: 213 },
    originalimage: { source: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${file}`, width: 4000, height: 2667 },
    lang: 'pl',
    dir: 'ltr',
    content_urls: {
      desktop: { page: `https://pl.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}` },
      mobile: { page: `https://pl.m.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}` },
    },
    ...extra,
  };
}

/* Mock. Opcje:
   places: tablica geosearch albo funkcja (radius, gscoord) → tablica; null = jak w smoke (fixtury wg promienia)
   summaries: { tytuł → summary }; brakujące tytuły dostają wygenerowane summary (jeśli generate=true) albo 404
   rest: (title, nth) → { status, body, delay, headers } | null  — nadpisanie odpowiedzi REST
   extracts: (pageids[]) → pages[]  — odpowiedź fallbacku extracts|pageimages (domyślnie generowane)
   geosearch: (params) → fulfill  — pełne nadpisanie geosearch
   photo: 'default' | 'white' | (url) → svg
   restDelay: ms */
export async function mockWiki(page, o = {}) {
  const opts = { places: null, summaries: {}, generate: true, rest: null, extracts: null, geosearch: null, photo: 'default', restDelay: 0, ...o };
  const log = { requests: [], rest: [], images: [], restCount: new Map() };
  const allPlaces = () => {
    if (Array.isArray(opts.places)) return opts.places;
    return [...FIX.g3000.query.geosearch, ...FIX.gKrakow.query.geosearch];
  };
  const summaryFor = (title) => {
    if (opts.summaries[title]) return opts.summaries[title];
    if (FIX.summaries[title] && !Array.isArray(opts.places)) return FIX.summaries[title];
    const place = allPlaces().find((p) => p.title === title);
    if (place && opts.generate) return makeSummary(place);
    return null;
  };

  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  await page.route('https://upload.wikimedia.org/**', (route) => {
    const url = route.request().url();
    log.images.push(url);
    const body = typeof opts.photo === 'function' ? opts.photo(url) : (opts.photo === 'white' ? WHITE_PHOTO : PHOTO);
    if (body === null) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body });
  });

  await page.route('https://pl.wikipedia.org/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    log.requests.push({ url: url.href, headers: req.headers() });

    if (url.pathname.startsWith('/api/rest_v1/page/summary/')) {
      const rawPath = url.pathname.slice('/api/rest_v1/page/summary/'.length);
      const title = decodeURIComponent(rawPath).replace(/_/g, ' ');
      const nth = (log.restCount.get(title) || 0) + 1;
      log.restCount.set(title, nth);
      log.rest.push({ rawPath, title, nth });
      const override = opts.rest ? opts.rest(title, nth) : null;
      if (override) {
        if (override.delay) await sleep(override.delay);
        if (override.body === undefined) {
          return route.fulfill({ status: override.status || 500, contentType: 'text/html', headers: override.headers || {}, body: `<h1>${override.status}</h1>` });
        }
        return route.fulfill(json(override.body, override.status || 200, override.headers || {}));
      }
      if (opts.restDelay) await sleep(opts.restDelay);
      const summary = summaryFor(title);
      if (summary) return route.fulfill(json(summary));
      return route.fulfill(json({ type: 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found', title: 'Not found.', method: 'get', detail: 'Page or revision not found.', uri: url.pathname }, 404));
    }

    if (url.pathname === '/w/api.php') {
      const p = url.searchParams;
      if (p.get('list') === 'geosearch') {
        if (opts.geosearch) return route.fulfill(opts.geosearch(p));
        const radius = Number(p.get('gsradius'));
        const coord = p.get('gscoord') || '';
        if (typeof opts.places === 'function') return route.fulfill(json({ batchcomplete: true, query: { geosearch: opts.places(radius, coord) } }));
        if (Array.isArray(opts.places)) return route.fulfill(json({ batchcomplete: true, query: { geosearch: opts.places } }));
        if (coord.startsWith('50.06')) return route.fulfill(json(FIX.gKrakow));
        if (radius <= 500) return route.fulfill(json(FIX.gEmpty));
        // Jak w smoke: 1 km → 6, 3 km → 9 miejsc; dalsze pierścienie (5 i 10 km) nie wnoszą tu nic nowego,
        // więc po 3 km feed v0.1 zamyka się kartą końcową.
        return route.fulfill(json(radius >= 3000 ? FIX.g3000 : FIX.g1000));
      }
      if (p.get('prop') === 'extracts|pageimages') {
        const ids = (p.get('pageids') || '').split('|').map(Number);
        let pages;
        if (opts.extracts) pages = opts.extracts(ids);
        else {
          pages = ids.map((id) => FIX.extracts[id] || (() => {
            const place = allPlaces().find((x) => x.pageid === id);
            return place ? { pageid: id, ns: 0, title: place.title, extract: `${place.title} – opis z klasycznego API. Drugie zdanie. Trzecie zdanie.` } : null;
          })()).filter(Boolean);
        }
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

/* Test z zbieraniem błędów: pageerror zawsze oblewa; błędy konsoli są raportowane w wyniku. */
export const test = base.extend({
  consoleErrors: [async ({ page }, use, testInfo) => {
    const errors = [];
    errors.allow = [/Failed to load resource/];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`[console] ${msg.text()} (${msg.location().url})`); });
    page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
    await use(errors);
    const unexpected = errors.filter((e) => e.startsWith('[pageerror]') || !errors.allow.some((rx) => rx.test(e)));
    if (errors.length) testInfo.annotations.push({ type: 'console', description: errors.join('\n') });
    expect(unexpected, 'błędy w konsoli przeglądarki').toEqual([]);
  }, { auto: true }],
});
export { expect };

/* v0.2: kolejność kart w pierścieniu jest losowa. Testom, którym zależy na kolejności, unieruchamiamy losowanie
   (0.9999 w tasowaniu Fishera–Yatesa zostawia kolejność z API); options.random = true zostawia prawdziwe losowanie. */
export const deterministic = (page) => page.evaluate(() => { window.WM.rng.next = () => 0.9999; });

export async function startFeed(page, options = {}) {
  const { random = false, ...mockOptions } = options;
  const log = await mockWiki(page, mockOptions);
  await page.goto('./');
  if (!random) await deterministic(page);
  await page.getByTestId('start-button').click();
  await expect(page.getByTestId('feed')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('card').first()).toBeVisible({ timeout: 10_000 });
  return log;
}

/* Przewija feed na sam dół tak długo, aż załadują się wszystkie pierścienie i stanie karta końcowa. */
export async function scrollToEnd(page) {
  await expect.poll(async () => {
    await page.evaluate(() => { const f = document.getElementById('feed'); f.scrollTo({ top: f.scrollHeight, behavior: 'auto' }); });
    return page.evaluate(() => window.WM.state.feedDone && Boolean(document.querySelector('[data-testid="end-card"]')));
  }, { timeout: 20_000, intervals: [200, 300, 500] }).toBe(true);
}

export const cardFor = (page, pageid) => page.locator(`[data-testid="card"][data-pageid="${pageid}"]`);

export const shot = (testInfo, name) => join(ARTIFACTS, `qa-${testInfo.project.name}-${name}.png`);



/* Nadpisanie geolokalizacji sterowane z testu: window.__geo.resolve({latitude, longitude}) / reject(code). */
export const GEO_OVERRIDE = `
  (() => {
    const calls = [];
    const api = { calls, pending: null,
      resolve(c) { const p = api.pending; api.pending = null; if (p) p.ok({ coords: { latitude: c.latitude, longitude: c.longitude, accuracy: 20 }, timestamp: Date.now() }); },
      reject(code) { const p = api.pending; api.pending = null; if (p) p.err({ code, message: 'mock', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }); } };
    const fake = {
      getCurrentPosition(ok, err, options) { calls.push(options || {}); api.pending = { ok, err }; },
      watchPosition() { return 1; }, clearWatch() {},
    };
    Object.defineProperty(navigator, 'geolocation', { configurable: true, get: () => fake });
    window.__geo = api;
  })();
`;
