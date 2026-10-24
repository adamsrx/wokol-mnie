/* Wokół mnie — v0. Czysty JS (ES2020), bez zależności. */
'use strict';

const WIKI_BASE = 'https://pl.wikipedia.org';

const RADII = [500, 1000, 3000, 5000];
const DEFAULT_RADIUS = 1000;
const PREFETCH_AHEAD = 3;          // szczegóły pobierane dla bieżącej karty i 3 następnych
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
  radius: DEFAULT_RADIUS,
  places: [],        // wynik geosearch w kolejności z API (rosnąco po odległości)
  details: {},       // pageid -> { status: 'loading'|'ready'|'error', extract, image, thumb, url }
  answers: {},       // pageid -> true|false dla bieżącej listy
  index: 0,          // indeks karty w widoku (places.length = karta końcowa)
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

async function geosearch(lat, lon, radiusM) {
  const data = await fetchJson(apiUrl({
    action: 'query',
    list: 'geosearch',
    gscoord: `${lat}|${lon}`,
    gsradius: String(Math.min(10000, Math.max(10, Math.round(radiusM)))),
    gslimit: '100',
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

function cacheElements() {
  ['app', 'start-screen', 'around-screen', 'topbar', 'progress', 'change-place', 'loading-state', 'empty-state',
    'empty-text', 'error-state', 'error-text', 'retry-button', 'feed', 'start-button', 'geo-message', 'place-toggle',
    'place-form', 'place-input', 'place-submit', 'place-message', 'start-chips-slot', 'bar-chips-slot',
    'empty-chips-slot', 'toast', 'card-template', 'end-template'].forEach((id) => { els[id] = $(id); });
}

/* ---------- Chipsy promienia ---------- */

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
    els['empty-text'].textContent = `W promieniu ${formatRadius(state.radius)} Wikipedia nie zna żadnego miejsca. Zwiększ promień.`;
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
}

/* ---------- Ładowanie listy ---------- */

async function loadAround(lat, lon, radiusM = state.radius, label = null) {
  const radius = RADII.includes(radiusM) ? radiusM : state.radius;
  state.center = { lat, lon, label };
  if (radius !== state.radius) { state.radius = radius; storageSet(STORAGE_RADIUS, radius); syncChips(); }
  const token = ++loadToken;
  lastAction = () => loadAround(lat, lon, radius, label);

  if (!historyPushed) {
    try { history.pushState({ wm: 'around' }, ''); historyPushed = true; } catch { /* np. nietypowy kontekst osadzenia */ }
  }
  state.screen = 'loading';
  state.places = [];
  state.answers = {};   // state.details zostaje: ta sama strona nie jest pobierana ponownie po zmianie promienia
  state.index = 0;
  state.error = null;
  clearFeed();
  render();

  try {
    const places = await geosearch(lat, lon, radius);
    if (token !== loadToken) return state.places;  // w międzyczasie ruszyło nowe ładowanie
    state.places = places;
    state.answers = restoreAnswers(places);
    state.screen = places.length ? 'feed' : 'empty';
    render();
    if (places.length) buildFeed();
  } catch (err) {
    if (token !== loadToken) return state.places;
    state.error = describeError(err);
    state.screen = 'error';
    render();
  }
  return state.places;
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
  const frag = document.createDocumentFragment();
  state.places.forEach((place, i) => {
    const card = createCard(place, i);
    cardsById.set(place.pageid, card);
    frag.appendChild(card);
  });
  frag.appendChild(createEndCard());
  els.feed.appendChild(frag);

  observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      state.index = Number(entry.target.dataset.index);
      updateProgress();
      prefetch(state.index);
    });
  }, { root: els.feed, threshold: 0.6 });
  els.feed.querySelectorAll('.card').forEach((c) => observer.observe(c));

  // Odpowiedzi zapamiętane z poprzedniej sesji: zaznaczamy karty i startujemy od pierwszej bez odpowiedzi.
  let firstOpen = -1;
  state.places.forEach((p, i) => {
    if (typeof state.answers[p.pageid] === 'boolean') markCard(cardsById.get(p.pageid), state.answers[p.pageid]);
    else if (firstOpen < 0) firstOpen = i;
  });
  updateProgress();
  updateEndCard();
  if (firstOpen >= 0) prefetch(firstOpen);
  if (firstOpen !== 0) {
    const target = firstOpen > 0 ? els.feed.children[firstOpen] : els.feed.lastElementChild;
    els.feed.scrollTo({ top: target.offsetTop, behavior: 'auto' });
  }
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

  card.querySelectorAll('.btn-answer').forEach((btn) => {
    btn.addEventListener('click', () => answer(place.pageid, btn.dataset.known === 'true'));
  });
  card.querySelector('.card-retry').addEventListener('click', () => ensureDetails(place, { force: true }));
  attachSwipe(card, place.pageid);
  return card;
}

