// QA: UX mobilny (360×640, 430×932), strefy bezpieczne, kontrast na jasnym zdjęciu, dostępność, teksty.
import { test, expect, mockWiki, startFeed, makePlaces, answerAllRings, WARSAW, shot, sleep } from './helpers.mjs';

test.describe('QA: UX i dostępność', () => {
  test.use({ geolocation: WARSAW, permissions: ['geolocation'] });

  test('@mobile zrzuty i strefy bezpieczne: start, karta na jasnym zdjęciu, karta końcowa', async ({ page }, testInfo) => {
    await mockWiki(page, { photo: 'white' });
    await page.goto('./');
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
    const known = await first.getByTestId('btn-known').boundingBox();
    const unknown = await first.getByTestId('btn-unknown').boundingBox();
    console.log(`[QA ${testInfo.project.name}] przyciski: „Wiedziałem” ${Math.round(known.width)}×${Math.round(known.height)} do y=${Math.round(known.y + known.height)} / ${vp.height} (wcięcie dolne 34 px)`);
    expect(known.y + known.height, 'przycisk nad strefą gestów systemowych').toBeLessThanOrEqual(vp.height - 34);
    expect(unknown.y + unknown.height).toBeLessThanOrEqual(vp.height - 34);
    expect(known.height).toBeGreaterThanOrEqual(48);
    expect(unknown.height).toBeGreaterThanOrEqual(48);

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
      // --ink-2 = rgba(243,239,230,.74) na tle: przybliżamy jako ink zmieszany z tłem
      return { title: measure('.card-title', [243, 239, 230]), extract: measure('.card-extract', [243, 239, 230]) };
    });
    console.log(`[QA ${testInfo.project.name}] kontrast na białym zdjęciu (szacunek z gradientu, bez text-shadow): ${JSON.stringify(c)}`);
    await page.screenshot({ path: shot(testInfo, 'card-white-photo') });
    expect.soft(c.title.contrast, 'tytuł na jasnym zdjęciu (duży tekst, min 3:1)').toBeGreaterThanOrEqual(3);
    expect.soft(c.extract.contrast, 'opis na jasnym zdjęciu (min 4,5:1)').toBeGreaterThanOrEqual(4.5);

    // v0.1: feed ciągnie się przez pierścienie do 10 km — odpowiadamy na wszystko, aż się zamknie, i wchodzimy na kartę końcową.
    await answerAllRings(page);
    const end = page.getByTestId('end-card');
    await end.scrollIntoViewIfNeeded();
    await expect(end).toBeInViewport({ ratio: 0.9, timeout: 15_000 });
    const ringCard = page.getByTestId('ring-card').first();
    await ringCard.scrollIntoViewIfNeeded();
    await expect(ringCard).toBeInViewport({ ratio: 0.9 });
    const ringShare = await ringCard.getByTestId('ring-share').boundingBox();
    const ringNext = await ringCard.locator('.ring-next').boundingBox();
    console.log(`[QA ${testInfo.project.name}] karta pierścienia z wcięciami: „Udostępnij” do y=${Math.round(ringShare.y + ringShare.height)}, „Dalej” do y=${Math.round(ringNext.y + ringNext.height)} / ${vp.height}`);
    await page.screenshot({ path: shot(testInfo, 'ring-safe-area') });
    expect.soft(ringNext.y + ringNext.height, '„Dalej” na karcie pierścienia nad wcięciem dolnym').toBeLessThanOrEqual(vp.height - 34 + 1);
    await end.scrollIntoViewIfNeeded();
    await expect(end).toBeInViewport({ ratio: 0.9 });
    const again = await end.getByRole('button', { name: 'Jeszcze raz' }).boundingBox();
    const meter = await end.locator('.end-meter').boundingBox();
    const topbar = await page.locator('#topbar').boundingBox();
    console.log(`[QA ${testInfo.project.name}] karta końcowa z wcięciami: miernik y=${Math.round(meter.y)} (pasek do ${Math.round(topbar.y + topbar.height)}), „Jeszcze raz” do y=${Math.round(again.y + again.height)} / ${vp.height}`);
    await page.screenshot({ path: shot(testInfo, 'end-safe-area') });
    expect.soft(again.y + again.height, '„Jeszcze raz” nad wcięciem dolnym').toBeLessThanOrEqual(vp.height - 34 + 1);
    expect.soft(meter.y, 'miernik nie chowa się pod paskiem górnym').toBeGreaterThanOrEqual(topbar.y + topbar.height - 8);
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
      }));
      for (const [k, [sw, cw]] of Object.entries(m)) expect(sw, `${label}: ${k} scrollWidth`).toBeLessThanOrEqual(cw);
    };
    await check('feed');
    const known = await page.getByTestId('card').first().getByTestId('btn-known').boundingBox();
    expect(known.y + known.height).toBeLessThanOrEqual(vp.height);
    // v0.1: pusty pierścień startowy nie daje stanu pustego — jest karta „nic nie ma” i automatyczne dociągnięcie 1 km.
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

  test('@all dostępność: lang, role chipsów, nazwy przycisków, reduced motion, fokus', async ({ page }) => {
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
    await expect(page.getByTestId('card').first().getByRole('link', { name: /^Czytaj w Wikipedii/ })).toHaveAttribute('aria-label', /^Czytaj w Wikipedii: /);
    await expect(page.getByTestId('card').first().getByTestId('card-navigate')).toHaveAttribute('aria-label', /^Nawiguj do: /);
    const landmarks = await page.evaluate(() => ({ feedRole: document.getElementById('feed').getAttribute('role'), main: !!document.querySelector('main'), h1: document.querySelectorAll('h1').length }));
    console.log(`[QA] landmarki: ${JSON.stringify(landmarks)} (aria-label na div bez roli nie jest czytany)`);
    const durations = await page.evaluate(() => ({
      card: getComputedStyle(document.querySelector('.card')).transitionDuration,
      photo: getComputedStyle(document.querySelector('.card-photo')).transitionDuration,
      skeleton: getComputedStyle(document.querySelector('.card-extract')).animationIterationCount,
    }));
    const secs = (v) => (v.endsWith('ms') ? parseFloat(v) / 1000 : parseFloat(v));
    console.log(`[QA] reduced motion: ${JSON.stringify(durations)}`);
    expect(secs(durations.card)).toBeLessThan(0.001);
    expect(secs(durations.photo)).toBeLessThan(0.001);
    await page.getByTestId('card').first().getByTestId('btn-known').click();
    await sleep(350);
    const sc = await page.evaluate(() => ({ top: document.getElementById('feed').scrollTop, h: document.querySelector('.card').offsetHeight }));
    expect(Math.abs(sc.top - sc.h), 'przy reduced motion przewinięcie jest natychmiastowe').toBeLessThan(2);
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => { const el = document.activeElement; const cs = getComputedStyle(el); return { id: el.dataset.testid || el.id || el.className, fv: el.matches(':focus-visible'), shadow: cs.boxShadow, outline: cs.outlineStyle }; });
    console.log(`[QA] fokus po Tab (po kliknięciu „Wiedziałem”): ${JSON.stringify(f)}`);
    expect(f.fv).toBe(true);
    expect(f.shadow !== 'none' || f.outline !== 'none').toBe(true);
  });

  test('@all teksty: polskie formaty, brak angielskiego, liczba mnoga na karcie końcowej', async ({ page }) => {
    await startFeed(page, { places: (radius) => (radius <= 500 ? makePlaces(1, { startId: 7000 }) : radius <= 1000 ? makePlaces(2, { startId: 8000 }) : makePlaces(5, { startId: 9000 })) });
    const fmt = await page.evaluate(() => ({
      d0: window.formatDistance(0), d92: window.formatDistance(92.3), d994: window.formatDistance(994), d995: window.formatDistance(995), d999: window.formatDistance(999.9),
      d1000: window.formatDistance(1000), d1449: window.formatDistance(1449), d9950: window.formatDistance(9950), d12000: window.formatDistance(12000),
      r500: window.formatRadius(500), r1000: window.formatRadius(1000), r5000: window.formatRadius(5000),
    }));
    console.log('[QA] formatDistance/formatRadius: ' + JSON.stringify(fmt));
    expect(fmt.d92).toBe('90 m stąd');
    expect(fmt.d1449).toBe('1,4 km stąd');
    expect(fmt.d12000).toBe('12 km stąd');
    expect(fmt.r500).toBe('500 m');
    expect(fmt.r5000).toBe('5 km');
    expect.soft(fmt.d995, '995–999 m nie powinno dawać „1000 m stąd”').toMatch(/km stąd$/);

    const texts = [];
    const grab = async () => texts.push(await page.evaluate(() => document.body.innerText));
    await grab();
    // v0.1: wynik pierścienia jest na karcie pierścienia, wynik łączny — na karcie końcowej po 10 km.
    // 2 miejsca (1 km): „z 2 miejsc” (pierścień 3 km dociąga się od razu, więc odpowiadamy tylko na miejsca z 1 km)
    await page.evaluate(() => { window.WM.answer(8000, true); window.WM.answer(8001, true); });
    const ring1 = page.locator('[data-testid="ring-card"][data-radius="1000"]');
    await expect(ring1).toBeInViewport({ ratio: 0.9 });
    await expect(ring1).toContainText('Znasz 100% (2 z 2 miejsc)');
    await expect(ring1).toContainText('To wszystko w promieniu 1 km');
    await grab();
    // 1 miejsce (500 m): „z 1 miejsca” (pierścień 1 km dociąga się automatycznie, więc kart przybywa)
    await page.getByTestId('radius-chip-500').click();
    await expect(page.getByTestId('card').first().getByTestId('card-title')).toHaveText('Miejsce 1');
    await page.evaluate(() => window.WM.answer(7000, false));
    const ring500 = page.locator('[data-testid="ring-card"][data-radius="500"]');
    await expect(ring500).toBeInViewport({ ratio: 0.9 });
    await expect(ring500).toContainText('Znasz 0% (0 z 1 miejsca)');
    await expect(ring500).toContainText('Dalej: miejsca 500 m–1 km stąd');
    await grab();
    // 5 miejsc (3 km), 2 znane → 40%; dalsze pierścienie nic nie wnoszą → karta końcowa z tym samym wynikiem łącznym
    await page.getByTestId('radius-chip-3000').click();
    await expect(page.getByTestId('card')).toHaveCount(5);
    await page.evaluate(() => window.WM.state.places.forEach((p, i) => window.WM.answer(p.pageid, i < 2)));
    const ring3 = page.locator('[data-testid="ring-card"][data-radius="3000"]');
    await expect(ring3).toBeInViewport({ ratio: 0.9 });
    await expect(ring3).toContainText('Znasz 40% (2 z 5 miejsc)');
    const end = page.getByTestId('end-card');
    await end.scrollIntoViewIfNeeded();
    await expect(end).toBeInViewport({ ratio: 0.9 });
    await expect(end).toContainText('To wszystko, co Wikipedia zna w promieniu 10 km');
    await expect(end).toContainText('Znasz 40% (2 z 5 miejsc)');
    await grab();
    const all = texts.join('\n');
    expect(all).not.toMatch(/\b(Loading|Error|Retry|Share|Try again|Unknown|Known|Submit|Search|away|Read more|Back)\b/);
    expect(all).not.toMatch(/\d\.\d (km|m)\b/);
    const distances = await page.evaluate(() => [...document.querySelectorAll('[data-testid="card-distance"]')].map((e) => e.textContent.trim()));
    for (const d of distances) expect(d).toMatch(/^(\d+ m|\d+,\d km|\d+ km) stąd$/);
  });
});
