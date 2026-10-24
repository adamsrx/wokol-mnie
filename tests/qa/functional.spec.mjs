// QA: scenariusze funkcjonalne nieobjęte przez smoke.spec.mjs.
import { test, expect, mockWiki, startFeed, makePlaces, makeSummary, WARSAW, GEO_OVERRIDE, shot, sleep } from './helpers.mjs';

test.describe('QA: funkcjonalne', () => {
  test.use({ geolocation: WARSAW, permissions: ['geolocation'] });

  test('@m360 szybki podwójny tap na „Wiedziałem” (i od razu „Nie wiedziałem”) liczy się raz', async ({ page }) => {
    await startFeed(page);
    const first = page.getByTestId('card').first();
    await page.evaluate(() => {
      const card = document.querySelector('[data-testid="card"]');
      card.querySelector('[data-testid="btn-known"]').click();
      card.querySelector('[data-testid="btn-known"]').click();
      card.querySelector('[data-testid="btn-unknown"]').click();
    });
    await expect(first).toHaveAttribute('data-answer', 'true');
    expect(await page.evaluate(() => window.WM.answer(35201, false))).toBe(false);
    await expect(page.getByTestId('card').nth(1)).toBeInViewport({ ratio: 0.9 });
    await expect(page.getByTestId('progress')).toHaveText('2 z 6 · znasz 1');
    expect(await page.evaluate(() => window.WM.state.answers)).toEqual({ 35201: true });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wm.answers')))).toEqual({ 35201: true });

    // Drugi tap w to samo miejsce ekranu ~300 ms po odpowiedzi (w trakcie automatycznego przewijania).
    const second = page.getByTestId('card').nth(1);
    const box = await second.getByTestId('btn-known').boundingBox();
    await second.getByTestId('btn-known').click();
    await sleep(300);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(1000);
    const third = await page.getByTestId('card').nth(2).getAttribute('data-answer');
    console.log(`[QA] tap 300 ms po odpowiedzi trafił w następną kartę: ${third ? `TAK (data-answer=${third})` : 'nie'}; progress="${await page.getByTestId('progress').textContent()}"`);
  });

  test('@m360 przesunięcie w trakcie ładowania opisu zapisuje odpowiedź; opis dochodzi później', async ({ page }) => {
    await startFeed(page, { restDelay: 2500 });
    const first = page.getByTestId('card').first();
    await expect(first.getByTestId('card-extract')).toHaveClass(/is-skeleton/);
    const box = await first.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height * 0.4;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 150, y, { steps: 10 });
    await page.mouse.up();
    await expect(first).toHaveAttribute('data-answer', 'true');
    await expect(page.getByTestId('progress')).toHaveText(/znasz 1$/);
    await expect(first.getByTestId('card-extract')).not.toHaveClass(/is-skeleton/, { timeout: 10_000 });
    await expect(first.getByTestId('card-extract')).toContainText('Kolumna Zygmunta');
    await expect(first).toHaveClass(/is-answered/);
    await expect(first.locator('.card-stamp-text')).toHaveText('Wiedziałeś');
  });

  test('@m360 zmiana promienia w trakcie sesji: odpowiedzi przywracane z localStorage, cache szczegółów porzucany', async ({ page }) => {
    const log = await startFeed(page);
    await page.evaluate(() => { window.WM.answer(35201, true); window.WM.answer(123, false); });
    await expect(page.getByTestId('progress')).toHaveText(/znasz 1$/);
    const restBefore = log.rest.filter((r) => r.title === 'Kolumna Zygmunta III Wazy w Warszawie').length;
    await page.getByTestId('radius-chip-3000').click();
    await expect(page.getByTestId('card')).toHaveCount(9);
    const answers = await page.evaluate(() => window.WM.state.answers);
    console.log(`[QA] po zmianie promienia 1 km → 3 km: state.answers=${JSON.stringify(answers)}, progress="${await page.getByTestId('progress').textContent()}"`);
    // Obserwacja: SPEC §3 mówi „wynik sesji od nowa”, implementacja przywraca odpowiedzi po pageid.
    expect(answers).toEqual({ 35201: true, 123: false });
    await expect(page.getByTestId('card').nth(2)).toBeInViewport({ ratio: 0.9 });
    await expect(page.getByTestId('progress')).toHaveText('3 z 9 · znasz 1');
    await expect(page.getByTestId('card').first()).toHaveAttribute('data-answer', 'true');
    const restAfter = log.rest.filter((r) => r.title === 'Kolumna Zygmunta III Wazy w Warszawie').length;
    console.log(`[QA] żądania REST summary tej samej strony przed/po zmianie promienia: ${restBefore}/${restAfter}`);
    await page.getByTestId('radius-chip-1000').click();
    await expect(page.getByTestId('card')).toHaveCount(6);
    await expect(page.getByTestId('progress')).toHaveText('3 z 6 · znasz 1');
  });

  test('@m360 localStorage rzuca wyjątek: aplikacja działa dalej (odpowiedzi tylko w pamięci)', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    });
    await startFeed(page);
    await expect(page.getByTestId('radius-chip-1000')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('card').first().getByTestId('btn-known').click();
    await expect(page.getByTestId('progress')).toHaveText('2 z 6 · znasz 1');
    await page.getByTestId('radius-chip-3000').click();
    await expect(page.getByTestId('card')).toHaveCount(9);
    await expect(page.getByTestId('radius-chip-3000')).toHaveAttribute('aria-checked', 'true');
    console.log(`[QA] bez localStorage po zmianie promienia: progress="${await page.getByTestId('progress').textContent()}" (odpowiedzi z pamięci przepadają — loadAround zeruje state.answers)`);
    await page.evaluate(() => { for (const p of window.WM.state.places) window.WM.answer(p.pageid, p.pageid % 2 === 0); });
    // v0.1: po ostatniej karcie pierścienia jest karta pierścienia 3 km; pierścienie 5 i 10 km nie wnoszą tu nic nowego,
    // więc tuż za nią stoi karta końcowa (bez localStorage wynik liczy się z pamięci).
    const ring = page.getByTestId('ring-card').first();
    await expect(ring).toBeInViewport({ ratio: 0.9, timeout: 15_000 });
    await expect(ring).toContainText('To wszystko w promieniu 3 km');
    await expect(ring).toContainText(/Znasz \d+% \(\d+ z 9 miejsc\)/);
    const end = page.getByTestId('end-card');
    await end.scrollIntoViewIfNeeded();
    await expect(end).toBeInViewport({ ratio: 0.9 });
    await expect(end).toContainText('To wszystko, co Wikipedia zna w promieniu 10 km');
    await expect(end).toContainText(/Znasz \d+% \(\d+ z 9 miejsc\)/);
  });

  test('@all geolokalizacja: timeout 10 s (kod 3) i wyścig spóźnionego GPS z wpisanym miejscem', async ({ page }) => {
    await page.addInitScript(GEO_OVERRIDE);
    await mockWiki(page);
    await page.goto('./');
    const start = page.getByTestId('start-button');
    await start.click();
    await expect(start).toBeDisabled();
    await expect(start).toHaveText(/Ustalam położenie…/);
    const opts = await page.evaluate(() => window.__geo.calls[0]);
    expect(opts.timeout).toBe(10000);
    expect(opts.enableHighAccuracy).toBe(false);
    await expect(page.locator('#place-toggle')).toBeVisible();
    await page.evaluate(() => window.__geo.reject(3));
    await expect(page.locator('#geo-message')).toContainText('trwa zbyt długo');
    await expect(start).toBeEnabled();
    await expect(start).toHaveText(/Pokaż, co jest wokół/);
    await expect(page.getByTestId('place-input')).toBeFocused();

    // Wyścig: GPS wisi, użytkownik wpisuje miejsce i dostaje feed; potem przychodzi spóźniony fix GPS.
    await start.click();
    await expect(start).toBeDisabled();
    await page.getByTestId('place-input').fill('Rynek Główny Kraków');
    await page.getByTestId('place-submit').click();
    await expect(page.getByTestId('card').first().getByTestId('card-title')).toHaveText('Sukiennice w Krakowie');
    await page.evaluate(() => window.__geo.resolve({ latitude: 52.2497, longitude: 21.0122 }));
    await sleep(1500);
    const title = await page.getByTestId('card').first().getByTestId('card-title').textContent();
    console.log(`[QA] po spóźnionym fixie GPS pierwsza karta: „${title}”`);
    expect.soft(title, 'spóźniony fix GPS nie powinien podmieniać wpisanego przez użytkownika miejsca').toBe('Sukiennice w Krakowie');
  });

  test('@mobile bardzo długi tytuł i opis mieszczą się na ekranie', async ({ page }, testInfo) => {
    const title = 'Kościół Najświętszej Maryi Panny Matki Kościoła i Świętej Barbary Dziewicy i Męczennicy w Warszawie-Wesołej (Stara Miłosna)';
    const places = [{ pageid: 9001, ns: 0, title, lat: 52.25, lon: 21.01, dist: 123, primary: true }, ...makePlaces(2, { startId: 9002 })];
    const extract = ('Bardzo długi opis bez końca zdania, ' + 'który ciągnie się i ciągnie, '.repeat(60)).trim();
    await startFeed(page, { places, summaries: { [title]: makeSummary(places[0], { extract }) } });
    const first = page.getByTestId('card').first();
    await expect(first.getByTestId('card-extract')).not.toHaveClass(/is-skeleton/);
    const vp = page.viewportSize();
    const known = await first.getByTestId('btn-known').boundingBox();
    const unknown = await first.getByTestId('btn-unknown').boundingBox();
    const titleBox = await first.getByTestId('card-title').boundingBox();
    const topbar = await page.locator('#topbar').boundingBox();
    const distBox = await first.getByTestId('card-distance').boundingBox();
    console.log(`[QA ${testInfo.project.name}] długi tytuł: odznaka y=${Math.round(distBox.y)}, tytuł y=${Math.round(titleBox.y)} h=${Math.round(titleBox.height)}, pasek do y=${Math.round(topbar.y + topbar.height)}, przyciski do y=${Math.round(known.y + known.height)} / ${vp.height}`);
    expect(known.y + known.height).toBeLessThanOrEqual(vp.height);
    expect(unknown.y + unknown.height).toBeLessThanOrEqual(vp.height);
    expect(known.x + known.width).toBeLessThanOrEqual(vp.width + 1);
    expect(distBox.y, 'treść karty nie powinna wchodzić pod pasek górny').toBeGreaterThanOrEqual(topbar.y + topbar.height - 8);
    expect((await first.getByTestId('card-extract').textContent()).length).toBeLessThanOrEqual(281);
    await page.screenshot({ path: shot(testInfo, 'long-title') });
    const overlap = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="card"]');
      card.querySelector('[data-testid="btn-known"]').click();
      const s = card.querySelector('.card-stamp').getBoundingClientRect();
      const t = card.querySelector('.card-title').getBoundingClientRect();
      return !(s.bottom <= t.top || s.top >= t.bottom || s.right <= t.left || s.left >= t.right);
    });
    console.log(`[QA ${testInfo.project.name}] pieczątka „Wiedziałeś” nachodzi na długi tytuł: ${overlap}`);
  });

  test('@mobile 100 wyników: DOM, leniwe obrazy, pasek górny przy długim liczniku', async ({ page }, testInfo) => {
    const places = makePlaces(100);
    const log = await mockWiki(page, { places });
    await page.goto('./');
    const t0 = Date.now();
    await page.getByTestId('start-button').click();
    await expect(page.getByTestId('card').first()).toBeVisible();
    const t1 = Date.now() - t0;
    // v0.1: renderowanie przyrostowe — w DOM bieżąca karta + 40 następnych, reszta czeka w stanie.
    await expect(page.getByTestId('progress')).toHaveText('1 z 100 · znasz 0');
    expect(await page.evaluate(() => window.WM.state.places.length)).toBe(100);
    await expect(page.getByTestId('card')).toHaveCount(41);
    await expect(page.getByTestId('card').first().getByTestId('card-extract')).not.toHaveClass(/is-skeleton/);
    const m = await page.evaluate(() => ({
      nodes: document.getElementById('feed').querySelectorAll('*').length,
      imgsWithSrc: [...document.querySelectorAll('.card-photo')].filter((i) => i.getAttribute('src')).length,
      details: Object.keys(window.WM.state.details).length,
      backdrop: [...document.querySelectorAll('#feed *')].filter((el) => getComputedStyle(el).backdropFilter !== 'none').length,
    }));
    console.log(`[QA ${testInfo.project.name}] 100 kart: ${m.nodes} węzłów w feedzie, obrazów z src: ${m.imgsWithSrc}, szczegółów: ${m.details}, elementów z backdrop-filter: ${m.backdrop}, start→karta ${t1} ms, żądań obrazów ${log.images.length}`);
    expect(m.imgsWithSrc).toBeLessThanOrEqual(4);
    expect(m.details).toBe(4);
    await page.evaluate(() => { for (const p of window.WM.state.places) window.WM.answer(p.pageid, true); });
    // v0.1: po odpowiedzi na wszystko reszta kart dorenderowuje się, widok idzie na kartę pierścienia 1 km;
    // dalsze pierścienie zwracają te same 100 miejsc (duplikaty), więc tuż za nią feed zamyka się kartą końcową.
    await expect(page.getByTestId('ring-card').first()).toBeInViewport({ ratio: 0.5, timeout: 20_000 });
    await expect(page.getByTestId('ring-card').first()).toContainText('Znasz 100% (100 z 100 miejsc)');
    await expect(page.getByTestId('card')).toHaveCount(100);
    await page.getByTestId('end-card').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('end-card')).toBeInViewport({ ratio: 0.5, timeout: 20_000 });
    await expect(page.getByTestId('progress')).toHaveText('100 z 100 · znasz 100');
    const app = await page.locator('#app').boundingBox();
    const cp = await page.getByTestId('change-place').boundingBox();
    const pr = await page.getByTestId('progress').boundingBox();
    console.log(`[QA ${testInfo.project.name}] pasek: licznik ${Math.round(pr.width)} px + „Zmień miejsce” ${Math.round(cp.width)} px w ${Math.round(app.width)} px; prawa krawędź przycisku ${Math.round(cp.x + cp.width)}`);
    await page.screenshot({ path: shot(testInfo, '100-end') });
    expect.soft(cp.x + cp.width, '„Zmień miejsce” nie wystaje poza aplikację').toBeLessThanOrEqual(app.x + app.width + 0.5);
    expect.soft(pr.x + pr.width, 'licznik nie nachodzi na „Zmień miejsce”').toBeLessThanOrEqual(cp.x);
  });

  test('@m360 przeładowanie strony przywraca odpowiedzi po ponownym starcie; brak wpisu historii', async ({ page }) => {
    const log = await startFeed(page);
    const restBefore = log.rest.length;
    const histStart = await page.evaluate(() => history.length);
    await page.evaluate(() => { window.WM.answer(35201, true); window.WM.answer(123, false); });
    await expect(page.getByTestId('progress')).toHaveText('3 z 6 · znasz 1');
    console.log(`[QA] history.length na starcie=${histStart}, w feedzie=${await page.evaluate(() => history.length)} (brak pushState → „wstecz” wychodzi z aplikacji)`);
    await page.reload();
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await page.getByTestId('start-button').click();
    await expect(page.getByTestId('card')).toHaveCount(6);
    await expect(page.getByTestId('card').nth(0)).toHaveAttribute('data-answer', 'true');
    await expect(page.getByTestId('card').nth(1)).toHaveAttribute('data-answer', 'false');
    await expect(page.getByTestId('card').nth(2)).toBeInViewport({ ratio: 0.9 });
    await expect(page.getByTestId('progress')).toHaveText('3 z 6 · znasz 1');
    await expect(page.getByTestId('card').nth(2).getByTestId('card-extract')).not.toHaveClass(/is-skeleton/);
    const after = log.rest.slice(restBefore).map((r) => r.title.replace(/ w Warszawie$/, ''));
    console.log(`[QA] REST po ponownym starcie (2 pierwsze karty już odpowiedziane): ${after.join(' | ')}`);
  });

  test('@desktop klawiatura: chipsy promienia reagują na strzałki', async ({ page }) => {
    await mockWiki(page);
    await page.goto('./');
    let active = null;
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      active = await page.evaluate(() => document.activeElement && (document.activeElement.dataset.testid || document.activeElement.id || document.activeElement.tagName));
      if (active && active.startsWith('radius-chip')) break;
    }
    expect(active).toBe('radius-chip-1000');
    console.log(`[QA] tabIndex chipsów: ${(await page.evaluate(() => [...document.querySelectorAll('.chip')].map((c) => c.tabIndex))).join(',')}`);
    await page.keyboard.press('ArrowRight');
    let after = await page.evaluate(() => ({ active: document.activeElement.dataset.testid, radius: window.WM.state.radius }));
    console.log(`[QA] po ArrowRight: fokus=${after.active}, promień=${after.radius}`);
    await page.keyboard.press('Tab');
    after = await page.evaluate(() => ({ active: document.activeElement.dataset.testid || document.activeElement.id, radius: window.WM.state.radius }));
    console.log(`[QA] po kolejnym Tab: fokus=${after.active}`);
    expect.soft(after.radius === 3000 || after.active === 'radius-chip-3000', 'roving tabindex bez obsługi strzałek: klawiaturą nie da się wybrać innego promienia').toBe(true);
  });

  test('@desktop klawiatura: Enter/Spacja odpowiadają, fokus po odpowiedzi nie wraca na początek', async ({ page }) => {
    await startFeed(page);
    let active = '';
    for (let i = 0; i < 12 && active !== 'btn-known'; i++) {
      await page.keyboard.press('Tab');
      active = await page.evaluate(() => document.activeElement.dataset.testid || document.activeElement.id || document.activeElement.tagName);
    }
    expect(active).toBe('btn-known');
    const ring = await page.evaluate(() => { const el = document.activeElement; const cs = getComputedStyle(el); return { fv: el.matches(':focus-visible'), shadow: cs.boxShadow, outline: cs.outlineStyle }; });
    expect(ring.fv).toBe(true);
    expect(ring.shadow !== 'none' || ring.outline !== 'none', 'widoczny fokus').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('card').first()).toHaveAttribute('data-answer', 'true');
    await expect(page.getByTestId('card').nth(1)).toBeInViewport({ ratio: 0.9 });
    const afterEnter = await page.evaluate(() => { const el = document.activeElement; const card = el.closest('[data-testid="card"]'); return { el: el.dataset.testid || el.id || el.tagName, card: card ? card.dataset.index : null }; });
    await page.keyboard.press('Tab');
    const afterTab = await page.evaluate(() => { const el = document.activeElement; const card = el.closest('[data-testid="card"]'); return { el: el.dataset.testid || el.id || el.tagName, card: card ? card.dataset.index : null, scrollTop: document.getElementById('feed').scrollTop, cardH: document.querySelector('.card').offsetHeight }; });
    console.log(`[QA] po Enter aktywny: ${JSON.stringify(afterEnter)}; po Tab: ${JSON.stringify(afterTab)}`);
    expect(afterTab.scrollTop, 'Tab po odpowiedzi nie powinien cofać feedu na początek').toBeGreaterThanOrEqual(afterTab.cardH - 2);
    expect(Number(afterTab.card), 'fokus po odpowiedzi powinien trafić do następnej karty').toBeGreaterThanOrEqual(1);
    // Spacja na „Nie wiedziałem” drugiej karty
    await page.getByTestId('card').nth(1).getByTestId('btn-unknown').focus();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('card').nth(1)).toHaveAttribute('data-answer', 'false');
  });

  test('@mobile dotyk: pionowe przewijanie nad kartą działa, poziome przesunięcie palcem odpowiada, ukośne nie', async ({ page }) => {
    await startFeed(page);
    const cdp = await page.context().newCDPSession(page);
    const vp = page.viewportSize();
    const sx = Math.round(vp.width / 2);
    const sy = Math.round(vp.height * 0.45);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] });
    for (let i = 1; i <= 15; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx, y: sy - i * 30 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(900);
    const st = await page.evaluate(() => ({ top: document.getElementById('feed').scrollTop, dragging: !!document.querySelector('.card.is-dragging'), answered: document.querySelectorAll('.card.is-answered').length, index: window.WM.state.index }));
    console.log(`[QA] po pionowym geście dotykowym: scrollTop=${st.top}, index=${st.index}, is-dragging=${st.dragging}, odpowiedzi=${st.answered}`);
    expect(st.top).toBeGreaterThan(vp.height * 0.5);
    expect(st.answered).toBe(0);
    expect(st.dragging).toBe(false);

    const card = page.getByTestId('card').nth(st.index);
    const box = await card.boundingBox();
    // Ukośny ruch, głównie pionowy: brak odpowiedzi.
    let x = box.x + box.width * 0.5;
    let y = box.y + box.height * 0.5;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 4, y: y - i * 12 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(600);
    expect(await page.locator('.card.is-answered').count()).toBe(0);
    // Poziomy swipe palcem (150 px w prawo) → „Wiedziałem”.
    const idx = await page.evaluate(() => window.WM.state.index);
    const target = page.getByTestId('card').nth(idx);
    const b2 = await target.boundingBox();
    x = b2.x + b2.width * 0.3;
    y = b2.y + b2.height * 0.4;
    await page.evaluate((idx) => {
      const card = document.querySelectorAll('[data-testid="card"]')[idx];
      window.__log = [];
      for (const t of ['pointerdown', 'pointermove', 'gotpointercapture', 'lostpointercapture', 'pointerup', 'pointercancel']) {
        card.addEventListener(t, (e) => window.__log.push(`${t}@${e.target.className.split(' ')[0]}`), { capture: true, passive: true });
      }
    }, idx);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 12; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 13, y: y + (i % 2) }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(600);
    const diag = await page.evaluate((idx) => ({ answer: document.querySelectorAll('[data-testid="card"]')[idx].dataset.answer || null, moves: window.__log.filter((l) => l.startsWith('pointermove')).length, other: window.__log.filter((l) => !l.startsWith('pointermove')) }), idx);
    console.log(`[QA] poziomy swipe palcem (160 px): ${JSON.stringify(diag)}`);
    expect(diag.moves, 'pointermove docierają do karty').toBeGreaterThan(5);
    await expect(target, 'poziome przesunięcie palcem (touch) powinno odpowiedzieć — działa tylko myszą').toHaveAttribute('data-answer', 'true');
  });
});