function createEndCard() {
  const end = els['end-template'].content.firstElementChild.cloneNode(true);
  end.dataset.index = String(state.places.length);
  end.querySelector('[data-testid="share-button"]').addEventListener('click', share);
  end.querySelector('.end-grow').addEventListener('click', () => {
    const next = RADII[RADII.indexOf(state.radius) + 1];
    if (next) setRadius(next, { reload: true });
  });
  end.querySelector('.end-again').addEventListener('click', resetAnswers);
  return end;
}

function knownCount() {
  return state.places.reduce((n, p) => n + (state.answers[p.pageid] === true ? 1 : 0), 0);
}
function answeredCount() {
  return state.places.reduce((n, p) => n + (typeof state.answers[p.pageid] === 'boolean' ? 1 : 0), 0);
}

function updateProgress() {
  const total = state.places.length;
  if (!total || state.screen !== 'feed') { els.progress.textContent = ''; return; }
  const current = Math.min(state.index + 1, total);
  els.progress.textContent = `${current} z ${total} · znasz ${knownCount()}`;
}

function updateEndCard() {
  const end = els.feed.querySelector('.card-end');
  if (!end) return;
  const total = state.places.length;
  const known = knownCount();
  const pct = total ? Math.round((known / total) * 100) : 0;
  const radiusText = formatRadius(state.radius);
  end.querySelector('.end-percent-num').textContent = String(pct);
  end.querySelector('.end-ring-value').style.setProperty('--pct', String(pct));
  end.querySelector('.end-meter').setAttribute('aria-label', `Znasz ${pct}% okolicy`);
  end.querySelector('.end-title').textContent = `Znasz ${pct}% okolicy w promieniu ${radiusText}`;
  end.querySelector('.end-sub').textContent = `Wiedziałeś o ${known} z ${total} ${total === 1 ? 'miejsca' : 'miejsc'}`;
  end.querySelector('.end-grow').hidden = RADII.indexOf(state.radius) === RADII.length - 1;
  end.querySelector('.end-again').hidden = answeredCount() === 0;
}

/* Pobieranie szczegółów: leniwie, dla bieżącej karty i PREFETCH_AHEAD następnych. */
function prefetch(from) {
  const last = Math.min(from + PREFETCH_AHEAD, state.places.length - 1);
  for (let i = Math.max(0, from); i <= last; i++) ensureDetails(state.places[i]);
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
  updateEndCard();
  window.setTimeout(() => advanceFrom(card), ADVANCE_DELAY);
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

/* Po odpowiedzi: do najbliższej następnej karty bez odpowiedzi, a gdy takiej nie ma — do karty końcowej. */
function advanceFrom(card) {
  if (state.screen !== 'feed') return;
  const start = card ? Number(card.dataset.index) + 1 : state.index + 1;
  let target = null;
  for (let i = start; i < state.places.length; i++) {
    if (typeof state.answers[state.places[i].pageid] !== 'boolean') { target = els.feed.children[i]; break; }
  }
  if (!target) target = els.feed.lastElementChild;
  scrollToCard(target);
  // Fokus wędruje z (już nieaktywnego) przycisku na następną kartę, żeby Tab szedł dalej, a nie od początku.
  if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
}

function scrollToCard(el) {
  if (!el) return;
  els.feed.scrollTo({ top: el.offsetTop, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

function resetAnswers() {
  const stored = storageGet(STORAGE_ANSWERS, {});
  const next = stored && typeof stored === 'object' ? stored : {};
  state.places.forEach((p) => { delete next[p.pageid]; });
  storageSet(STORAGE_ANSWERS, next);
  state.answers = {};
  cardsById.forEach((card) => unmarkCard(card));
  updateProgress();
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

function shareText() {
  const total = state.places.length;
  const pct = total ? Math.round((knownCount() / total) * 100) : 0;
  const url = location.href.split('#')[0];
  return `Znam ${pct}% miejsc w promieniu ${formatRadius(state.radius)} od siebie. Sprawdź swoją okolicę: ${url}`;
}

async function share() {
  const text = shareText();
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
  state.places = [];
  state.details = {};
  state.answers = {};
  state.index = 0;
  render();
  els['start-button'].focus();
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
  els['change-place'].addEventListener('click', () => {
    if (historyPushed) history.back(); // popstate pokaże ekran startowy
    else showStart();
  });
  window.addEventListener('popstate', () => {
    historyPushed = false;
    if (state.screen !== 'start') showStart();
  });

  // Rzeczywista wysokość paska (z wcięciem systemowym) jako zmienna CSS dla karty końcowej i pieczątki.
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      const h = els.topbar.offsetHeight;
      if (h > 0) els.app.style.setProperty('--topbar-h', `${h}px`);
    }).observe(els.topbar);
  }

  render();
  window.WM = { state, loadAround, answer };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
