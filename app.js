/* Wokół mnie — v0.1 „nieskończony feed”. Czysty JS (ES2020), bez zależności. */
'use strict';

const WIKI_BASE = 'https://pl.wikipedia.org';

const RADII = [500, 1000, 3000, 5000, 10000];   // pierścienie; 10 000 m to maksimum geosearch
const DEFAULT_RADIUS = 1000;
const PREFETCH_AHEAD = 3;          // szczegóły pobierane dla bieżącej karty i 3 następnych
const RENDER_AHEAD = 40;           // tyle kart renderujemy z wyprzedzeniem przed bieżącą (reszta czeka w stanie)
const RING_LOOKAHEAD = 3;          // następny pierścień dociągamy, gdy do końca listy zostają ≤ 2 karty
const SWIPE_THRESHOLD = 80;        // px przesunięcia poziomego, które liczy się jako odpowiedź
const SWIPE_LOCK = 10;             // px, po których decydujemy: gest poziomy czy pionowy
const ADVANCE_DELAY = 250;         // ms od odpowiedzi do przewinięcia na następną kartę
const FETCH_TIMEOUT = 12000;
const MAX_AUTO_ATTEMPTS = 2;       // pobranie + jedna automatyczna ponowna próba; dalej tylko „Spróbuj ponownie”
const STORAGE_RADIUS = 'wm.radius';
const STORAGE_ANSWERS = 'wm.answers';

const state = {
  screen: 'start',   // start | loading | feed | empty | error
  center: null,      // { lat, lon, label }
  radius: DEFAULT_RADIUS, // pierścień startowy (chip)
  rings: [],         // [{ radius, index, status: 'loading'|'ready'|'error', places, isStart, error }] w kolejności ładowania
  ringIndex: -1,     // indeks w RADII ostatnio zamówionego pierścienia
  feedDone: false,   // true po ostatnim pierścieniu (10 km)
  places: [],        // wszystkie załadowane miejsca w kolejności feedu (w obrębie pierścienia: kolejność z API)
  items: [],         // elementy feedu: { type: 'place', place, ordinal, ring } | { type: 'ring', ring }
  details: {},       // pageid -> { status: 'loading'|'ready'|'error', extract, image, thumb, url }
  answers: {},       // pageid -> true|false dla załadowanych miejsc
  index: 0,          // indeks elementu feedu w widoku (items.length = karta ogona: ładowanie / koniec)
  error: null,
};

/* ---------- Drobne narzędzia ---------- */

const $ = (id) => document.getElementById(id);
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function storageGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* tryb prywatny, brak miejsca — ignorujemy */ }
}

/* Odległość po polsku: do 1 km w metrach zaokrąglonych do 10 m, dalej w km z jedną cyfrą
   po przecinku dziesiętnym („320 m stąd”, „1,4 km stąd”). */
function formatDistance(meters) {
  const m = Math.max(0, Number(meters) || 0);
  const tens = Math.round(m / 10) * 10;          // najpierw zaokrąglenie, potem wybór jednostki (995 m → 1,0 km)
  if (tens < 1000) return `${Math.max(10, tens)} m stąd`;
  const km = Math.round(m / 100) / 10;
  if (km < 10) return `${km.toFixed(1).replace('.', ',')} km stąd`;
  return `${Math.round(m / 1000)} km stąd`;
}

function formatRadius(meters) {
  return meters < 1000 ? `${meters} m` : `${meters / 1000} km`;
}

/* Zakres między pierścieniami: „500 m–1 km”, „1–3 km”. */
function formatRange(from, to) {
  if (from >= 1000 && to >= 1000) return `${from / 1000}–${to / 1000} km`;
  return `${formatRadius(from)}–${formatRadius(to)}`;
}

/* Liczba mnoga: 1 miejsce, 2 miejsca, 5 miejsc, 22 miejsca (mianownik) oraz „z 1 miejsca”, „z 5 miejsc” (dopełniacz). */
function pluralPlaces(n) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n === 1) return 'miejsce';
  if (n10 >= 2 && n10 <= 4 && !(n100 >= 12 && n100 <= 14)) return 'miejsca';
  return 'miejsc';
}
function placesGenitive(n) {
  return n === 1 ? 'miejsca' : 'miejsc';
}

/* Skróty, po których kropka nie kończy zdania (porównywane małymi literami, bez końcowej kropki).
   „r.” i „w.” celowo nie są na liście: „w 1939 r. Następne zdanie” to w praktyce zawsze koniec zdania. */
const ABBREVIATIONS = new Set(['św', 'ul', 'pl', 'al', 'ok', 'im', 'ks', 'np', 'tzw', 'woj', 'pow', 'gm', 'gen', 'prof', 'dr',
  'inż', 'hab', 'mgr', 'wg', 'm.in', 'n.e', 'p.n.e', 'nr', 'tj', 'tzn', 'ur', 'zm', 'bp', 'abp', 'kard', 'płk', 'ppłk', 'mjr',
  'kpt', 'por', 'godz', 'os', 'ob', 'proj', 'arch', 'ok', 'ca', 'śp', 'bł', 'oo', 'ss', 'br', 'ks', 'o', 'pw', 'rz', 'ryc']);

/* Dzieli tekst na zdania. Granica: .!?… (+ ewentualny cudzysłów/nawias) + odstęp + wielka litera, cyfra lub otwierający
   cudzysłów. Kropka po skrócie z listy, po inicjale („J. Piłsudskiego”) albo po liczbie porządkowej nie jest granicą. */
