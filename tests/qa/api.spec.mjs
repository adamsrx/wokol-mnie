// QA: ryzyka żywego API, które mocki w smoke.spec.mjs ukrywają. Funkcje app.js są globalne (klasyczny skrypt),
// więc pickImage/truncateExtract/geosearch wywołujemy bezpośrednio przez page.evaluate.
import { test, expect, mockWiki, startFeed, makePlaces, makeSummary, json, WARSAW } from './helpers.mjs';

test.describe('QA: żywe API', () => {
  test.use({ geolocation: WARSAW, permissions: ['geolocation'] });

  test('@desktop kodowanie tytułów w URL REST, brak nagłówków niestandardowych, origin=*', async ({ page }) => {
    const titles = ["L'Aquila (miasto)", 'AC/DC', 'Kto zabił? (film)', 'Tom & Jerry', 'C++', '100% Kraków', 'Łódź Fabryczna', 'Zamek #1'];
    const expected = ["L'Aquila_(miasto)", 'AC%2FDC', 'Kto_zabi%C5%82%3F_(film)', 'Tom_%26_Jerry', 'C%2B%2B', '100%25_Krak%C3%B3w', '%C5%81%C3%B3d%C5%BA_Fabryczna', 'Zamek_%231'];
    const places = titles.map((t, i) => ({ pageid: 500 + i, ns: 0, title: t, lat: 52.25, lon: 21.01, dist: 10 + i * 20, primary: true }));
    const log = await startFeed(page, { places });
    const cards = page.getByTestId('card');
    for (let i = 0; i < titles.length; i++) {
      await page.evaluate((i) => document.querySelectorAll('[data-testid="card"]')[i].scrollIntoView(), i);
      await expect(cards.nth(i).getByTestId('card-extract')).not.toHaveClass(/is-skeleton/);
      await expect(cards.nth(i).getByTestId('card-extract')).toContainText(titles[i].slice(0, 5));
      await expect(cards.nth(i).getByRole('link', { name: /^Czytaj w Wikipedii/ })).toHaveAttribute('href', `https://pl.m.wikipedia.org/wiki/${encodeURIComponent(titles[i].replace(/ /g, '_'))}`);
    }
    const got = Object.fromEntries(log.rest.map((r) => [r.title, r.rawPath]));
    for (let i = 0; i < titles.length; i++) expect(got[titles[i]], titles[i]).toBe(expected[i]);

    const custom = log.requests.flatMap((r) => Object.keys(r.headers).filter((h) => /^(x-|api-user-agent|authorization|content-type)/i.test(h)).map((h) => `${h} @ ${r.url}`));
    expect(custom, 'nagłówki wymuszające preflight').toEqual([]);
    console.log(`[QA] nagłówki Accept wysyłane do Wikipedii: ${[...new Set(log.requests.map((r) => r.headers.accept))].join(' | ')}`);
    const api = log.requests.filter((r) => r.url.includes('/w/api.php'));
    expect(api.length).toBeGreaterThan(0);
    for (const r of api) {
      const u = new URL(r.url);
      expect(u.searchParams.get('origin')).toBe('*');
      expect(u.searchParams.get('formatversion')).toBe('2');
      expect(u.searchParams.get('format')).toBe('json');
    }
  });

  test('@desktop geosearch: gsradius ograniczony do 10–10000, gslimit 100, gsnamespace 0', async ({ page }) => {
    const log = await mockWiki(page);
    await page.goto('./');
    await page.evaluate(() => window.geosearch(52.2497, 21.0122, 99999).catch(() => null));
    await page.evaluate(() => window.geosearch(52.2497, 21.0122, 1).catch(() => null));
    const urls = log.requests.map((r) => new URL(r.url)).filter((u) => u.searchParams.get('list') === 'geosearch');
    expect(urls.map((u) => u.searchParams.get('gsradius'))).toEqual(['10000', '10']);
    for (const u of urls) {
      expect(u.searchParams.get('gslimit')).toBe('100');
      expect(u.searchParams.get('gsnamespace')).toBe('0');
      expect(u.searchParams.get('gscoord')).toBe('52.2497|21.0122');
    }
  });

  test('@desktop odpowiedź HTTP 200 z obiektem error (maxlag) powinna dać stan błędu, nie „pusto”', async ({ page }) => {
    await mockWiki(page, {
      geosearch: () => json({ error: { code: 'maxlag', info: 'Waiting for 10.64.0.1: 7 seconds lagged.', '*': 'See https://pl.wikipedia.org/w/api.php for API usage.' }, servedby: 'mw1234' }, 200, { 'retry-after': '5' }),
    });
    await page.goto('./');
    await page.getByTestId('start-button').click();
    const which = await Promise.race([
      page.getByTestId('error-state').waitFor({ state: 'visible' }).then(() => 'error'),
      page.getByTestId('empty-state').waitFor({ state: 'visible' }).then(() => 'empty'),
    ]);
    console.log(`[QA] 200 + {error:maxlag} → ekran: ${which}`);
    expect.soft(which, 'błąd API w ciele odpowiedzi 200 pokazuje „Tu jest pusto” zamiast błędu ze „Spróbuj ponownie”').toBe('error');
  });

  test('@desktop REST: ujednoznacznienie, brak extract/content_urls, 429, 503 bez CORS, podwójna awaria + ponów', async ({ page, consoleErrors }) => {
    consoleErrors.allow.push(/CORS|net::ERR_FAILED|Failed to load resource/);
    const places = makePlaces(6, { prefix: 'Obiekt' });
    const restored = { obiekt5: false }; // REST dla „Obiekt 5” pada, dopóki test nie „naprawi” serwisu
    const log = await startFeed(page, {
      places,
      summaries: {
        'Obiekt 1': { type: 'disambiguation', title: 'Obiekt 1', pageid: 1000, extract: 'Obiekt 1 może oznaczać:', content_urls: { mobile: { page: 'https://pl.m.wikipedia.org/wiki/Obiekt_1' } } },
        'Obiekt 2': { type: 'no-extract', title: 'Obiekt 2', pageid: 1001 },
        'Obiekt 6': { ...makeSummary(places[5]), originalimage: undefined },
      },
      rest: (title, nth) => {
        if (title === 'Obiekt 3' && nth === 1) return { status: 429, body: { type: 'https://mediawiki.org/wiki/HyperSwitch/errors/rate_exceeded', title: 'Too many requests', status: 429 } };
        if (title === 'Obiekt 4' && nth === 1) return { status: 503, headers: {} };
        if (title === 'Obiekt 5' && !restored.obiekt5) return { status: 503, body: { title: 'Service unavailable' } };
        return null;
      },
      extracts: (ids) => (ids.includes(1004) ? [] : ids.map((id) => ({
        pageid: id, ns: 0, title: `Obiekt ${id - 999}`,
        extract: `Obiekt ${id - 999} – opis z klasycznego API. Drugie zdanie. Trzecie zdanie.`,
        thumbnail: { source: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Obiekt_${id - 999}.jpg/1000px-Obiekt_${id - 999}.jpg`, width: 1000, height: 667 },
      }))),
    });
    const cards = page.getByTestId('card');
    for (let i = 0; i < 6; i++) {
      await page.evaluate((i) => document.querySelectorAll('[data-testid="card"]')[i].scrollIntoView(), i);
      await expect(cards.nth(i).getByTestId('card-extract')).not.toHaveClass(/is-skeleton/);
    }
    await expect(cards.nth(0).getByTestId('card-extract')).toHaveText('Obiekt 1 może oznaczać:');
    await expect(cards.nth(1).getByTestId('card-extract')).toHaveText('Wikipedia nie ma jeszcze opisu tego miejsca.');
    await expect(cards.nth(1).getByRole('link', { name: /^Czytaj w Wikipedii/ })).toHaveAttribute('href', 'https://pl.wikipedia.org/wiki/Obiekt_2');
    await expect(cards.nth(1).locator('.card-photo')).toBeHidden();
    await expect(cards.nth(2).getByTestId('card-extract')).toContainText('opis z klasycznego API');
    const fb = log.requests.map((r) => new URL(r.url)).find((u) => u.searchParams.get('prop') === 'extracts|pageimages' && u.searchParams.get('pageids') === '1002');
    expect(fb).toBeTruthy();
    expect(Object.fromEntries(fb.searchParams)).toMatchObject({ action: 'query', exintro: '1', explaintext: '1', exlimit: '1', exsentences: '3', piprop: 'thumbnail', pithumbsize: '1000', origin: '*', formatversion: '2' });
    await expect(cards.nth(2).locator('.card-photo')).toHaveClass(/is-loaded/);
    await expect(cards.nth(3).getByTestId('card-extract')).toContainText('opis z klasycznego API');
    const err = cards.nth(4).locator('.card-detail-error');
    // Karta 5 ma być w widoku i „ustawiona” (index=4), bo aplikacja ponawia pobieranie przy każdym wejściu karty w widok.
    await page.evaluate(() => document.querySelectorAll('[data-testid="card"]')[4].scrollIntoView());
    await expect.poll(() => page.evaluate(() => window.WM.state.index)).toBe(4);
    await expect(err).toBeVisible();
    await expect(err).toContainText('Nie udało się pobrać opisu.');
    await expect(page.getByTestId('error-state')).toBeHidden();
    const attempts = log.restCount.get('Obiekt 5');
    console.log(`[QA] karta z błędem: prób REST przed kliknięciem „Spróbuj ponownie”: ${attempts} (aplikacja ponawia przy każdym wejściu karty w widok)`);
    restored.obiekt5 = true;
    await err.getByRole('button', { name: 'Spróbuj ponownie' }).click();
    await expect(cards.nth(4).getByTestId('card-extract')).toContainText('Obiekt 5 – obiekt w Warszawie');
    await expect(err).toBeHidden();
    console.log(`[QA] obraz żądany dla miniatury bez originalimage: ${log.images.filter((u) => u.includes('Obiekt_6')).join(', ')}`);
    console.log(`[QA] liczba żądań REST: ${log.rest.length}, api.php: ${log.requests.filter((r) => r.url.includes('/w/api.php')).length}`);
  });

  test('@desktop pickImage: przepisywanie URL miniatur Commons', async ({ page }) => {
    await mockWiki(page);
    await page.goto('./');
    const C = 'https://upload.wikimedia.org/wikipedia/commons';
    const cases = [
      ['jpg 320 → 1000px', { source: `${C}/thumb/4/4b/Foo.jpg/320px-Foo.jpg`, width: 320, height: 213 }, { source: `${C}/4/4b/Foo.jpg`, width: 4000, height: 2667 }, `${C}/thumb/4/4b/Foo.jpg/1000px-Foo.jpg`],
      ['oryginał 800 px → oryginał', { source: `${C}/thumb/4/4b/Foo.jpg/320px-Foo.jpg`, width: 320, height: 213 }, { source: `${C}/4/4b/Foo.jpg`, width: 800, height: 533 }, `${C}/4/4b/Foo.jpg`],
      ['png', { source: `${C}/thumb/5/5e/Plan.png/320px-Plan.png`, width: 320, height: 200 }, { source: `${C}/5/5e/Plan.png`, width: 2400, height: 1500 }, `${C}/thumb/5/5e/Plan.png/1000px-Plan.png`],
      ['svg mały → plik .svg', { source: `${C}/thumb/1/1a/Herb.svg/320px-Herb.svg.png`, width: 320, height: 400 }, { source: `${C}/1/1a/Herb.svg`, width: 600, height: 750 }, `${C}/1/1a/Herb.svg`],
      ['svg duży → 1000px .svg.png', { source: `${C}/thumb/1/1a/Mapa.svg/320px-Mapa.svg.png`, width: 320, height: 200 }, { source: `${C}/1/1a/Mapa.svg`, width: 3000, height: 1875 }, `${C}/thumb/1/1a/Mapa.svg/1000px-Mapa.svg.png`],
      ['webp', { source: `${C}/thumb/3/3c/Foto.webp/320px-Foto.webp.png`, width: 320, height: 213 }, { source: `${C}/3/3c/Foto.webp`, width: 3000, height: 2000 }, `${C}/thumb/3/3c/Foto.webp/1000px-Foto.webp.png`],
      ['tif (lossy-page1-) → bez zmiany', { source: `${C}/thumb/2/2b/Skan.tif/lossy-page1-320px-Skan.tif.jpg`, width: 320, height: 240 }, { source: `${C}/2/2b/Skan.tif`, width: 5000, height: 3750 }, `${C}/thumb/2/2b/Skan.tif/lossy-page1-320px-Skan.tif.jpg`],
      ['pdf (page1-) → bez zmiany', { source: `${C}/thumb/2/2b/Mapa.pdf/page1-320px-Mapa.pdf.jpg`, width: 320, height: 450 }, { source: `${C}/2/2b/Mapa.pdf`, width: 2480, height: 3508 }, `${C}/thumb/2/2b/Mapa.pdf/page1-320px-Mapa.pdf.jpg`],
      ['plik o nazwie 300px-Foo.jpg', { source: `${C}/thumb/1/1a/300px-Foo.jpg/320px-300px-Foo.jpg`, width: 320, height: 213 }, { source: `${C}/1/1a/300px-Foo.jpg`, width: 3000, height: 2000 }, `${C}/thumb/1/1a/300px-Foo.jpg/1000px-300px-Foo.jpg`],
      ['mały oryginał serwowany bez /thumb/', { source: `${C}/a/a9/Small.jpg`, width: 275, height: 183 }, { source: `${C}/a/a9/Small.jpg`, width: 275, height: 183 }, `${C}/a/a9/Small.jpg`],
      ['miniatura ≥ 1000 → miniatura', { source: `${C}/thumb/4/4b/Foo.jpg/1200px-Foo.jpg`, width: 1200, height: 800 }, { source: `${C}/4/4b/Foo.jpg`, width: 4000, height: 2667 }, `${C}/thumb/4/4b/Foo.jpg/1200px-Foo.jpg`],
      ['bez originalimage → 1000px (możliwy upscaling)', { source: `${C}/thumb/4/4b/Foo.jpg/320px-Foo.jpg`, width: 320, height: 213 }, undefined, `${C}/thumb/4/4b/Foo.jpg/1000px-Foo.jpg`],
    ];
    const results = await page.evaluate((cases) => cases.map(([name, t, o, want]) => [name, window.pickImage(t, o), want]), cases);
    for (const [name, got, want] of results) console.log(`[QA] pickImage ${got === want ? 'OK ' : 'ŹLE'} ${name}: ${got}`);
    expect.soft(results.filter(([, got, want]) => got !== want).map(([n]) => n)).toEqual([]);
  });

  test('@desktop truncateExtract: skróty (św., ul., ok., im., pl.) nie kończą zdania', async ({ page }) => {
    await mockWiki(page);
    await page.goto('./');
    const r = await page.evaluate(() => ({
      abbr: window.truncateExtract('Kościół św. Jana przy ul. Świętojańskiej, wzniesiony ok. 1548 roku. Drugie zdanie opisu. Trzecie zdanie opisu. Czwarte zdanie.'),
      abbr2: window.truncateExtract('Pomnik im. Tadeusza Kościuszki na pl. Wolności, odsłonięty w 1920 r. Zniszczony w 1939 r. Odbudowany w 1950 r. Czwarte zdanie.'),
      plain: window.truncateExtract('Pierwsze zdanie. Drugie zdanie. Trzecie zdanie. Czwarte zdanie.'),
      long: window.truncateExtract('Słowo '.repeat(80).trim() + '.'),
      empty: window.truncateExtract(undefined),
      ws: window.truncateExtract('  Tekst\n\nz   odstępami.  '),
    }));
    console.log('[QA] truncateExtract: ' + JSON.stringify(r, null, 1));
    expect(r.plain).toBe('Pierwsze zdanie. Drugie zdanie. Trzecie zdanie.');
    expect(r.empty).toBe('');
    expect(r.ws).toBe('Tekst z odstępami.');
    expect(r.long.length).toBeLessThanOrEqual(281);
    expect(r.long.endsWith('…')).toBe(true);
    expect.soft(r.abbr, 'skróty „św.”, „ul.”, „ok.” liczone jako koniec zdania').toBe('Kościół św. Jana przy ul. Świętojańskiej, wzniesiony ok. 1548 roku. Drugie zdanie opisu. Trzecie zdanie opisu.');
    expect.soft(r.abbr2, 'skróty „im.”, „pl.” liczone jako koniec zdania').toBe('Pomnik im. Tadeusza Kościuszki na pl. Wolności, odsłonięty w 1920 r. Zniszczony w 1939 r. Odbudowany w 1950 r.');
  });

  test('@desktop wyszukiwanie miejsca: współrzędne spoza Ziemi (globe≠earth) nie powinny być środkiem', async ({ page }) => {
    await mockWiki(page);
    await page.route(/generator=search/, (route) => route.fulfill(json({ batchcomplete: true, query: { pages: [
      { pageid: 11, ns: 0, title: 'Olympus Mons', index: 1, coordinates: [{ lat: 18.65, lon: 226.2, primary: true, globe: 'mars' }] },
      { pageid: 12, ns: 0, title: 'Olimp', index: 2, coordinates: [{ lat: 40.09, lon: 22.36, primary: true, globe: 'earth' }] },
    ] } })));
    await page.goto('./');
    await page.locator('#place-toggle').click();
    await page.getByTestId('place-input').fill('Olympus');
    const geo = page.waitForRequest((r) => /list=geosearch/.test(r.url()));
    await page.getByTestId('place-submit').click();
    const u = new URL((await geo).url());
    console.log(`[QA] gscoord po wyszukaniu „Olympus”: ${u.searchParams.get('gscoord')}`);
    expect.soft(u.searchParams.get('gscoord'), 'globe≠earth wybrany jako środek').toBe('40.09|22.36');
  });
});
