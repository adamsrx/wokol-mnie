// QA: UX mobilny (360×640, 430×932), strefy bezpieczne, kontrast na jasnym zdjęciu, dostępność, teksty (v0.2).
import { test, expect, mockWiki, startFeed, scrollToEnd, cardFor, makePlaces, WARSAW, shot, sleep } from './helpers.mjs';

test.describe('QA: UX i dostępność', () => {
  test.use({ geolocation: WARSAW, permissions: ['geolocation'] });

  test('@mobile zrzuty i strefy bezpieczne: start, karta na jasnym zdjęciu, karta pierścienia, panel, karta końcowa', async ({ page }, testInfo) => {
    await mockWiki(page, { photo: 'white' });
    await page.goto('./');
    await page.evaluate(() => { window.WM.rng.next = () => 0.9999; });
    const vp = page.viewportSize();
    const startBtn = await page.getByTestId('start-button').boundingBox();
    expect(startBtn.y + startBtn.height).toBeLessThanOrEqual(vp.height);
    await page.screenshot({ path: shot(testInfo, 'start') });
    // Symulacja wcięć iPhone'a (47 px góra / 34 px dół): env() nie da się wymusić w Chromium, nadpisujemy tokeny.
    await page.addStyleTag({ content: ':root{--safe-top:47px;--safe-bottom:34px}' });
    await page.getByTestId('start-button').click();
    const first = page.getByTestId('card').first();
    await expect(first.locator('.card-photo')).toHaveClass(/is-loaded/);
    await expect(first.getByTestId('card-extract')).not.toHaveClass(/is-skeleton/);
    const like = await first.getByTestId('btn-like').boundingBox();
    const save = await first.getByTestId('btn-save').boundingBox();
    console.log(`[QA ${testInfo.project.name}] przyciski: „Lubię” ${Math.round(like.width)}×${Math.round(like.height)} do y=${Math.round(like.y + like.height)} / ${vp.height} (wcięcie dolne 34 px)`);
    expect(like.y + like.height, 'przycisk nad strefą gestów systemowych').toBeLessThanOrEqual(vp.height - 34);
    expect(save.y + save.height).toBeLessThanOrEqual(vp.height - 34);
    expect(like.height).toBeGreaterThanOrEqual(48);
    expect(save.height).toBeGreaterThanOrEqual(48);

    // Szacunek kontrastu na niemal białym zdjęciu (#f6f5f0): alfa gradientu .card-shade przy górnej krawędzi tekstu.
    const c = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="card"]');
      const cr = card.getBoundingClientRect();
      const stops = [[0, .97], [20, .9], [42, .6], [62, .15], [78, 0], [100, 0]];
      const alphaAt = (pct) => { for (let i = 1; i < stops.length; i++) { const [p0, a0] = stops[i - 1]; const [p1, a1] = stops[i]; if (pct <= p1) return a0 + (a1 - a0) * (pct - p0) / (p1 - p0); } return 0; };
      const lin = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
      const lum = (r, g, b) => .2126 * lin(r) + .7152 * lin(g) + .0722 * lin(b);
      const measure = (sel, ink) => {
        const r = card.querySelector(sel).getBoundingClientRect();
        const topPct = ((cr.bottom - r.top) / cr.height) * 100;
        const a = alphaAt(topPct);
        const bg = [11, 15, 14].map((s, i) => a * s + (1 - a) * [246, 245, 240][i]);
        const L = lum(...bg);
        const inkL = lum(...ink);
        return { sel, topFromBottomPct: +topPct.toFixed(1), shadeAlpha: +a.toFixed(2), contrast: +((inkL + .05) / (L + .05)).toFixed(2) };
      };
      return { title: measure('.card-title', [243, 239, 230]), extract: measure('.card-extract', [243, 239, 230]) };
    });
    console.log(`[QA ${testInfo.project.name}] kontrast na białym zdjęciu (szacunek z gradientu, bez text-shadow): ${JSON.stringify(c)}`);
    await page.screenshot({ path: shot(testInfo, 'card-white-photo') });
    expect.soft(c.title.contrast, 'tytuł na jasnym zdjęciu (duży tekst, min 3:1)').toBeGreaterThanOrEqual(3);
    expect.soft(c.extract.contrast, 'opis na jasnym zdjęciu (min 4,5:1)').toBeGreaterThanOrEqual(4.5);

    // Polubienie i zapis → karta pierścienia z paskiem polubionych, panel „Moje miejsca”.
    await first.getByTestId('btn-like').click();
    await first.getByTestId('btn-save').click();
    await page.evaluate(() => window.WM.like(123));
    await page.getByTestId('my-places').click();
    const panel = page.getByTestId('my-places-panel');
    await expect(panel).toBeVisible();
    await panel.locator('.panel').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));   // wjazd panelu
    const row = await page.getByTestId('saved-row').first().boundingBox();
    const close = await page.getByTestId('panel-close').boundingBox();
    const topbar = await page.locator('#topbar').boundingBox();
    console.log(`[QA ${testInfo.project.name}] panel: wiersz y=${Math.round(row.y)}–${Math.round(row.y + row.height)}, „Zamknij” ${Math.round(close.width)}×${Math.round(close.height)} / ${vp.height}`);
    expect(row.y + row.height, 'wiersz panelu nad wcięciem dolnym').toBeLessThanOrEqual(vp.height - 34 + 1);
    expect(close.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: shot(testInfo, 'my-places') });
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    await scrollToEnd(page);
    const ringCard = page.getByTestId('ring-card').first();
    await ringCard.scrollIntoViewIfNeeded();
    await expect(ringCard).toBeInViewport({ ratio: 0.9 });
    await expect(ringCard.locator('.liked-thumb')).toHaveCount(2);
    const ringShare = await ringCard.getByTestId('ring-share').boundingBox();
    const ringNext = await ringCard.locator('.ring-next').boundingBox();
    const strip = await ringCard.locator('.liked-strip').boundingBox();
    console.log(`[QA ${testInfo.project.name}] karta pierścienia z wcięciami: pasek polubionych y=${Math.round(strip.y)} (pasek górny do ${Math.round(topbar.y + topbar.height)}), „Udostępnij” do y=${Math.round(ringShare.y + ringShare.height)}, „Dalej” do y=${Math.round(ringNext.y + ringNext.height)} / ${vp.height}`);
    await page.screenshot({ path: shot(testInfo, 'ring-safe-area') });
    expect.soft(strip.y, 'pasek polubionych nie chowa się pod paskiem górnym').toBeGreaterThanOrEqual(topbar.y + topbar.height - 8);
    expect.soft(ringNext.y + ringNext.height, '„Dalej” na karcie pierścienia nad wcięciem dolnym').toBeLessThanOrEqual(vp.height - 34 + 1);

    const end = page.getByTestId('end-card');
    await end.scrollIntoViewIfNeeded();
    await expect(end).toBeInViewport({ ratio: 0.9 });
    const restart = await end.getByRole('button', { name: 'Od nowa' }).boundingBox();
    const endStrip = await end.locator('.liked-strip').boundingBox();
    console.log(`[QA ${testInfo.project.name}] karta końcowa z wcięciami: pasek polubionych y=${Math.round(endStrip.y)}, „Od nowa” do y=${Math.round(restart.y + restart.height)} / ${vp.height}`);
    await page.screenshot({ path: shot(testInfo, 'end-safe-area') });
    expect.soft(restart.y + restart.height, '„Od nowa” nad wcięciem dolnym').toBeLessThanOrEqual(vp.height - 34 + 1);
    expect.soft(endStrip.y, 'pasek polubionych nie chowa się pod paskiem górnym').toBeGreaterThanOrEqual(topbar.y + topbar.height - 8);
  });

  test('@mobile bez poziomego przewijania i z widocznymi przyciskami na każdym ekranie (bez wcięć)', async ({ page }, testInfo) => {
    await startFeed(page);
    const vp = page.viewportSize();
    const check = async (label) => {
      const m = await page.evaluate(() => ({
        doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
        app: [document.getElementById('app').scrollWidth, document.getElementById('app').clientWidth],
        feed: [document.getElementById('feed').scrollWidth, document.getElementById('feed').clientWidth],
        topbar: [document.getElementById('topbar').scrollWidth, document.getElementById('topbar').clientWidth],
        panel: [document.getElementById('my-places-panel').scrollWidth, document.getElementById('my-places-panel').clientWidth],
      }));
      for (const [k, [sw, cw]] of Object.entries(m)) expect(sw, `${label}: ${k} scrollWidth`).toBeLessThanOrEqual(cw);
    };
    await check('feed');
    const like = await page.getByTestId('card').first().getByTestId('btn-like').boundingBox();
    expect(like.y + like.height).toBeLessThanOrEqual(vp.height);
    // Panel z długim tytułem.
    await page.evaluate(() => { window.WM.save(48803); window.WM.save(35201); });
    await page.getByTestId('my-places').click();
    await expect(page.getByTestId('saved-row')).toHaveCount(2);
    await check('panel');
    const remove = await page.getByTestId('saved-remove').first().boundingBox();
    expect(remove.x + remove.width).toBeLessThanOrEqual(vp.width + 0.5);
    await page.keyboard.press('Escape');
    // Pusty pierścień startowy nie daje stanu pustego — jest karta „nic nie ma” i automatyczne dociągnięcie 1 km.
    await page.getByTestId('radius-chip-500').click();
    const ring = page.getByTestId('ring-card').first();
    await expect(ring).toBeVisible();
    await expect(ring).toContainText('W promieniu 500 m nic nie ma');
    await expect(page.getByTestId('empty-state')).toBeHidden();
    await check('ring');
    await page.screenshot({ path: shot(testInfo, 'empty-ring') });
    await page.getByTestId('change-place').click();
    await page.locator('#place-toggle').click();
    await check('start+form');
    await page.screenshot({ path: shot(testInfo, 'start-form') });
  });

  test('@all dostępność: lang, role chipsów, nazwy przycisków, aria-pressed, dialog, reduced motion, fokus', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await startFeed(page);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('pl');
    const chips = page.locator('.chips');
    await expect(chips).toHaveAttribute('role', 'radiogroup');
    await expect(chips).toHaveAttribute('aria-label', 'Promień');
    await expect(page.locator('.chip')).toHaveCount(5);
    for (const r of [500, 1000, 3000, 5000, 10000]) await expect(page.getByTestId(`radius-chip-${r}`)).toHaveAttribute('role', 'radio');
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => !(b.getAttribute('aria-label') || b.textContent.trim())).map((b) => b.outerHTML.slice(0, 80)));
    expect(unnamed).toEqual([]);
    const first = page.getByTestId('card').first();
    await expect(first.getByRole('link', { name: /^Czytaj w Wikipedii/ })).toHaveAttribute('aria-label', /^Czytaj w Wikipedii: /);
    await expect(first.getByTestId('card-navigate')).toHaveAttribute('aria-label', /^Nawiguj do: /);
    await expect(first.getByTestId('btn-like')).toHaveAttribute('aria-pressed', 'false');
    await expect(first.getByTestId('btn-save')).toHaveAttribute('aria-pressed', 'false');
    const landmarks = await page.evaluate(() => ({ feedRole: document.getElementById('feed').getAttribute('role'), main: !!document.querySelector('main'), h1: document.querySelectorAll('h1').length }));
    console.log(`[QA] landmarki: ${JSON.stringify(landmarks)}`);
    const durations = await page.evaluate(() => ({
      card: getComputedStyle(document.querySelector('.card')).transitionDuration,
      photo: getComputedStyle(document.querySelector('.card-photo')).transitionDuration,
      skeleton: getComputedStyle(document.querySelector('.card-extract')).animationIterationCount,
    }));
    const secs = (v) => (v.endsWith('ms') ? parseFloat(v) / 1000 : parseFloat(v));
    console.log(`[QA] reduced motion: ${JSON.stringify(durations)}`);
    expect(secs(durations.card)).toBeLessThan(0.001);
    expect(secs(durations.photo)).toBeLessThan(0.001);
    // Polubienie z klawiatury/klikiem nie przewija; serce po podwójnym stuknięciu bez animacji, ale widoczne.
    await first.getByTestId('btn-like').click();
    await sleep(350);
    expect(await page.evaluate(() => document.getElementById('feed').scrollTop)).toBe(0);
    const box = await first.boundingBox();
    await first.dblclick({ position: { x: box.width / 2, y: box.height * 0.3 } });
    const readHeart = () => page.evaluate(() => { const h = document.querySelector('.card.is-burst .card-heart'); if (!h) return null; const cs = getComputedStyle(h); return { animation: cs.animationName, opacity: cs.opacity }; });
    await expect.poll(readHeart, { timeout: 600, intervals: [20, 50, 100] }).toEqual({ animation: 'none', opacity: '1' });
    console.log(`[QA] serce przy reduced motion: ${JSON.stringify(await readHeart())}`);
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => { const el = document.activeElement; const cs = getComputedStyle(el); return { id: el.dataset.testid || el.id || el.className, fv: el.matches(':focus-visible'), shadow: cs.boxShadow, outline: cs.outlineStyle }; });
    console.log(`[QA] fokus po Tab (po kliknięciu „Lubię”): ${JSON.stringify(f)}`);
    expect(f.fv).toBe(true);
    expect(f.shadow !== 'none' || f.outline !== 'none').toBe(true);
    // Panel: dialog z nazwą, aria-modal, przycisk zamknięcia z nazwą, fokus wewnątrz.
    await page.getByTestId('my-places').click();
    const panel = page.getByTestId('my-places-panel');
    await expect(panel).toHaveAttribute('role', 'dialog');
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    await expect(panel).toHaveAccessibleName('Moje miejsca');
    await expect(page.getByTestId('panel-close')).toHaveAccessibleName('Zamknij');
    await expect(page.getByTestId('panel-close')).toBeFocused();
    await expect(page.getByTestId('my-places')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('my-places-empty')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.getByTestId('my-places')).toBeFocused();
  });

  test('@all teksty: polskie formaty, brak angielskiego, liczba mnoga na kartach pierścienia i końcowej', async ({ page }) => {
    await startFeed(page, { places: (radius) => (radius <= 500 ? makePlaces(1, { startId: 7000 }) : radius <= 1000 ? makePlaces(2, { startId: 8000 }) : makePlaces(5, { startId: 9000 })) });
    const fmt = await page.evaluate(() => ({
      d0: window.formatDistance(0), d92: window.formatDistance(92.3), d994: window.formatDistance(994), d995: window.formatDistance(995), d999: window.formatDistance(999.9),
      d1000: window.formatDistance(1000), d1449: window.formatDistance(1449), d9950: window.formatDistance(9950), d12000: window.formatDistance(12000),
      r500: window.formatRadius(500), r1000: window.formatRadius(1000), r5000: window.formatRadius(5000),
      p1: window.pluralPlaces(1), p2: window.pluralPlaces(2), p5: window.pluralPlaces(5), p12: window.pluralPlaces(12), p22: window.pluralPlaces(22), p25: window.pluralPlaces(25),
    }));
    console.log('[QA] formatDistance/formatRadius/pluralPlaces: ' + JSON.stringify(fmt));
    expect(fmt.d92).toBe('90 m stąd');
    expect(fmt.d1449).toBe('1,4 km stąd');
    expect(fmt.d12000).toBe('12 km stąd');
    expect(fmt.r500).toBe('500 m');
    expect(fmt.r5000).toBe('5 km');
    expect.soft(fmt.d995, '995–999 m nie powinno dawać „1000 m stąd”').toMatch(/km stąd$/);
    expect([fmt.p1, fmt.p2, fmt.p5, fmt.p12, fmt.p22, fmt.p25]).toEqual(['miejsce', 'miejsca', 'miejsc', 'miejsc', 'miejsca', 'miejsc']);

    const texts = [];
    const grab = async () => texts.push(await page.evaluate(() => document.body.innerText));
    await grab();
    // 2 miejsca (1 km), oba polubione, jedno zapisane: „Przejrzałeś 2 miejsca, polubiłeś 2, zapisałeś 1”
    await page.evaluate(() => { window.WM.like(8000); window.WM.like(8001); window.WM.save(8001); });
    const ring1 = page.locator('[data-testid="ring-card"][data-radius="1000"]');
    await ring1.scrollIntoViewIfNeeded();
    await expect(ring1).toBeInViewport({ ratio: 0.9 });
    await expect(ring1).toContainText('To wszystko w promieniu 1 km');
    await expect(ring1).toContainText('Przejrzałeś 2 miejsca, polubiłeś 2, zapisałeś 1');
    await expect(ring1.locator('.liked-thumb')).toHaveCount(2);
    await grab();
    // 1 miejsce (500 m), bez polubień: „Przejrzałeś 1 miejsce, polubiłeś 0” (pierścień 1 km dociąga się automatycznie)
    await page.getByTestId('radius-chip-500').click();
    await expect(page.getByTestId('card').first().getByTestId('card-title')).toHaveText('Miejsce 1');
    const ring500 = page.locator('[data-testid="ring-card"][data-radius="500"]');
    await ring500.scrollIntoViewIfNeeded();
    await expect(ring500).toBeInViewport({ ratio: 0.9 });
    await expect(ring500).toContainText('Przejrzałeś 1 miejsce, polubiłeś 0');
    await expect(ring500).not.toContainText('zapisałeś');
    await expect(ring500).toContainText('Dalej: miejsca 500 m–1 km stąd');
    await grab();
    // 5 miejsc (3 km), 2 polubione; dalsze pierścienie nic nie wnoszą → karta końcowa z tą samą linią łączną
    await page.getByTestId('radius-chip-3000').click();
    await expect(page.getByTestId('card')).toHaveCount(5);
    await page.evaluate(() => { window.WM.like(9000); window.WM.like(9004); });
    await scrollToEnd(page);
    const ring3 = page.locator('[data-testid="ring-card"][data-radius="3000"]');
    await expect(ring3).toContainText('Przejrzałeś 5 miejsc, polubiłeś 2');
    const end = page.getByTestId('end-card');
    await expect(end).toBeInViewport({ ratio: 0.9 });
    await expect(end).toContainText('To wszystko, co Wikipedia zna w promieniu 10 km');
    await expect(end).toContainText('Przejrzałeś 5 miejsc, polubiłeś 2');
    await expect(end).not.toContainText('zapisałeś');
    await grab();
    await page.getByTestId('my-places').click();
    await grab();
    const all = texts.join('\n');
    expect(all).not.toMatch(/\b(Loading|Error|Retry|Share|Try again|Like|Liked|Save|Saved|Skip|Next|Submit|Search|away|Read more|Back|Remove|Close)\b/);
    expect(all).not.toMatch(/\d\.\d (km|m)\b/);
    expect(all).not.toMatch(/Wiedział|Znasz|\d+ z \d+ ·/);
    const distances = await page.evaluate(() => [...document.querySelectorAll('[data-testid="card-distance"], .saved-distance')].map((e) => e.textContent.trim()));
    for (const d of distances) expect(d).toMatch(/^(\d+ m|\d+,\d km|\d+ km) stąd$/);
  });
});