function splitSentences(text) {
  const boundary = /[.!?…]+["”»)]*\s+(?=["„(]?[A-ZĄĆĘŁŃÓŚŹŻ0-9])/g;
  const sentences = [];
  let last = 0;
  let match;
  while ((match = boundary.exec(text)) !== null) {
    if (match[0].startsWith('.')) {
      const word = ((text.slice(last, match.index).match(/(\S+)$/) || [])[1] || '').replace(/^[(„"«]+/, '');
      const lower = word.toLowerCase();
      const isAbbreviation = ABBREVIATIONS.has(lower)
        || /^[A-ZĄĆĘŁŃÓŚŹŻ]$/.test(word)                       // inicjał
        || /^\d+$/.test(word)                                   // liczebnik porządkowy („12. miejsce”)
        || /^[a-ząćęłńóśźż]{1,3}(\.[a-ząćęłńóśźż]{1,3})+$/.test(lower); // m.in, n.e, p.n.e i podobne
      if (isAbbreviation) continue;
    }
    sentences.push(text.slice(last, match.index + match[0].trimEnd().length));
    last = match.index + match[0].length;
  }
  if (last < text.length) sentences.push(text.slice(last));
  return sentences;
}

/* Skraca ekstrakt do 3 zdań i ~280 znaków, kończąc na granicy słowa wielokropkiem. */
function truncateExtract(text, maxSentences = 3, maxChars = 280) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const sentences = splitSentences(t);
  if (sentences.length > maxSentences) t = sentences.slice(0, maxSentences).join(' ');
  if (t.length > maxChars) {
    const cut = t.lastIndexOf(' ', maxChars - 1);
    t = t.slice(0, cut > maxChars / 2 ? cut : maxChars - 1).replace(/[\s,;:–-]+$/, '') + '…';
  }
  return t;
}

/* Deterministyczny odcień (0–359) z tytułu — kolor placeholdera. */
function hueFromTitle(title) {
  let h = 0;
  for (const ch of String(title)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

/* Miniaturka z REST ma ~320 px; dla pełnoekranowej karty podmieniamy rozmiar w URL-u Commons
   (…/thumb/…/320px-Plik.jpg → 1000px), chyba że oryginał jest mniejszy — wtedy bierzemy oryginał. */
function pickImage(thumbnail, original) {
  if (!thumbnail || !thumbnail.source) return original && original.source ? original.source : null;
  if (original && original.width && original.width <= 1000) return original.source;
  if (thumbnail.width && thumbnail.width >= 1000) return thumbnail.source;
  // Tylko ostatni segment ścieżki (nazwa pliku), żeby nie trafić w katalog o nazwie „300px-…”;
  // miniatury PDF/TIFF („page1-320px-…”, „lossy-page1-…”) zostają bez zmian.
  return thumbnail.source.replace(/\/(\d+)px-([^/]+)$/, '/1000px-$2');
}

function encodeTitle(title) {
  return encodeURIComponent(String(title).replace(/ /g, '_'));
}

/* Trasa pieszą do miejsca w Mapach Google; współrzędne z kropką dziesiętną, 5 miejsc (~1 m). */
function navigateUrl(lat, lon) {
  return `https://www.google.com/maps/dir/?api=1&destination=${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}&travelmode=walking`;
}

function apiUrl(params) {
  const search = new URLSearchParams({ ...params, format: 'json', formatversion: '2', origin: '*' });
  return `${WIKI_BASE}/w/api.php?${search.toString()}`;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    if (data && data.error) {
      // Action API zgłasza błędy (maxlag, badvalue…) w ciele odpowiedzi 200.
      const err = new Error(data.error.info || data.error.code || 'Błąd API');
      err.apiCode = data.error.code || 'unknown';
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function describeError(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'Brak połączenia z internetem. Połącz się z siecią i spróbuj ponownie.';
  }
  if (err && err.name === 'AbortError') {
    return 'Wikipedia nie odpowiada. Sprawdź połączenie i spróbuj ponownie.';
  }
  if (err && err.status) {
    return `Wikipedia odpowiedziała błędem (${err.status}). Odczekaj chwilę i spróbuj ponownie.`;
  }
  if (err && err.apiCode) {
    return `Wikipedia zgłosiła błąd (${err.apiCode}). Odczekaj chwilę i spróbuj ponownie.`;
  }
  return 'Nie udało się połączyć z Wikipedią. Sprawdź połączenie z internetem i spróbuj ponownie.';
}

/* ---------- Wikipedia ---------- */

async function geosearch(lat, lon, radiusM, limit = 100) {
  const data = await fetchJson(apiUrl({
    action: 'query',
    list: 'geosearch',
    gscoord: `${lat}|${lon}`,
    gsradius: String(Math.min(10000, Math.max(10, Math.round(radiusM)))),
    gslimit: String(Math.min(500, Math.max(1, Math.round(limit)))),
    gsnamespace: '0',
  }));
  const list = (data && data.query && data.query.geosearch) || [];
  return list.filter((p) => p && p.pageid && p.title);
}

async function fetchDetails(place) {
  const fallbackUrl = `${WIKI_BASE}/wiki/${encodeTitle(place.title)}`;
  try {
    const s = await fetchJson(`${WIKI_BASE}/api/rest_v1/page/summary/${encodeTitle(place.title)}`);
    return {
      extract: truncateExtract(s.extract),
      image: pickImage(s.thumbnail, s.originalimage),
      thumb: s.thumbnail ? s.thumbnail.source : null,
      url: (s.content_urls && ((s.content_urls.mobile && s.content_urls.mobile.page) || (s.content_urls.desktop && s.content_urls.desktop.page))) || fallbackUrl,
      // Współrzędne z REST są dokładniejsze niż te z geosearch (dla „Nawiguj”); gdy ich nie ma, zostają te z listy.
      coords: s.coordinates && typeof s.coordinates.lat === 'number' && typeof s.coordinates.lon === 'number'
        ? { lat: s.coordinates.lat, lon: s.coordinates.lon } : null,
    };
  } catch {
    // REST zawiódł — klasyczne API: ekstrakt + miniatura 1000 px.
    const data = await fetchJson(apiUrl({
      action: 'query',
      prop: 'extracts|pageimages',
      exintro: '1',
      explaintext: '1',
      exlimit: '1',
      exsentences: '3',
      piprop: 'thumbnail',
      pithumbsize: '1000',
      pageids: String(place.pageid),
    }));
    const page = data && data.query && data.query.pages && data.query.pages[0];
    if (!page) throw new Error('Brak strony w odpowiedzi');
    return {
      extract: truncateExtract(page.extract),
      image: page.thumbnail ? page.thumbnail.source : null,
      thumb: null,
      url: fallbackUrl,
      coords: null,
    };
  }
}

/* Wyszukiwanie miejsca po nazwie: pierwsza strona (w kolejności trafności) ze współrzędnymi. */
async function searchPlace(query) {
  const data = await fetchJson(apiUrl({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: '5',
    prop: 'coordinates',
  }));
  const pages = ((data && data.query && data.query.pages) || [])
    .slice()
    .sort((a, b) => (a.index || 0) - (b.index || 0));
  for (const page of pages) {
    const c = Array.isArray(page.coordinates)
      ? page.coordinates.find((x) => x && typeof x.lat === 'number' && typeof x.lon === 'number' && (!x.globe || x.globe === 'earth'))
      : null;
    if (c) return { lat: c.lat, lon: c.lon, title: page.title };
  }
  return null;
}

/* ---------- Elementy DOM ---------- */

const els = {};
let chipsEl = null;
let observer = null;
let loadToken = 0;
let locateToken = 0;
let historyPushed = false;   // wpis historii dla widoku „wokół”, żeby „wstecz” wracało na start
let lastAction = null;
let toastTimer = 0;
const cardsById = new Map();
let renderedCount = 0;       // ile elementów feedu (items) ma już kartę w DOM
let tailEl = null;           // karta ogona: ładowanie pierścienia / błąd pierścienia / karta końcowa
let tailKind = null;         // 'loading' | 'error' | 'end' | null

function cacheElements() {
  ['app', 'start-screen', 'around-screen', 'topbar', 'progress', 'change-place', 'loading-state', 'empty-state',
    'empty-text', 'error-state', 'error-text', 'retry-button', 'feed', 'start-button', 'geo-message', 'place-toggle',
    'place-form', 'place-input', 'place-submit', 'place-message', 'start-chips-slot', 'bar-chips-slot',
    'empty-chips-slot', 'toast', 'card-template', 'ring-template', 'tail-template', 'end-template'].forEach((id) => { els[id] = $(id); });
}

/* ---------- Chipsy promienia (pierścień startowy) ---------- */

function buildChips() {
  chipsEl = document.createElement('div');
  chipsEl.className = 'chips';
  chipsEl.setAttribute('role', 'radiogroup');
  chipsEl.setAttribute('aria-label', 'Promień');
  RADII.forEach((r) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('role', 'radio');
    b.dataset.testid = `radius-chip-${r}`;
    b.dataset.radius = String(r);
    b.textContent = formatRadius(r);
    b.addEventListener('click', () => setRadius(r, { reload: true }));
    chipsEl.appendChild(b);
  });
  // Klawiatura: strzałki / Home / End przenoszą fokus i od razu wybierają promień (wzorzec radiogroup).
  chipsEl.addEventListener('keydown', (e) => {
    const i = RADII.indexOf(state.radius);
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = RADII[(i + 1) % RADII.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = RADII[(i - 1 + RADII.length) % RADII.length];
    else if (e.key === 'Home') next = RADII[0];
    else if (e.key === 'End') next = RADII[RADII.length - 1];
    if (next === null) return;
    e.preventDefault();
    setRadius(next, { reload: true });
    const chip = chipsEl.querySelector(`[data-radius="${next}"]`);
    if (chip) chip.focus();
  });
  syncChips();
}

function syncChips() {
  if (!chipsEl) return;
  chipsEl.querySelectorAll('.chip').forEach((b) => {
    const on = Number(b.dataset.radius) === state.radius;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
}

function placeChips(slotId) {
  const slot = els[slotId];
  if (slot && chipsEl.parentElement !== slot) slot.appendChild(chipsEl);
}

function setRadius(r, { reload = false } = {}) {
  if (!RADII.includes(r)) return;
  const changed = r !== state.radius;
  state.radius = r;
  storageSet(STORAGE_RADIUS, r);
  syncChips();
  if (reload && changed && state.center && state.screen !== 'start') {
    loadAround(state.center.lat, state.center.lon, r, state.center.label);
  } else if (reload && !changed && state.screen === 'empty' && state.center) {
    loadAround(state.center.lat, state.center.lon, r, state.center.label);
  }
}

/* ---------- Render ekranów ---------- */

function render() {
  const s = state.screen;
  els['start-screen'].hidden = s !== 'start';
  els['around-screen'].hidden = s === 'start';
  els['loading-state'].hidden = s !== 'loading';
  els['empty-state'].hidden = s !== 'empty';
  els['error-state'].hidden = s !== 'error';
  els.feed.hidden = s !== 'feed';

  if (s === 'start') placeChips('start-chips-slot');
  else if (s === 'empty') placeChips('empty-chips-slot');
  else placeChips('bar-chips-slot');

  if (s === 'empty') {
    els['empty-text'].textContent = `Wikipedia nie zna żadnego miejsca w promieniu ${formatRadius(RADII[RADII.length - 1])} od tego punktu. Zmień miejsce.`;
  }
  if (s === 'error') {
    els['error-text'].textContent = state.error || describeError(null);
  }
  if (s !== 'feed') els.progress.textContent = '';
  if (s === 'start') {
    clearFeed();
    const btn = els['start-button'];
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Pokaż, co jest wokół';
  }
}

function clearFeed() {
  if (observer) { observer.disconnect(); observer = null; }
  cardsById.clear();
  els.feed.replaceChildren();
  els.feed.removeAttribute('aria-busy');
  renderedCount = 0;
  tailEl = null;
  tailKind = null;
}

/* ---------- Ładowanie: pierścienie ----------
   Pierścień = jedno zapytanie geosearch dla promienia z RADII. Pierwszy to chip użytkownika; każdy następny
   dociągamy automatycznie, gdy do końca załadowanego feedu zostają ≤ 2 karty albo gdy użytkownik odpowie na
   ostatnią załadowaną kartę. Z odpowiedzi odpada to, co już jest w feedzie (po pageid), kolejność z API zostaje. */

async function loadAround(lat, lon, radiusM = state.radius, label = null) {
  const radius = RADII.includes(radiusM) ? radiusM : state.radius;
  state.center = { lat, lon, label };
  if (radius !== state.radius) { state.radius = radius; storageSet(STORAGE_RADIUS, radius); syncChips(); }
  loadToken += 1;
  lastAction = () => loadAround(lat, lon, radius, label);

  if (!historyPushed) {
    try { history.pushState({ wm: 'around' }, ''); historyPushed = true; } catch { /* np. nietypowy kontekst osadzenia */ }
  }
  state.screen = 'loading';
  state.rings = [];
  state.ringIndex = RADII.indexOf(radius) - 1;
  state.feedDone = false;
  state.places = [];
  state.items = [];
  state.answers = {};   // state.details zostaje: ta sama strona nie jest pobierana ponownie po zmianie promienia
  state.index = 0;
  state.error = null;
  clearFeed();
  render();
  await loadNextRing();
  return state.places;
}

function ringLoading() {
  const ring = state.rings[state.rings.length - 1];
  return Boolean(ring && ring.status === 'loading');
}
/* Pierścień w trakcie ładowania albo w błędzie blokuje dociąganie następnego (błąd odblokowuje tylko „Spróbuj ponownie”). */
function ringBlocked() {
  const ring = state.rings[state.rings.length - 1];
  return Boolean(ring && (ring.status === 'loading' || ring.status === 'error'));
}

/* Zamawia kolejny pierścień; po ostatnim (10 km) zamyka feed. */
async function loadNextRing() {
  if (state.feedDone || ringBlocked() || !state.center) return;
  const idx = state.ringIndex + 1;
  if (idx >= RADII.length) { finishFeed(); return; }
  const token = loadToken;
  const radius = RADII[idx];
  const ring = { radius, index: idx, status: 'loading', places: [], isStart: state.rings.length === 0, error: null };
  state.rings.push(ring);
  state.ringIndex = idx;
  if (state.screen === 'feed') renderTail();
  try {
    const list = await geosearch(state.center.lat, state.center.lon, radius, radius >= 3000 ? 500 : 100);
    if (token !== loadToken) return;   // w międzyczasie ruszyło nowe ładowanie
    const seen = new Set(state.places.map((p) => p.pageid));
    ring.places = list.filter((p) => !seen.has(p.pageid));
    ring.status = 'ready';
    onRingLoaded(ring);
  } catch (err) {
    if (token !== loadToken) return;
    ring.status = 'error';
    ring.error = describeError(err);
    if (state.screen === 'feed') renderTail();
    else { state.error = ring.error; state.screen = 'error'; render(); }
  }
}

function onRingLoaded(ring) {
  const isLast = ring.index === RADII.length - 1;
  const wasAtTail = state.screen === 'feed' && state.index >= state.items.length;
  const firstNewItem = state.items.length;

  Object.assign(state.answers, restoreAnswers(ring.places));
  ring.places.forEach((p) => {
    state.places.push(p);
    state.items.push({ type: 'place', place: p, ordinal: state.places.length, ring });
  });
  // Karta pierścienia po jego miejscach; po ostatnim pierścieniu zamiast niej jest karta końcowa.
  // Pusty pierścień startowy dostaje kartę „nic nie ma”, pusty dalszy pierścień — żadnej (jedziemy dalej).
  if (!isLast && (ring.places.length > 0 || ring.isStart)) state.items.push({ type: 'ring', ring });

  if (state.screen !== 'feed') {
    state.screen = 'feed';
    render();
    buildFeed();
  } else {
    renderAround(state.index);
    renderTail();
    updateTailCard();
    updateRingCards();
    updateProgress();
    if (wasAtTail && ring.places.length) {
      // Użytkownik czekał na karcie ładowania: nowe karty wchodzą w to samo miejsce (overflow-anchor: none);
      // gdy pierwsze z nich mają już odpowiedź z poprzedniej sesji, przeskakujemy do pierwszej bez odpowiedzi.
      let target = firstNewItem;
      for (let i = firstNewItem; i < state.items.length; i++) {
        const it = state.items[i];
        if (it.type === 'place' && typeof state.answers[it.place.pageid] !== 'boolean') { target = i; break; }
      }
      renderUpTo(target + 1);
      const el = els.feed.children[target];
      if (el) els.feed.scrollTo({ top: el.offsetTop, behavior: 'auto' });
      state.index = target;
      updateProgress();
      prefetch(target);
    }
  }

  if (isLast) finishFeed();
  else if (ring.places.length === 0) loadNextRing();   // nic nowego → od razu następny pierścień
  else maybeLoadNextRing();
}

function finishFeed() {
  state.feedDone = true;
  if (!state.places.length) { state.screen = 'empty'; render(); return; }
  renderTail();
  updateRingCards();
  updateEndCard();
  updateProgress();
}

function maybeLoadNextRing() {
  if (state.screen !== 'feed' || state.feedDone || ringBlocked()) return;
  if (state.index >= state.items.length - RING_LOOKAHEAD) loadNextRing();
}

function retryRing() {
  const ring = state.rings[state.rings.length - 1];
  if (!ring || ring.status !== 'error') return;
  state.rings.pop();
  state.ringIndex = ring.index - 1;
  loadNextRing();
}

function restoreAnswers(places) {
  const stored = storageGet(STORAGE_ANSWERS, {});
  const answers = {};
  if (stored && typeof stored === 'object') {
    places.forEach((p) => { if (typeof stored[p.pageid] === 'boolean') answers[p.pageid] = stored[p.pageid]; });
  }
  return answers;
}

/* ---------- Feed ---------- */

function buildFeed() {
  clearFeed();
  observer = new IntersectionObserver(onIntersect, { root: els.feed, threshold: 0.6 });
  // Odpowiedzi zapamiętane z poprzedniej sesji: karty już oznaczone, start od pierwszej bez odpowiedzi.
  let firstOpen = -1;
  state.items.forEach((it, i) => {
    if (firstOpen < 0 && it.type === 'place' && typeof state.answers[it.place.pageid] !== 'boolean') firstOpen = i;
  });
  // Wszystko odpowiedziane → ostatni element (karta pierścienia / „nic nie ma”), pod nim ładuje się następny pierścień.
  const startIndex = firstOpen >= 0 ? firstOpen : Math.max(0, state.items.length - 1);
  state.index = startIndex;
  renderAround(startIndex);
  renderTail();
  updateProgress();
  if (firstOpen >= 0) prefetch(firstOpen);
  if (startIndex > 0) {
    const target = els.feed.children[startIndex];
    if (target) els.feed.scrollTo({ top: target.offsetTop, behavior: 'auto' });
  }
  maybeLoadNextRing();
}

function onIntersect(entries) {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    state.index = Number(entry.target.dataset.index);
    updateProgress();
    prefetch(state.index);
    renderAround(state.index);
    maybeLoadNextRing();
  });
}

/* Renderowanie przyrostowe: karty powstają partiami, maks. RENDER_AHEAD przed bieżącą. */
function renderAround(itemIndex) {
  renderUpTo(itemIndex + RENDER_AHEAD + 1);
}

function renderUpTo(limit) {
  const end = Math.min(limit, state.items.length);
  if (renderedCount >= end) return;
  const frag = document.createDocumentFragment();
  const fresh = [];
  for (let i = renderedCount; i < end; i++) {
    const item = state.items[i];
    let el;
    if (item.type === 'place') {
      el = createCard(item.place, i);
      cardsById.set(item.place.pageid, el);
      if (typeof state.answers[item.place.pageid] === 'boolean') markCard(el, state.answers[item.place.pageid]);
      if (state.details[item.place.pageid]) applyDetails(item.place.pageid);
    } else {
      el = createRingCard(item.ring, i);
    }
    frag.appendChild(el);
    fresh.push(el);
  }
  els.feed.insertBefore(frag, tailEl);   // tailEl === null → na koniec
  renderedCount = end;
  if (observer) fresh.forEach((el) => observer.observe(el));
}

/* Ogon feedu: dopóki są dalsze pierścienie, ostatnim elementem jest karta ładowania („Szukam miejsc 1–3 km stąd…”);
   błąd pierścienia zamienia ją na kartę błędu z ponowieniem, a koniec feedu — na kartę końcową. */
function renderTail() {
  const ring = state.rings[state.rings.length - 1];
  let kind = null;
  if (state.feedDone) kind = state.places.length ? 'end' : null;
  else if (ring && ring.status === 'error') kind = 'error';
  else kind = 'loading';
  if (kind !== tailKind) {
    // Podmiana w miejscu (nie usuń + dodaj): wysokość feedu nie maleje, więc użytkownik stojący na karcie
    // ładowania zostaje tam, gdzie był, a karta końcowa pojawia się dokładnie pod nim.
    const next = kind === 'end' ? createEndCard() : (kind ? createTailCard() : null);
    const hadFocus = tailEl && document.activeElement === tailEl;
    if (tailEl) {
      if (observer) observer.unobserve(tailEl);
      if (next) tailEl.replaceWith(next); else tailEl.remove();
    } else if (next) {
      els.feed.appendChild(next);
    }
    tailEl = next;
    tailKind = kind;
    if (tailEl && observer) observer.observe(tailEl);
    if (tailEl && hadFocus) tailEl.focus({ preventScroll: true });
  }
  if (tailEl) tailEl.dataset.index = String(state.items.length);
  els.feed.setAttribute('aria-busy', ringLoading() ? 'true' : 'false');
  if (kind === 'loading' || kind === 'error') updateTailCard();
  if (kind === 'end') updateEndCard();
}

function createTailCard() {
  const el = els['tail-template'].content.firstElementChild.cloneNode(true);
  el.querySelector('.tail-retry').addEventListener('click', retryRing);
  return el;
}

/* Zakres, którego szuka (albo zaraz będzie szukać) karta ogona: „1–3 km stąd” / „w promieniu 500 m”. */
function tailRange() {
  const last = state.rings[state.rings.length - 1];
  if (!last) return '';
  if (last.status === 'ready') {
    const next = RADII[last.index + 1];
    return next ? `${formatRange(last.radius, next)} stąd` : '';
  }
  const prev = state.rings[state.rings.length - 2];
  return prev ? `${formatRange(prev.radius, last.radius)} stąd` : `w promieniu ${formatRadius(last.radius)}`;
}

function updateTailCard() {
  const ring = state.rings[state.rings.length - 1];
  if (!tailEl || !ring) return;
  const isError = ring.status === 'error';
  tailEl.classList.toggle('is-error', isError);
  tailEl.querySelector('.tail-loading').hidden = isError;
  tailEl.querySelector('.tail-error').hidden = !isError;
  tailEl.querySelector('.tail-loading-text').textContent = `Szukam miejsc ${tailRange()}…`;
  tailEl.querySelector('.tail-error-text').textContent = isError ? (ring.error || '') : '';
}

function createCard(place, index) {
  const card = els['card-template'].content.firstElementChild.cloneNode(true);
  card.dataset.index = String(index);
  card.dataset.pageid = String(place.pageid);
  card.setAttribute('aria-label', place.title);

  const hue = hueFromTitle(place.title);
  card.querySelector('.card-placeholder').style.setProperty('--ph', `hsl(${hue} 34% 26%)`);
  card.querySelector('.card-letter').textContent = String(place.title).trim().charAt(0).toUpperCase();
  card.querySelector('.card-distance-text').textContent = formatDistance(place.dist);
  card.querySelector('.card-title').textContent = place.title;
  card.querySelector('.card-extract').classList.add('is-skeleton');
  const link = card.querySelector('.card-link');
  link.href = `${WIKI_BASE}/wiki/${encodeTitle(place.title)}`;
  link.setAttribute('aria-label', `Czytaj w Wikipedii: ${place.title}`);
  const nav = card.querySelector('.card-navigate');
  nav.href = navigateUrl(place.lat, place.lon);   // geosearch zawsze podaje lat/lon; REST może je później doprecyzować
  nav.setAttribute('aria-label', `Nawiguj do: ${place.title}`);

  card.querySelectorAll('.btn-answer').forEach((btn) => {
    btn.addEventListener('click', () => answer(place.pageid, btn.dataset.known === 'true'));
  });
  card.querySelector('.card-retry').addEventListener('click', () => ensureDetails(place, { force: true }));
  attachSwipe(card, place.pageid);
  return card;
}

/* Karta pierścienia: podsumowanie promienia i zapowiedź następnego. */
function createRingCard(ring, index) {
  const el = els['ring-template'].content.firstElementChild.cloneNode(true);
  el.dataset.index = String(index);
  el.dataset.radius = String(ring.radius);
  el.querySelector('.ring-share').addEventListener('click', () => share(shareTextFor(ring.radius, ringStats(ring).pct)));
  updateRingCard(el, ring);
  return el;
}

function ringStats(ring) {
  const total = ring.places.length;
  let known = 0;
  let answered = 0;
  ring.places.forEach((p) => {
    const a = state.answers[p.pageid];
    if (typeof a === 'boolean') { answered += 1; if (a) known += 1; }
  });
  return { total, known, answered, pct: total ? Math.round((known / total) * 100) : 0 };
}

/* Promień następnego pierścienia, który coś wnosi (albo dopiero się ładuje / czeka w kolejce). */
function nextRadiusAfter(ring) {
  for (const r of state.rings) {
    if (r.index <= ring.index) continue;
    if (r.status !== 'ready' || r.places.length) return r.radius;
  }
  return RADII[state.ringIndex + 1] || null;
}

function updateRingCard(el, ring) {
  const { total, known, answered, pct } = ringStats(ring);
  const radiusText = formatRadius(ring.radius);
  const title = el.querySelector('.ring-title');
  const score = el.querySelector('.ring-score');
  const meter = el.querySelector('.end-meter');
  const shareBtn = el.querySelector('.ring-share');
  el.querySelector('.ring-eyebrow').textContent = `Promień ${radiusText}`;
  if (total === 0) {
    title.textContent = `W promieniu ${radiusText} nic nie ma`;
    score.textContent = 'Wikipedia nie zna tu żadnego miejsca — szukam dalej.';
    meter.hidden = true;
    shareBtn.hidden = true;
  } else if (answered === 0) {
    title.textContent = `To wszystko w promieniu ${radiusText}`;
    score.textContent = `Przewinąłeś ${total} ${pluralPlaces(total)} w promieniu ${radiusText}`;
    meter.hidden = true;
    shareBtn.hidden = true;
  } else {
    title.textContent = `To wszystko w promieniu ${radiusText}`;
    score.textContent = `Znasz ${pct}% (${known} z ${total} ${placesGenitive(total)})`;
    meter.hidden = false;
    shareBtn.hidden = false;
    el.querySelector('.end-percent-num').textContent = String(pct);
    el.querySelector('.end-ring-value').style.setProperty('--pct', String(pct));
    meter.setAttribute('aria-label', `Znasz ${pct}% miejsc w promieniu ${radiusText}`);
  }
  el.setAttribute('aria-label', title.textContent);
  const next = nextRadiusAfter(ring);
  el.querySelector('.ring-next-text').textContent = next
    ? `Dalej: miejsca ${formatRange(ring.radius, next)} stąd`
    : `Dalej: podsumowanie — to już wszystko w promieniu ${formatRadius(RADII[RADII.length - 1])}`;
}

function updateRingCards() {
  els.feed.querySelectorAll('.card-ring').forEach((el) => {
    const ring = state.rings.find((r) => r.radius === Number(el.dataset.radius));
    if (ring) updateRingCard(el, ring);
  });
}

function createEndCard() {
  const end = els['end-template'].content.firstElementChild.cloneNode(true);
  end.querySelector('[data-testid="share-button"]').addEventListener('click', () => share(shareTextFor(RADII[RADII.length - 1], overallPct())));
  end.querySelector('.end-change').addEventListener('click', changePlace);
  end.querySelector('.end-again').addEventListener('click', resetAnswers);
  return end;
}

function knownCount() {
  return state.places.reduce((n, p) => n + (state.answers[p.pageid] === true ? 1 : 0), 0);
}
function answeredCount() {
  return state.places.reduce((n, p) => n + (typeof state.answers[p.pageid] === 'boolean' ? 1 : 0), 0);
}
function overallPct() {
  const total = state.places.length;
  return total ? Math.round((knownCount() / total) * 100) : 0;
}

/* „3 z 24 · znasz 2”: numer bieżącej karty miejsca i liczba załadowanych miejsc (karty pierścieni nie liczą się). */
function updateProgress() {
  const total = state.places.length;
  if (!total || state.screen !== 'feed') { els.progress.textContent = ''; return; }
  const item = state.items[state.index];
  let ordinal = total;
  if (item && item.type === 'place') ordinal = item.ordinal;
  else if (item) {
    ordinal = 0;
    for (let i = state.index - 1; i >= 0; i--) {
      if (state.items[i].type === 'place') { ordinal = state.items[i].ordinal; break; }
    }
    ordinal = Math.max(1, ordinal);
  }
  els.progress.textContent = `${Math.min(ordinal, total)} z ${total} · znasz ${knownCount()}`;
}

function updateEndCard() {
  if (!tailEl || tailKind !== 'end') return;
  const total = state.places.length;
  const known = knownCount();
  const pct = overallPct();
  const maxText = formatRadius(RADII[RADII.length - 1]);
  tailEl.querySelector('.end-percent-num').textContent = String(pct);
  tailEl.querySelector('.end-ring-value').style.setProperty('--pct', String(pct));
  tailEl.querySelector('.end-meter').setAttribute('aria-label', `Znasz ${pct}% okolicy`);
  tailEl.querySelector('.end-title').textContent = `To wszystko, co Wikipedia zna w promieniu ${maxText}`;
  tailEl.querySelector('.end-sub').textContent = `Znasz ${pct}% (${known} z ${total} ${placesGenitive(total)})`;
  tailEl.querySelector('.end-again').hidden = answeredCount() === 0;
}

/* Pobieranie szczegółów: leniwie, dla bieżącej karty i PREFETCH_AHEAD następnych kart miejsc. */
function prefetch(fromItem) {
  let count = 0;
  for (let i = Math.max(0, fromItem); i < state.items.length && count <= PREFETCH_AHEAD; i++) {
    const it = state.items[i];
    if (it.type !== 'place') continue;
    ensureDetails(it.place);
    count += 1;
  }
}

async function ensureDetails(place, { force = false } = {}) {
  const id = place.pageid;
  const current = state.details[id];
  if (current && current.status !== 'error') return;
  const attempts = (current && current.attempts) || 0;
  if (attempts >= MAX_AUTO_ATTEMPTS && !force) return;   // bez automatycznego młócenia API przy każdym wejściu w widok
  state.details[id] = { status: 'loading', attempts };
  applyDetails(id);
  try {
    const d = await fetchDetails(place);
    state.details[id] = { status: 'ready', ...d };
  } catch {
    state.details[id] = { status: 'error', attempts: attempts + 1 };
  }
  applyDetails(id);
}

function applyDetails(pageid) {
  const card = cardsById.get(pageid);
  const d = state.details[pageid];
  if (!card || !d) return;
  const extract = card.querySelector('.card-extract');
  const errorRow = card.querySelector('.card-detail-error');
  const link = card.querySelector('.card-link');

  if (d.status === 'loading') {
    extract.textContent = '';
    extract.classList.add('is-skeleton');
    errorRow.hidden = true;
    return;
  }
  extract.classList.remove('is-skeleton');
  if (d.status === 'error') {
    extract.textContent = '';
    errorRow.hidden = false;
    return;
  }
  errorRow.hidden = true;
  extract.textContent = d.extract || 'Wikipedia nie ma jeszcze opisu tego miejsca.';
  if (d.url) link.href = d.url;
  if (d.coords) card.querySelector('.card-navigate').href = navigateUrl(d.coords.lat, d.coords.lon);
  if (d.image) loadPhoto(card, d.image, d.thumb);
}

/* Zdjęcie: najpierw powiększona miniatura, przy błędzie oryginalna miniatura, na końcu zostaje placeholder. */
function loadPhoto(card, src, fallbackSrc) {
  const img = card.querySelector('.card-photo');
  if (img.dataset.src === src) return;
  img.dataset.src = src;
  img.classList.remove('is-loaded');
  img.onload = () => { img.classList.add('is-loaded'); };
  img.onerror = () => {
    if (fallbackSrc && img.src !== fallbackSrc) { img.src = fallbackSrc; return; }
    img.hidden = true;
  };
  img.hidden = false;
  img.src = src;
}

/* ---------- Odpowiedzi ---------- */

function answer(pageid, known) {
  const id = Number(pageid);
  const place = state.places.find((p) => p.pageid === id);
  if (!place || typeof state.answers[id] === 'boolean') return false;
  state.answers[id] = Boolean(known);
  const stored = storageGet(STORAGE_ANSWERS, {});
  const next = stored && typeof stored === 'object' ? stored : {};
  next[id] = Boolean(known);
  storageSet(STORAGE_ANSWERS, next);

  const card = cardsById.get(id);
  if (card) markCard(card, Boolean(known));
  updateProgress();
  updateRingCards();
  updateEndCard();
  if (state.places[state.places.length - 1] === place) loadNextRing();   // ostatnia załadowana karta → dociągamy
  window.setTimeout(() => advanceFrom(card, id), ADVANCE_DELAY);
  return true;
}

function markCard(card, known) {
  if (!card) return;
  card.classList.add('is-answered');
  card.dataset.answer = known ? 'true' : 'false';
  card.querySelector('.card-stamp-text').textContent = known ? 'Wiedziałeś' : 'Nie wiedziałeś';
  card.querySelectorAll('.btn-answer').forEach((b) => { b.disabled = true; });
}

function unmarkCard(card) {
  card.classList.remove('is-answered');
  delete card.dataset.answer;
  card.querySelectorAll('.btn-answer').forEach((b) => { b.disabled = false; });
}

/* Po odpowiedzi: do następnej karty pierścienia albo następnej karty miejsca bez odpowiedzi; gdy nic nie zostało —
   do ogona feedu (ładowanie kolejnego pierścienia lub karta końcowa). */
function advanceFrom(card, pageid) {
  if (state.screen !== 'feed') return;
  let start = card ? Number(card.dataset.index) + 1 : -1;
  if (start < 0) start = state.items.findIndex((it) => it.type === 'place' && it.place.pageid === pageid) + 1;
  let targetIndex = -1;
  for (let i = start; i < state.items.length; i++) {
    const it = state.items[i];
    if (it.type === 'ring' || typeof state.answers[it.place.pageid] !== 'boolean') { targetIndex = i; break; }
  }
  let target;
  if (targetIndex >= 0) {
    renderUpTo(targetIndex + 1);
    target = els.feed.children[targetIndex];
  } else {
    renderUpTo(state.items.length);   // ogon ma stać na swoim ostatecznym miejscu, zanim do niego przewiniemy
    target = tailEl || els.feed.lastElementChild;
  }
  if (!target) return;
  scrollToCard(target);
  // Fokus wędruje z (już nieaktywnego) przycisku na następną kartę, żeby Tab szedł dalej, a nie od początku.
  if (typeof target.focus === 'function') target.focus({ preventScroll: true });
}

function scrollToCard(el) {
  if (!el) return;
  els.feed.scrollTo({ top: el.offsetTop, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

/* „Jeszcze raz”: usuwa odpowiedzi dla wszystkich załadowanych pierścieni i wraca na pierwszą kartę. */
function resetAnswers() {
  const stored = storageGet(STORAGE_ANSWERS, {});
  const next = stored && typeof stored === 'object' ? stored : {};
  state.places.forEach((p) => { delete next[p.pageid]; });
  storageSet(STORAGE_ANSWERS, next);
  state.answers = {};
  cardsById.forEach((card) => unmarkCard(card));
  updateProgress();
  updateRingCards();
  updateEndCard();
  scrollToCard(els.feed.firstElementChild);
}

/* ---------- Gest przesunięcia ----------
   Pointer Events: po SWIPE_LOCK px decydujemy, czy ruch jest poziomy. Pionowy zostawiamy przeglądarce
   (touch-action: pan-y na karcie → przy przewijaniu dostajemy pointercancel). Poziomy przechwytujemy:
   karta jedzie za palcem i lekko się przechyla, etykieta „Wiedziałem”/„Nie wiedziałem” wyłania się
   proporcjonalnie do progu. Puszczenie za progiem = odpowiedź, przed progiem = powrót na miejsce. */
function attachSwipe(card, pageid) {
  const labelKnown = card.querySelector('.swipe-label-known');
  const labelUnknown = card.querySelector('.swipe-label-unknown');
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let mode = null; // null | 'h' | 'v'

  const reset = () => {
    card.classList.remove('is-dragging');
    card.style.transform = '';
    labelKnown.style.opacity = '0';
    labelUnknown.style.opacity = '0';
    pointerId = null;
    mode = null;
    dx = 0;
  };

  card.addEventListener('pointerdown', (e) => {
    if (pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.target.closest('button, a, input')) return;
    if (card.classList.contains('is-answered')) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    mode = null;
  });

  card.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (mode === null) {
      if (Math.abs(dx) < SWIPE_LOCK && Math.abs(dy) < SWIPE_LOCK) return;
      mode = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      if (mode === 'h') {
        card.classList.add('is-dragging');
        try { card.setPointerCapture(pointerId); } catch { /* np. wskaźnik już zwolniony */ }
      }
    }
    if (mode !== 'h') return;
    const tilt = Math.max(-10, Math.min(10, dx / 18));
    card.style.transform = `translateX(${dx}px) rotate(${tilt}deg)`;
    const strength = Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD);
    labelKnown.style.opacity = dx > 0 ? String(strength) : '0';
    labelUnknown.style.opacity = dx < 0 ? String(strength) : '0';
  });

  const finish = (e) => {
    if (e.pointerId !== pointerId) return;
    const decided = mode === 'h' && e.type === 'pointerup' && Math.abs(dx) >= SWIPE_THRESHOLD;
    const known = dx > 0;
    reset();
    if (decided) answer(pageid, known);
  };
  card.addEventListener('pointerup', finish);
  card.addEventListener('pointercancel', finish);
  // Dotyk jest niejawnie przechwytywany przez element pod palcem (np. .card-shade); nasze setPointerCapture
  // zwalnia tamto przechwycenie i lostpointercapture bąbelkuje do karty — to nie jest koniec gestu.
  card.addEventListener('lostpointercapture', (e) => {
    if (e.target !== card || e.pointerId !== pointerId) return;
    reset();
  });
}

/* ---------- Udostępnianie ---------- */

function shareTextFor(radius, pct) {
  const url = location.href.split('#')[0];
  return `Znam ${pct}% miejsc w promieniu ${formatRadius(radius)} od siebie. Sprawdź swoją okolicę: ${url}`;
}

async function share(text) {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // użytkownik zamknął arkusz udostępniania
    }
  }
  if (await copyToClipboard(text)) toast('Skopiowano');
  else toast('Nie udało się skopiować. Zaznacz tekst wyniku ręcznie.');
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* przechodzimy do zapasowej metody */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function toast(message) {
  const t = els.toast;
  t.textContent = message;
  t.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, 2400);
}

/* ---------- Ekran startowy: GPS i wpisywanie miejsca ---------- */

function showGeoFallback(message) {
  els['geo-message'].textContent = message;
  els['geo-message'].hidden = false;
  openPlaceForm();
}

function openPlaceForm(focus = true) {
  els['place-form'].hidden = false;
  els['place-toggle'].setAttribute('aria-expanded', 'true');
  els['place-toggle'].hidden = true;
  if (focus) els['place-input'].focus({ preventScroll: false });
}

function setStartBusy(busy, label) {
  const btn = els['start-button'];
  btn.disabled = busy;
  btn.querySelector('span').textContent = busy ? label : 'Pokaż, co jest wokół';
}

function locate() {
  els['geo-message'].hidden = true;
  if (window.isSecureContext === false) {
    showGeoFallback('Lokalizacja działa tylko na stronie otwartej przez HTTPS albo localhost. Otwórz aplikację pod bezpiecznym adresem albo wpisz miejsce poniżej.');
    return;
  }
  if (!navigator.geolocation) {
    showGeoFallback('Ta przeglądarka nie udostępnia lokalizacji. Wpisz miejsce poniżej.');
    return;
  }
  const token = ++locateToken;
  // Spóźniony wynik GPS (po tym, jak użytkownik wpisał miejsce albo wrócił na start) jest ignorowany.
  const stale = () => token !== locateToken || state.screen !== 'start';
  setStartBusy(true, 'Ustalam położenie…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (stale()) return;
      setStartBusy(false);
      loadAround(pos.coords.latitude, pos.coords.longitude, state.radius, null);
    },
    (err) => {
      if (stale()) return;
      setStartBusy(false);
      let message;
      if (err && err.code === 1) {
        message = 'Dostęp do lokalizacji jest zablokowany. Wpisz miejsce poniżej albo włącz lokalizację dla tej strony w ustawieniach przeglądarki (ikona kłódki przy adresie) i spróbuj ponownie.';
      } else if (err && err.code === 3) {
        message = 'Ustalanie położenia trwa zbyt długo. Wyjdź na otwartą przestrzeń i spróbuj ponownie albo wpisz miejsce poniżej.';
      } else {
        message = 'Nie udało się ustalić położenia. Włącz lokalizację w telefonie albo wpisz miejsce poniżej.';
      }
      showGeoFallback(message);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
  );
}

async function submitPlace(event) {
  event.preventDefault();
  const input = els['place-input'];
  const msg = els['place-message'];
  const query = input.value.trim();
  msg.hidden = true;
  if (!query) {
    msg.textContent = 'Wpisz nazwę miejsca, np. „Rynek Główny, Kraków”.';
    msg.hidden = false;
    input.focus();
    return;
  }
  const submit = els['place-submit'];
  submit.disabled = true;
  input.setAttribute('aria-busy', 'true');
  try {
    const hit = await searchPlace(query);
    if (!hit) {
      msg.textContent = `Nie znaleziono miejsca „${query}” ze współrzędnymi. Dodaj nazwę miejscowości albo użyj innej nazwy.`;
      msg.hidden = false;
      return;
    }
    loadAround(hit.lat, hit.lon, state.radius, hit.title);
  } catch (err) {
    msg.textContent = describeError(err);
    msg.hidden = false;
  } finally {
    submit.disabled = false;
    input.removeAttribute('aria-busy');
  }
}

/* ---------- Start ---------- */

function showStart() {
  loadToken += 1; // unieważnia trwające pobieranie listy
  locateToken += 1;
  state.screen = 'start';
  state.rings = [];
  state.ringIndex = -1;
  state.feedDone = false;
  state.places = [];
  state.items = [];
  state.details = {};
  state.answers = {};
  state.index = 0;
  render();
  els['start-button'].focus();
}

function changePlace() {
  if (historyPushed) history.back(); // popstate pokaże ekran startowy
  else showStart();
}

function init() {
  cacheElements();
  const savedRadius = Number(storageGet(STORAGE_RADIUS, DEFAULT_RADIUS));
  state.radius = RADII.includes(savedRadius) ? savedRadius : DEFAULT_RADIUS;
  buildChips();

  els['start-button'].addEventListener('click', locate);
  els['place-toggle'].addEventListener('click', () => openPlaceForm(true));
  els['place-form'].addEventListener('submit', submitPlace);
  els['retry-button'].addEventListener('click', () => { if (lastAction) lastAction(); });
  els['change-place'].addEventListener('click', changePlace);
  window.addEventListener('popstate', () => {
    historyPushed = false;
    if (state.screen !== 'start') showStart();
  });

  // Rzeczywista wysokość paska (z wcięciem systemowym) jako zmienna CSS dla kart podsumowań i pieczątki.
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      const h = els.topbar.offsetHeight;
      if (h > 0) els.app.style.setProperty('--topbar-h', `${h}px`);
    }).observe(els.topbar);
  }

  render();
  window.WM = { state, loadAround, answer, loadNextRing };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
