/* Wokół mnie — v0.2: losowy, nieskończony feed w pierścieniach, polubienia i zapisane miejsca.
   Czysty JS (ES2020), bez zależności. */
'use strict';

const WIKI_BASE = 'https://pl.wikipedia.org';

const RADII = [500, 1000, 3000, 5000, 10000];   // pierścienie; 10 000 m to maksimum geosearch
const DEFAULT_RADIUS = 1000;
const PREFETCH_AHEAD = 3;          // szczegóły pobierane dla bieżącej karty i 3 następnych
const RENDER_AHEAD = 40;           // tyle kart renderujemy z wyprzedzeniem przed bieżącą (reszta czeka w stanie)
const RING_LOOKAHEAD = 3;          // następny pierścień dociągamy, gdy do końca listy zostają ≤ 2 karty
const SWIPE_THRESHOLD = 80;        // px przesunięcia poziomego, które liczy się jako gest (w prawo: lubię, w lewo: dalej)
const SWIPE_LOCK = 10;             // px, po których decydujemy: gest poziomy czy pionowy
const DOUBLE_TAP = 320;            // ms między dwoma stuknięciami w zdjęcie, które liczą się jako podwójne (= lubię)
const BURST_DURATION = 700;        // ms widoczności serca po podwójnym stuknięciu / przesunięciu w prawo
const SEEN_DELAY = 1500;           // ms na karcie, po których liczy się jako obejrzana
const SEEN_LIMIT = 2000;           // tyle obejrzanych miejsc pamiętamy; najstarsze wypadają
const FETCH_TIMEOUT = 12000;
const MAX_AUTO_ATTEMPTS = 2;       // pobranie + jedna automatyczna ponowna próba; dalej tylko „Spróbuj ponownie”
const STORAGE_RADIUS = 'wm.radius';
const STORAGE_SEEN = 'wm.seen';               // [pageid, …] od najstarszego
const STORAGE_LIKES = 'wm.likes';             // { pageid: timestamp }
const STORAGE_SAVED = 'wm.saved';             // { pageid: timestamp }
const STORAGE_SAVED_PLACES = 'wm.savedPlaces'; // { pageid: { title, lat, lon, url } } — dane do listy „Moje miejsca” między sesjami

const state = {
  screen: 'start',   // start | loading | feed | empty | error
  center: null,      // { lat, lon, label }
  radius: DEFAULT_RADIUS, // pierścień startowy (chip)
  rings: [],         // [{ radius, index, status: 'loading'|'ready'|'error', places, isStart, error }] w kolejności ładowania
  ringIndex: -1,     // indeks w RADII ostatnio zamówionego pierścienia
  feedDone: false,   // true po ostatnim pierścieniu (10 km)
  places: [],        // wszystkie załadowane miejsca w kolejności feedu (w obrębie pierścienia: losowo, nieobejrzane najpierw)
  items: [],         // elementy feedu: { type: 'place', place, ring } | { type: 'ring', ring }
  details: {},       // pageid -> { status: 'loading'|'ready'|'error', extract, image, thumb, url, coords }
  liked: {},         // pageid -> timestamp (lustro wm.likes)
  saved: {},         // pageid -> timestamp (lustro wm.saved)
  savedPlaces: {},   // pageid -> { title, lat, lon, url } (lustro wm.savedPlaces)
  seen: [],          // pageid-y obejrzanych kart od najstarszego (lustro wm.seen)
  index: 0,          // indeks elementu feedu w widoku (items.length = karta ogona: ładowanie / koniec)
  panelOpen: false,  // panel „Moje miejsca”
  error: null,
};
const seenSet = new Set();

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

/* Losowość: podmienialna w testach (WM.rng.next = () => 0.9999 daje kolejność z API). */
const rng = { next: Math.random };

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng.next() * (i + 1)));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* Kolejność w pierścieniu: nieobejrzane miejsca (losowo), potem obejrzane (też losowo). Świeże losowanie przy każdym ładowaniu. */
function orderRing(places) {
  const fresh = [];
  const old = [];
  places.forEach((p) => { (seenSet.has(p.pageid) ? old : fresh).push(p); });
  return shuffle(fresh).concat(shuffle(old));
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

/* Liczba mnoga: 1 miejsce, 2 miejsca, 5 miejsc, 22 miejsca. */
function pluralPlaces(n) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n === 1) return 'miejsce';
  if (n10 >= 2 && n10 <= 4 && !(n100 >= 12 && n100 <= 14)) return 'miejsca';
  return 'miejsc';
}

/* Odległość między dwoma punktami (haversine), w metrach. */
function haversine(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
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

function initialOf(title) {
  return String(title).trim().charAt(0).toUpperCase();
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

function wikiUrl(title) {
  return `${WIKI_BASE}/wiki/${encodeTitle(title)}`;
}

/* Trasa piesza do miejsca w Mapach Google; współrzędne z kropką dziesiętną, 5 miejsc (~1 m). */
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
  const fallbackUrl = wikiUrl(place.title);
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

/* ---------- Pamięć: obejrzane, polubione, zapisane ---------- */

function sanitizeMap(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach((k) => { if (Number(k) > 0 && typeof raw[k] === 'number') out[Number(k)] = raw[k]; });
  }
  return out;
}

function loadPersisted() {
  state.liked = sanitizeMap(storageGet(STORAGE_LIKES, {}));
  state.saved = sanitizeMap(storageGet(STORAGE_SAVED, {}));
  const rawPlaces = storageGet(STORAGE_SAVED_PLACES, {});
  state.savedPlaces = rawPlaces && typeof rawPlaces === 'object' ? rawPlaces : {};
  const rawSeen = storageGet(STORAGE_SEEN, []);
  state.seen = (Array.isArray(rawSeen) ? rawSeen : []).map(Number).filter((id) => id > 0).slice(-SEEN_LIMIT);
  seenSet.clear();
  state.seen.forEach((id) => seenSet.add(id));
}

/* Karta obejrzana: była aktywna ≥ SEEN_DELAY. Ponowne obejrzenie przesuwa wpis na koniec (najstarsze wypadają pierwsze). */
function markSeen(pageid) {
  const id = Number(pageid);
  if (!(id > 0)) return false;
  if (seenSet.has(id)) {
    const at = state.seen.indexOf(id);
    if (at >= 0) state.seen.splice(at, 1);
  }
  state.seen.push(id);
  seenSet.add(id);
  while (state.seen.length > SEEN_LIMIT) seenSet.delete(state.seen.shift());
  storageSet(STORAGE_SEEN, state.seen);
  return true;
}

function clearSeen() {
  state.seen = [];
  seenSet.clear();
  storageSet(STORAGE_SEEN, []);
}

/* Polubienia: dziś tylko lokalne. Wspólny licznik (backend) wepnie się przez counts(); karta ma już ukryty .like-count. */
const likes = {
  isLiked(pageid) { return Boolean(state.liked[Number(pageid)]); },
  toggle(pageid) {
    const id = Number(pageid);
    const on = !state.liked[id];
    if (on) state.liked[id] = Date.now(); else delete state.liked[id];
    storageSet(STORAGE_LIKES, state.liked);
    return on;
  },
  /* Liczba polubień innych użytkowników dla podanych stron: Map<pageid, number>. Bez backendu — pusta mapa. */
  async counts(pageids) {
    void pageids;
    return new Map();
  },
};

/* Zapisane miejsca („Moje miejsca”): mapa pageid → czas zapisania plus dane potrzebne liście (tytuł, współrzędne, link). */
const saved = {
  isSaved(pageid) { return Boolean(state.saved[Number(pageid)]); },
  add(pageid, info) {
    const id = Number(pageid);
    state.saved[id] = Date.now();
    state.savedPlaces[id] = { title: info.title, lat: info.lat, lon: info.lon, url: info.url };
    storageSet(STORAGE_SAVED, state.saved);
    storageSet(STORAGE_SAVED_PLACES, state.savedPlaces);
  },
  remove(pageid) {
    const id = Number(pageid);
    delete state.saved[id];
    delete state.savedPlaces[id];
    storageSet(STORAGE_SAVED, state.saved);
    storageSet(STORAGE_SAVED_PLACES, state.savedPlaces);
  },
  count() { return Object.keys(state.saved).length; },
  /* Od najnowszego; dane z savedPlaces, a gdy ich brak (stary zapis) — z bieżącego feedu. */
  list() {
    return Object.keys(state.saved).map((key) => {
      const id = Number(key);
      const meta = state.savedPlaces[id] || {};
      const inFeed = state.places.find((p) => p.pageid === id);
      const title = meta.title || (inFeed && inFeed.title) || `Strona ${id}`;
      const lat = typeof meta.lat === 'number' ? meta.lat : (inFeed ? inFeed.lat : null);
      const lon = typeof meta.lon === 'number' ? meta.lon : (inFeed ? inFeed.lon : null);
      return { pageid: id, ts: state.saved[id], title, lat, lon, url: meta.url || wikiUrl(title) };
    }).sort((a, b) => b.ts - a.ts);
  },
};

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
let seenTimer = 0;
let seenCandidate = null;
let panelReturnFocus = null;
const burstTimers = new WeakMap();
const likeCountCache = new Map();

function cacheElements() {
  ['app', 'start-screen', 'around-screen', 'topbar', 'my-places', 'my-places-count', 'change-place', 'loading-state',
    'empty-state', 'empty-text', 'error-state', 'error-text', 'retry-button', 'feed', 'start-button', 'geo-message',
    'place-toggle', 'place-form', 'place-input', 'place-submit', 'place-message', 'start-chips-slot', 'bar-chips-slot',
    'empty-chips-slot', 'toast', 'my-places-panel', 'panel-close', 'panel-empty', 'panel-list', 'card-template',
    'ring-template', 'tail-template', 'end-template', 'saved-row-template'].forEach((id) => { els[id] = $(id); });
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
  if (s === 'start') {
    clearFeed();
    const btn = els['start-button'];
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Pokaż, co jest wokół';
  }
  updateSavedBadge();
}

function clearFeed() {
  if (observer) { observer.disconnect(); observer = null; }
  window.clearTimeout(seenTimer);
  seenCandidate = null;
  cardsById.clear();
  els.feed.replaceChildren();
  els.feed.scrollTop = 0;   // ukryty feed pamięta ostatnie przewinięcie (Chromium) — po przebudowie zaczynamy od góry
  els.feed.removeAttribute('aria-busy');
  renderedCount = 0;
  tailEl = null;
  tailKind = null;
}

/* ---------- Ładowanie: pierścienie ----------
   Pierścień = jedno zapytanie geosearch dla promienia z RADII. Pierwszy to chip użytkownika; każdy następny
   dociągamy automatycznie, gdy do końca załadowanego feedu zostają ≤ 2 karty. Z odpowiedzi odpada to, co już jest
   w feedzie (po pageid); reszta trafia do feedu w losowej kolejności: najpierw miejsca jeszcze nieobejrzane. */

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
  state.items = [];      // state.details zostaje: ta sama strona nie jest pobierana ponownie po zmianie promienia
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
    const inFeed = new Set(state.places.map((p) => p.pageid));
    ring.places = orderRing(list.filter((p) => !inFeed.has(p.pageid)));
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

  ring.places.forEach((p) => {
    state.places.push(p);
    state.items.push({ type: 'place', place: p, ring });
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
    updateSummaryCards();
    if (wasAtTail && ring.places.length) {
      // Użytkownik czekał na karcie ładowania: nowe karty wchodzą w to samo miejsce (overflow-anchor: none).
      renderUpTo(firstNewItem + 1);
      const el = els.feed.children[firstNewItem];
      if (el) els.feed.scrollTo({ top: el.offsetTop, behavior: 'auto' });
      state.index = firstNewItem;
      prefetch(firstNewItem);
      scheduleSeen(state.items[firstNewItem]);
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
  updateSummaryCards();
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

/* ---------- Feed ---------- */

function buildFeed() {
  clearFeed();
  observer = new IntersectionObserver(onIntersect, { root: els.feed, threshold: 0.6 });
  state.index = 0;
  renderAround(0);
  renderTail();
  els.feed.scrollTop = 0;
  prefetch(0);
  scheduleSeen(state.items[0]);
  maybeLoadNextRing();
}

function onIntersect(entries) {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    state.index = Number(entry.target.dataset.index);
    scheduleSeen(state.items[state.index]);
    prefetch(state.index);
    renderAround(state.index);
    maybeLoadNextRing();
  });
}

/* Karta aktywna przez SEEN_DELAY → obejrzana; szybkie przewinięcie się nie liczy. */
function scheduleSeen(item) {
  window.clearTimeout(seenTimer);
  seenCandidate = null;
  if (!item || item.type !== 'place' || seenSet.has(item.place.pageid)) return;
  seenCandidate = item.place.pageid;
  seenTimer = window.setTimeout(() => {
    if (state.screen === 'feed' && seenCandidate) markSeen(seenCandidate);
    seenCandidate = null;
  }, SEEN_DELAY);
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

/* ---------- Karta miejsca ---------- */

function createCard(place, index) {
  const card = els['card-template'].content.firstElementChild.cloneNode(true);
  card.dataset.index = String(index);
  card.dataset.pageid = String(place.pageid);
  card.setAttribute('aria-label', place.title);

  const hue = hueFromTitle(place.title);
  card.querySelector('.card-placeholder').style.setProperty('--ph', `hsl(${hue} 34% 26%)`);
  card.querySelector('.card-letter').textContent = initialOf(place.title);
  card.querySelector('.card-distance-text').textContent = formatDistance(place.dist);
  card.querySelector('.card-title').textContent = place.title;
  card.querySelector('.card-extract').classList.add('is-skeleton');
  const link = card.querySelector('.card-link');
  link.href = wikiUrl(place.title);
  link.setAttribute('aria-label', `Czytaj w Wikipedii: ${place.title}`);
  const nav = card.querySelector('.card-navigate');
  nav.href = navigateUrl(place.lat, place.lon);   // geosearch zawsze podaje lat/lon; REST może je później doprecyzować
  nav.setAttribute('aria-label', `Nawiguj do: ${place.title}`);

  card.querySelector('.btn-like').addEventListener('click', () => toggleLike(place.pageid));
  card.querySelector('.btn-save').addEventListener('click', () => toggleSave(place.pageid));
  card.querySelector('.card-retry').addEventListener('click', () => ensureDetails(place, { force: true }));
  applyToggles(card, place.pageid);
  if (likeCountCache.has(place.pageid)) renderLikeCount(place.pageid, likeCountCache.get(place.pageid));
  attachGestures(card, place.pageid);
  return card;
}

/* Stan przycisków „Zapisz” / „Lubię” na karcie (aria-pressed + etykieta + wypełniona ikona przez CSS). */
function applyToggles(card, pageid) {
  const liked = likes.isLiked(pageid);
  const isSaved = saved.isSaved(pageid);
  const likeBtn = card.querySelector('.btn-like');
  likeBtn.setAttribute('aria-pressed', liked ? 'true' : 'false');
  likeBtn.querySelector('.btn-label').textContent = liked ? 'Lubisz' : 'Lubię';
  const saveBtn = card.querySelector('.btn-save');
  saveBtn.setAttribute('aria-pressed', isSaved ? 'true' : 'false');
  saveBtn.querySelector('.btn-label').textContent = isSaved ? 'Zapisane' : 'Zapisz';
  card.classList.toggle('is-liked', liked);
  card.classList.toggle('is-saved', isSaved);
}

/* Wspólny licznik polubień (gdy kiedyś będzie): pokazujemy tylko znane wartości. */
function formatCount(n) {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1).replace('.', ',')} tys.`;
}
function renderLikeCount(pageid, n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return;
  likeCountCache.set(Number(pageid), n);
  const card = cardsById.get(Number(pageid));
  if (!card) return;
  const el = card.querySelector('.like-count');
  el.textContent = formatCount(n);
  el.hidden = false;
}
function requestLikeCounts(pageids) {
  const missing = pageids.filter((id) => !likeCountCache.has(id));
  if (!missing.length) return;
  likes.counts(missing).then((map) => { if (map && typeof map.forEach === 'function') map.forEach((n, id) => renderLikeCount(id, n)); }).catch(() => {});
}

/* Serce na całą kartę: po podwójnym stuknięciu i przesunięciu w prawo. */
function burstHeart(card) {
  card.classList.remove('is-burst');
  void card.offsetWidth;   // restart animacji
  card.classList.add('is-burst');
  window.clearTimeout(burstTimers.get(card));
  burstTimers.set(card, window.setTimeout(() => card.classList.remove('is-burst'), BURST_DURATION));
}

/* ---------- Polubienia i zapisywanie ---------- */

function toggleLike(pageid) {
  const id = Number(pageid);
  const on = likes.toggle(id);
  syncLikeUi(id);
  return on;
}

/* Gest (podwójne stuknięcie, przesunięcie w prawo): zawsze „lubię”, nigdy nie cofa polubienia. */
function likeFromGesture(pageid, card) {
  const id = Number(pageid);
  if (!likes.isLiked(id)) { likes.toggle(id); syncLikeUi(id); }
  if (card) burstHeart(card);
}

function syncLikeUi(pageid) {
  const card = cardsById.get(Number(pageid));
  if (card) applyToggles(card, Number(pageid));
  updateSummaryCards();
}

function placeInfo(id) {
  const place = state.places.find((p) => p.pageid === id);
  if (!place) return null;
  const d = state.details[id];
  const ready = d && d.status === 'ready';
  const coords = ready && d.coords ? d.coords : { lat: place.lat, lon: place.lon };
  return { title: place.title, lat: coords.lat, lon: coords.lon, url: ready && d.url ? d.url : wikiUrl(place.title) };
}

function toggleSave(pageid) {
  const id = Number(pageid);
  if (saved.isSaved(id)) {
    saved.remove(id);
  } else {
    const info = placeInfo(id);
    if (!info) return false;
    saved.add(id, info);
  }
  syncSaveUi(id);
  return saved.isSaved(id);
}

function syncSaveUi(pageid) {
  const card = cardsById.get(Number(pageid));
  if (card) applyToggles(card, Number(pageid));
  updateSavedBadge();
  updateSummaryCards();
  if (state.panelOpen) renderPanel();
}

function updateSavedBadge() {
  if (!els['my-places']) return;
  const n = saved.count();
  const badge = els['my-places-count'];
  badge.textContent = String(n);
  badge.hidden = n === 0;
  els['my-places'].setAttribute('aria-label', n ? `Moje miejsca, zapisanych: ${n}` : 'Moje miejsca');
}

/* ---------- Panel „Moje miejsca” ---------- */

function openPanel() {
  if (state.panelOpen) return;
  state.panelOpen = true;
  panelReturnFocus = document.activeElement;
  renderPanel();
  els['my-places-panel'].hidden = false;
  els['my-places'].setAttribute('aria-expanded', 'true');
  els['panel-close'].focus();
}

function closePanel() {
  if (!state.panelOpen) return;
  state.panelOpen = false;
  els['my-places-panel'].hidden = true;
  els['my-places'].setAttribute('aria-expanded', 'false');
  const back = panelReturnFocus;
  panelReturnFocus = null;
  if (back && typeof back.focus === 'function' && document.contains(back) && !back.hidden) back.focus();
  else els['my-places'].focus();
}

function renderPanel() {
  const list = saved.list();
  els['panel-empty'].hidden = list.length > 0;
  els['panel-list'].replaceChildren(...list.map(createSavedRow));
}

function createSavedRow(entry) {
  const row = els['saved-row-template'].content.firstElementChild.cloneNode(true);
  row.dataset.pageid = String(entry.pageid);
  row.querySelector('.saved-title').textContent = entry.title;
  const hasCoords = typeof entry.lat === 'number' && typeof entry.lon === 'number';
  const dist = row.querySelector('.saved-distance');
  if (hasCoords && state.center) {
    dist.hidden = false;
    dist.querySelector('.saved-distance-text').textContent = formatDistance(haversine(state.center, entry));
  } else {
    dist.hidden = true;
  }
  const read = row.querySelector('.saved-read');
  read.href = entry.url;
  read.setAttribute('aria-label', `Czytaj w Wikipedii: ${entry.title}`);
  const nav = row.querySelector('.saved-navigate');
  if (hasCoords) {
    nav.href = navigateUrl(entry.lat, entry.lon);
    nav.setAttribute('aria-label', `Nawiguj do: ${entry.title}`);
  } else {
    nav.hidden = true;
  }
  const remove = row.querySelector('.saved-remove');
  remove.setAttribute('aria-label', `Usuń: ${entry.title}`);
  remove.addEventListener('click', () => {
    const rows = [...els['panel-list'].children];
    const at = rows.indexOf(row);
    toggleSave(entry.pageid);
    // Fokus zostaje w panelu: na następnym „Usuń”, a gdy lista się skończyła — na przycisku zamknięcia.
    const next = els['panel-list'].children[Math.min(at, els['panel-list'].children.length - 1)];
    (next ? next.querySelector('.saved-remove') : els['panel-close']).focus();
  });
  return row;
}

function focusablesIn(root) {
  return [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.hidden && !el.closest('[hidden]') && el.offsetParent !== null);
}

/* Escape zamyka; Tab krąży po panelu (prosta pułapka fokusu). */
function onPanelKeydown(e) {
  if (!state.panelOpen) return;
  if (e.key === 'Escape') { e.preventDefault(); closePanel(); return; }
  if (e.key !== 'Tab') return;
  const items = focusablesIn(els['my-places-panel']);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const inside = els['my-places-panel'].contains(active);
  if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); }
}

/* ---------- Karty podsumowań: pierścień i koniec ---------- */

function createRingCard(ring, index) {
  const el = els['ring-template'].content.firstElementChild.cloneNode(true);
  el.dataset.index = String(index);
  el.dataset.radius = String(ring.radius);
  el.querySelector('.ring-share').addEventListener('click', () => share(shareTextFor(ring.radius, ring.places)));
  updateRingCard(el, ring);
  return el;
}

/* „Przejrzałeś 16 miejsc, polubiłeś 3, zapisałeś 2” (część o zapisanych tylko, gdy coś zapisano). */
function reviewStats(places) {
  let liked = 0;
  let savedCount = 0;
  places.forEach((p) => {
    if (likes.isLiked(p.pageid)) liked += 1;
    if (saved.isSaved(p.pageid)) savedCount += 1;
  });
  const n = places.length;
  let text = `Przejrzałeś ${n} ${pluralPlaces(n)}, polubiłeś ${liked}`;
  if (savedCount) text += `, zapisałeś ${savedCount}`;
  return { n, liked, saved: savedCount, text };
}

/* Promień następnego pierścienia, który coś wnosi (albo dopiero się ładuje / czeka w kolejce). */
function nextRadiusAfter(ring) {
  for (const r of state.rings) {
    if (r.index <= ring.index) continue;
    if (r.status !== 'ready' || r.places.length) return r.radius;
  }
  return RADII[state.ringIndex + 1] || null;
}

/* Pasek do 3 ostatnio polubionych miejsc: miniatura z REST albo placeholder z pierwszą literą. */
function renderLikedStrip(el, places) {
  const strip = el.querySelector('.liked-strip');
  const likedPlaces = places.filter((p) => likes.isLiked(p.pageid))
    .sort((a, b) => (state.liked[b.pageid] || 0) - (state.liked[a.pageid] || 0))
    .slice(0, 3);
  strip.replaceChildren();
  strip.hidden = likedPlaces.length === 0;
  if (!likedPlaces.length) return;
  likedPlaces.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'liked-thumb';
    li.title = p.title;
    const d = state.details[p.pageid];
    const src = d && d.status === 'ready' ? (d.thumb || d.image) : null;
    if (src) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.src = src;
      img.addEventListener('error', () => { img.remove(); li.textContent = initialOf(p.title); }, { once: true });
      li.appendChild(img);
    } else {
      li.style.setProperty('--ph', `hsl(${hueFromTitle(p.title)} 34% 30%)`);
      li.textContent = initialOf(p.title);
    }
    strip.appendChild(li);
  });
  strip.setAttribute('aria-label', `Polubione: ${likedPlaces.map((p) => p.title).join(', ')}`);
}

function updateRingCard(el, ring) {
  const radiusText = formatRadius(ring.radius);
  const title = el.querySelector('.ring-title');
  const line = el.querySelector('.ring-line');
  const shareBtn = el.querySelector('.ring-share');
  el.querySelector('.ring-eyebrow').textContent = `Promień ${radiusText}`;
  if (ring.places.length === 0) {
    title.textContent = `W promieniu ${radiusText} nic nie ma`;
    line.textContent = 'Wikipedia nie zna tu żadnego miejsca — szukam dalej.';
    shareBtn.hidden = true;
    el.querySelector('.liked-strip').hidden = true;
  } else {
    title.textContent = `To wszystko w promieniu ${radiusText}`;
    line.textContent = reviewStats(ring.places).text;
    shareBtn.hidden = false;
    renderLikedStrip(el, ring.places);
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
  end.querySelector('[data-testid="share-button"]').addEventListener('click', () => share(shareTextFor(RADII[RADII.length - 1], state.places)));
  end.querySelector('.end-change').addEventListener('click', changePlace);
  end.querySelector('.end-restart').addEventListener('click', restart);
  return end;
}

function updateEndCard() {
  if (!tailEl || tailKind !== 'end') return;
  const maxText = formatRadius(RADII[RADII.length - 1]);
  tailEl.querySelector('.end-eyebrow').textContent = `Promień ${maxText}`;
  tailEl.querySelector('.end-title').textContent = `To wszystko, co Wikipedia zna w promieniu ${maxText}`;
  tailEl.querySelector('.end-sub').textContent = reviewStats(state.places).text;
  renderLikedStrip(tailEl, state.places);
}

function updateSummaryCards() {
  if (state.screen !== 'feed') return;
  updateRingCards();
  updateEndCard();
}

/* „Od nowa”: zapomina, co było obejrzane (polubienia i zapisane zostają) i losuje feed od pierścienia startowego. */
function restart() {
  clearSeen();
  if (state.center) loadAround(state.center.lat, state.center.lon, state.radius, state.center.label);
}

/* ---------- Szczegóły kart ---------- */

/* Pobieranie szczegółów: leniwie, dla bieżącej karty i PREFETCH_AHEAD następnych kart miejsc. */
function prefetch(fromItem) {
  const ids = [];
  for (let i = Math.max(0, fromItem); i < state.items.length && ids.length <= PREFETCH_AHEAD; i++) {
    const it = state.items[i];
    if (it.type !== 'place') continue;
    ensureDetails(it.place);
    ids.push(it.place.pageid);
  }
  requestLikeCounts(ids);
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
  if (likes.isLiked(pageid)) updateSummaryCards();   // miniatura do paska polubionych
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

/* ---------- Nawigacja po feedzie ---------- */

/* Przesunięcie w lewo: następny element feedu (karta miejsca, karta pierścienia albo ogon). */
function advanceFrom(card) {
  if (state.screen !== 'feed' || !card) return;
  const next = Number(card.dataset.index) + 1;
  let target;
  if (next < state.items.length) {
    renderUpTo(next + 1);
    target = els.feed.children[next];
  } else {
    renderUpTo(state.items.length);   // ogon ma stać na swoim ostatecznym miejscu, zanim do niego przewiniemy
    target = tailEl || els.feed.lastElementChild;
  }
  if (!target || target === card) return;
  scrollToCard(target);
  if (typeof target.focus === 'function') target.focus({ preventScroll: true });
}

function scrollToCard(el) {
  if (!el) return;
  els.feed.scrollTo({ top: el.offsetTop, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

/* ---------- Gesty na karcie ----------
   Pointer Events: po SWIPE_LOCK px decydujemy, czy ruch jest poziomy. Pionowy zostawiamy przeglądarce
   (touch-action: pan-y na karcie → przy przewijaniu dostajemy pointercancel). Poziomy przechwytujemy:
   karta jedzie za palcem i lekko się przechyla, etykieta „Lubię” / „Dalej” wyłania się proporcjonalnie do progu.
   Puszczenie za progiem w prawo = polubienie (serce), w lewo = następna karta; przed progiem = powrót na miejsce.
   Podwójne stuknięcie w zdjęcie (poza przyciskami i linkami) = polubienie. */
function attachGestures(card, pageid) {
  const labelLike = card.querySelector('.swipe-label-like');
  const labelSkip = card.querySelector('.swipe-label-skip');
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let mode = null; // null | 'h' | 'v'
  let swiped = false;
  let lastTap = 0;

  const reset = () => {
    card.classList.remove('is-dragging');
    card.style.transform = '';
    labelLike.style.opacity = '0';
    labelSkip.style.opacity = '0';
    pointerId = null;
    mode = null;
    dx = 0;
  };

  card.addEventListener('pointerdown', (e) => {
    swiped = false;
    if (pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.target.closest('button, a, input')) return;
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
    labelLike.style.opacity = dx > 0 ? String(strength) : '0';
    labelSkip.style.opacity = dx < 0 ? String(strength) : '0';
  });

  const finish = (e) => {
    if (e.pointerId !== pointerId) return;
    const horizontal = mode === 'h';
    const decided = horizontal && e.type === 'pointerup' && Math.abs(dx) >= SWIPE_THRESHOLD;
    const right = dx > 0;
    reset();
    if (horizontal) swiped = true;   // click po przeciągnięciu nie jest stuknięciem
    if (!decided) return;
    if (right) likeFromGesture(pageid, card);
    else advanceFrom(card);
  };
  card.addEventListener('pointerup', finish);
  card.addEventListener('pointercancel', finish);
  // Dotyk jest niejawnie przechwytywany przez element pod palcem (np. .card-shade); nasze setPointerCapture
  // zwalnia tamto przechwycenie i lostpointercapture bąbelkuje do karty — to nie jest koniec gestu.
  card.addEventListener('lostpointercapture', (e) => {
    if (e.target !== card || e.pointerId !== pointerId) return;
    reset();
  });

  card.addEventListener('click', (e) => {
    if (e.target.closest('button, a, input')) return;
    if (swiped) { swiped = false; return; }
    const now = performance.now();
    if (now - lastTap < DOUBLE_TAP) {
      lastTap = 0;
      likeFromGesture(pageid, card);
    } else {
      lastTap = now;
    }
  });
}

/* ---------- Udostępnianie ---------- */

function shareTextFor(radius, places) {
  const url = location.href.split('#')[0];
  const { n, liked } = reviewStats(places);
  return `Odkryłem ${n} ${pluralPlaces(n)} w promieniu ${formatRadius(radius)} od siebie, ${liked} z nich polubiłem. Sprawdź swoją okolicę: ${url}`;
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
  closePanel();
  state.screen = 'start';
  state.rings = [];
  state.ringIndex = -1;
  state.feedDone = false;
  state.places = [];
  state.items = [];
  state.details = {};
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
  loadPersisted();
  const savedRadius = Number(storageGet(STORAGE_RADIUS, DEFAULT_RADIUS));
  state.radius = RADII.includes(savedRadius) ? savedRadius : DEFAULT_RADIUS;
  buildChips();

  els['start-button'].addEventListener('click', locate);
  els['place-toggle'].addEventListener('click', () => openPlaceForm(true));
  els['place-form'].addEventListener('submit', submitPlace);
  els['retry-button'].addEventListener('click', () => { if (lastAction) lastAction(); });
  els['change-place'].addEventListener('click', changePlace);
  els['my-places'].addEventListener('click', () => (state.panelOpen ? closePanel() : openPanel()));
  els['panel-close'].addEventListener('click', closePanel);
  els['my-places-panel'].addEventListener('click', (e) => { if (e.target === els['my-places-panel']) closePanel(); });
  document.addEventListener('keydown', onPanelKeydown);
  window.addEventListener('popstate', () => {
    historyPushed = false;
    if (state.screen !== 'start') showStart();
  });

  // Rzeczywista wysokość paska (z wcięciem systemowym) jako zmienna CSS dla kart podsumowań.
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      const h = els.topbar.offsetHeight;
      if (h > 0) els.app.style.setProperty('--topbar-h', `${h}px`);
    }).observe(els.topbar);
  }

  render();
  window.WM = { state, loadAround, loadNextRing, like: toggleLike, save: toggleSave, markSeen, clearSeen, rng, likes, saved };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
