'use strict';

const $ = (id) => document.getElementById(id);

const DEFAULTS = { speed: 1, expressiveness: 0.667, rhythm: 0.8, pitch: 1 };
const MAX_TAKES = 40;
const PLAY_PATH = 'M7 4.5v15l13-7.5z';
const PAUSE_PATH = 'M7 5h4v14H7zM14 5h4v14h-4z';
const STOP_PATH = 'M6 6h12v12H6z';
const IDLE_STATUS = 'Type a line, choose a speaker, then press Generate voice.';

/** What the speaker line says when nothing is loaded in the player. */
function idleStatus() {
  const voice = state.config ? selectedVoice() : null;
  if (!voice) return IDLE_STATUS;
  return voice.kind === 'file'
    ? `Press Generate voice to hear ${voice.name}. Listen first, then download the audio.`
    : `Press Generate voice to hear ${voice.name}. Browser voices only play. Choose a studio voice to download audio.`;
}

const takeVoiceKey = (take) => (take.kind === 'file' ? `piper:${take.voiceId}` : `browser:${take.voiceUri}`);

const STARTERS = [
  'अरे भाई, तू फिर लेट? तेरा अलार्म भी अब तुझसे थक चुका है।',
  'डाइट कल से पक्का। आज बस एक आख़िरी समोसा, प्रॉमिस।',
  'मंडे को किसने बनाया? नाम बता, बस दो मिनट बात करनी है।',
  'भाई, प्लान तो बढ़िया है, बस पैसे, टाइम और हिम्मत की कमी है।',
];

// Open voices from the Piper voice collection. Sizes are used for the
// download progress line when the host does not report one.
const CATALOG = [
  { id: 'hi_IN-rohan-medium', name: 'Rohan', language: 'Hindi', gender: 'male', bytes: 62950044 },
  { id: 'hi_IN-pratham-medium', name: 'Pratham', language: 'Hindi', gender: 'male', bytes: 63516050 },
  { id: 'hi_IN-priyamvada-medium', name: 'Priyamvada', language: 'Hindi', gender: 'female', bytes: 63500000 },
  { id: 'en_US-ryan-medium', name: 'Ryan', language: 'English (US)', gender: 'male', bytes: 63200000 },
  { id: 'en_US-lessac-medium', name: 'Lessac', language: 'English (US)', gender: 'female', bytes: 63200000 },
].map((v) => {
  const [code, voiceName, quality] = v.id.split('-');
  // e.g. hi/hi_IN/rohan/medium/hi_IN-rohan-medium
  return { ...v, lang_code: code, path: `${code.slice(0, 2)}/${code}/${voiceName}/${quality}/${v.id}` };
});

const MAX_CHARS = 1500;
const VOICE_CACHE = 'dost-voices-v1';

const state = {
  config: { voices: CATALOG, maxChars: MAX_CHARS },
  saved: new Set(), // voices already stored in this browser
  browserVoices: [],
  busy: false,
  current: null, // the take loaded in the player
  speaking: false, // a browser voice is talking
  takes: [],
};

const el = {
  form: $('form'), text: $('text'), count: $('count'), go: $('go'), scriptHint: $('script-hint'),
  speaker: $('speaker'), speakerName: $('speaker-name'), avatar: $('avatar-letter'), status: $('speaker-status'),
  player: $('player'), play: $('play'), playIcon: $('play-icon'), seek: $('seek'), time: $('time'), download: $('download'),
  redo: $('redo-studio'), playerNote: $('player-note'),
  audio: $('audio'),
  voice: $('voice'), voiceHelp: $('voice-help'),
  speed: $('speed'), expressiveness: $('expressiveness'), rhythm: $('rhythm'), pitch: $('pitch'),
  takes: $('takes'), takesEmpty: $('takes-empty'), clearTakes: $('clear-takes'),
  notice: $('notice'), noticeTitle: $('notice-title'), noticeHint: $('notice-hint'),
};

const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;

// ------------------------------------------------------------ small utils

const fmtNumber = (n) => Number(n).toLocaleString('en-IN');

function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fileName(voiceName) {
  const slug = voiceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'voice';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `${slug}-${stamp}.wav`;
}

function remember(key, value) { try { localStorage.setItem(`dvs:${key}`, JSON.stringify(value)); } catch { /* private mode */ } }
function recall(key, fallback) {
  try { const raw = localStorage.getItem(`dvs:${key}`); return raw === null ? fallback : JSON.parse(raw); }
  catch { return fallback; }
}

function showNotice(title, hint) {
  el.noticeTitle.textContent = title;
  el.noticeHint.textContent = hint || '';
  el.notice.hidden = false;
}
function hideNotice() { el.notice.hidden = true; }
$('notice-close').addEventListener('click', hideNotice);

// ------------------------------------------------------- takes (IndexedDB)

const store = {
  db: null,
  memory: [],
  async open() {
    if (!('indexedDB' in window)) return;
    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('dost-voice-studio', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('takes', { keyPath: 'id', autoIncrement: true });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch { this.db = null; }
  },
  run(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('takes', mode);
      const req = fn(tx.objectStore('takes'));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  async all() {
    if (!this.db) return [...this.memory];
    try { return (await this.run('readonly', (s) => s.getAll())).sort((a, b) => b.createdAt - a.createdAt); }
    catch { return [...this.memory]; }
  },
  async add(take) {
    if (this.db) {
      try { take.id = await this.run('readwrite', (s) => s.add(take)); return take; } catch { /* fall through */ }
    }
    take.id = Date.now();
    this.memory.unshift(take);
    return take;
  },
  async remove(id) {
    this.memory = this.memory.filter((t) => t.id !== id);
    if (this.db) { try { await this.run('readwrite', (s) => s.delete(id)); } catch { /* ignore */ } }
  },
  async clear() {
    this.memory = [];
    if (this.db) { try { await this.run('readwrite', (s) => s.clear()); } catch { /* ignore */ } }
  },
};

const takeUrls = new Map();
function urlFor(take) {
  if (!takeUrls.has(take.id)) takeUrls.set(take.id, URL.createObjectURL(take.blob));
  return takeUrls.get(take.id);
}
function releaseUrl(id) {
  const url = takeUrls.get(id);
  if (url) { URL.revokeObjectURL(url); takeUrls.delete(id); }
}

function actionLink(label, handler, extra = {}) {
  const a = document.createElement('a');
  a.textContent = label;
  a.href = extra.href || '#';
  if (extra.download) a.download = extra.download;
  if (handler) a.addEventListener('click', (e) => { e.preventDefault(); handler(); });
  return a;
}

function renderTakes() {
  el.takes.replaceChildren();
  el.takesEmpty.hidden = state.takes.length > 0;
  el.clearTakes.hidden = state.takes.length === 0;
  for (const take of state.takes) {
    const li = document.createElement('li');
    li.className = 'take';
    li.dataset.current = String(state.current?.id === take.id);

    const text = document.createElement('p');
    text.className = 'take-text';
    text.textContent = take.text;

    const meta = document.createElement('p');
    meta.className = 'take-meta';
    const when = new Date(take.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    meta.textContent = `${take.voiceName}, ${when}`;

    const actions = document.createElement('p');
    actions.className = 'take-actions';
    actions.append(
      actionLink('Play', () => loadTake(take, true)),
      actionLink('Use this text', () => { el.text.value = take.text; updateScript(); el.text.focus(); }),
    );
    if (take.kind === 'file') actions.append(actionLink('Download', null, { href: urlFor(take), download: take.fileName }));
    actions.append(actionLink('Delete', async () => {
      await store.remove(take.id);
      if (state.current?.id === take.id) unloadPlayer();
      releaseUrl(take.id);
      state.takes = state.takes.filter((t) => t.id !== take.id);
      renderTakes();
    }));
    li.append(text, meta, actions);
    el.takes.append(li);
  }
}

el.clearTakes.addEventListener('click', async () => {
  await store.clear();
  for (const t of state.takes) releaseUrl(t.id);
  state.takes = [];
  unloadPlayer();
  renderTakes();
});

// ---------------------------------------------------------------- player

function setSpeakerState(next, status) {
  el.speaker.dataset.state = next;
  if (status !== undefined) el.status.textContent = status;
}

function setPlayButton(playing, kind) {
  el.playIcon.setAttribute('d', playing ? (kind === 'browser' ? STOP_PATH : PAUSE_PATH) : PLAY_PATH);
  el.play.setAttribute('aria-label', playing ? (kind === 'browser' ? 'Stop' : 'Pause') : 'Play');
  if (!state.busy && state.current) el.speaker.dataset.state = playing ? 'playing' : 'ready';
}

function stopEverything() {
  el.audio.pause();
  if (synth && (synth.speaking || synth.pending)) synth.cancel();
  state.speaking = false;
}

function speakBrowserTake(take) {
  if (!synth) return;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(take.text);
  const voice = synth.getVoices().find((v) => v.voiceURI === take.voiceUri);
  if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
  utterance.rate = take.settings.speed;
  utterance.pitch = take.settings.pitch;
  utterance.onstart = () => { state.speaking = true; setPlayButton(true, 'browser'); };
  const done = () => { if (state.current?.id === take.id) { state.speaking = false; setPlayButton(false, 'browser'); } };
  utterance.onend = done;
  utterance.onerror = done;
  synth.speak(utterance);
}

function loadTake(take, autoplay) {
  stopEverything();
  state.current = take;
  el.player.dataset.kind = take.kind;
  el.player.hidden = false;
  el.speakerName.textContent = take.voiceName;
  el.avatar.textContent = (take.voiceName.trim()[0] || 'D').toUpperCase();

  if (take.kind === 'file') {
    el.audio.src = urlFor(take);
    el.download.href = urlFor(take);
    el.download.download = take.fileName;
    el.seek.value = 0;
    setSpeakerState('ready', 'Voice generated. Listen to it, then press Download WAV to save it.');
    if (autoplay) el.audio.play().catch(() => { /* autoplay blocked; the play button still works */ });
  } else {
    el.audio.removeAttribute('src');
    const studio = studioVoiceForRedo();
    el.redo.hidden = !studio;
    el.playerNote.hidden = Boolean(studio);
    if (studio) el.redo.textContent = `Generate with ${studio.name} to download`;
    setSpeakerState('ready', studio
      ? 'This is a browser voice, which only plays. Generate it with a studio voice to get a file.'
      : 'This is a browser voice, which only plays. Download a studio voice in the Voice panel to save audio.');
    setPlayButton(false, 'browser');
    if (autoplay) speakBrowserTake(take);
  }
  renderTakes();
}

function unloadPlayer() {
  stopEverything();
  el.audio.removeAttribute('src');
  el.audio.load();
  state.current = null;
  el.player.hidden = true;
  updateVoiceUi();
  setSpeakerState('idle', idleStatus());
}

/** The studio voice a browser take can be redone with: the selected one, else the first installed. */
function studioVoiceForRedo() {
  const selected = selectedVoice();
  if (selected?.kind === 'file') return state.config.voices.find((v) => v.id === selected.id);
  return state.config.voices[0] || null;
}

/** Keeps the player in step with the Speaker menu: a take from another voice is put away. */
function syncPlayerWithVoice() {
  if (state.busy) return;
  if (state.current && takeVoiceKey(state.current) !== el.voice.value) unloadPlayer();
  else if (!state.current) setSpeakerState('idle', idleStatus());
}

function syncTime() {
  const { currentTime, duration } = el.audio;
  el.time.textContent = `${fmtTime(currentTime)} / ${fmtTime(duration)}`;
  if (Number.isFinite(duration) && duration > 0 && !el.seek.matches(':active')) {
    el.seek.value = Math.round((currentTime / duration) * 1000);
  }
}

el.play.addEventListener('click', () => {
  const take = state.current;
  if (!take) return;
  if (take.kind === 'browser') {
    if (state.speaking) { synth.cancel(); state.speaking = false; setPlayButton(false, 'browser'); }
    else speakBrowserTake(take);
  } else if (el.audio.paused) el.audio.play();
  else el.audio.pause();
});
el.seek.addEventListener('input', () => {
  if (Number.isFinite(el.audio.duration)) el.audio.currentTime = (el.seek.value / 1000) * el.audio.duration;
});
el.audio.addEventListener('timeupdate', syncTime);
el.audio.addEventListener('loadedmetadata', syncTime);
el.audio.addEventListener('play', () => setPlayButton(true, 'file'));
el.audio.addEventListener('pause', () => setPlayButton(false, 'file'));
el.audio.addEventListener('ended', () => setPlayButton(false, 'file'));

// ---------------------------------------------------------------- voices

/** The voice chosen in the Speaker menu, as { kind, id, name, langCode }. */
function selectedVoice() {
  const value = el.voice.value || '';
  if (value.startsWith('piper:')) {
    const v = state.config.voices.find((x) => `piper:${x.id}` === value);
    return v ? { kind: 'file', id: v.id, name: v.name, langCode: v.lang_code || '' } : null;
  }
  if (value.startsWith('browser:')) {
    const v = state.browserVoices.find((x) => `browser:${x.voiceURI}` === value);
    return v ? { kind: 'browser', id: v.voiceURI, name: v.name.replace(/\s*\(.*\)$/, ''), langCode: v.lang } : null;
  }
  return null;
}

function loadBrowserVoices() {
  if (!synth) return [];
  const rank = (v) => (v.lang.toLowerCase().startsWith('hi') ? 0 : v.lang.toLowerCase() === 'en-in' ? 1 : 2);
  return synth.getVoices()
    .filter((v) => /^(hi|en)/i.test(v.lang))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function option(value, label) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  return opt;
}

function describe(v) { return [v.name, v.language, v.gender].filter(Boolean).join(', '); }

function renderVoices(preferred) {
  const previous = preferred || el.voice.value;
  el.voice.replaceChildren();

  if (state.config.voices.length) {
    const group = document.createElement('optgroup');
    group.label = 'Studio voices: natural, with download';
    group.append(...state.config.voices.map((v) => option(`piper:${v.id}`, describe(v))));
    el.voice.append(group);
  }
  if (state.browserVoices.length) {
    const group = document.createElement('optgroup');
    group.label = 'Browser voices: instant, play only';
    group.append(...state.browserVoices.map((v) => option(`browser:${v.voiceURI}`, `${v.name} (${v.lang})`)));
    el.voice.append(group);
  }
  if (!el.voice.options.length) el.voice.append(option('', 'No voices yet'));

  if ([...el.voice.options].some((o) => o.value === previous)) el.voice.value = previous;

  updateVoiceUi();
}

function updateVoiceUi() {
  const voice = selectedVoice();
  const browser = voice?.kind === 'browser';
  $('expressiveness-row').hidden = browser;
  $('rhythm-row').hidden = browser;
  $('pitch-row').hidden = !browser;

  $('text-label').textContent = voice ? `What should ${voice.name} say?` : 'What should your dost say?';
  if (!state.current) {
    el.speakerName.textContent = voice ? voice.name : 'Your dost';
    el.avatar.textContent = voice ? voice.name[0].toUpperCase() : 'D';
  }

  let help = '';
  if (browser) {
    help = 'Browser voices play straight away but cannot be saved as a file.';
  } else if (voice && !state.saved.has(voice.id)) {
    help = `The first time you use ${voice.name}, the voice and speech engine download to this device (about 100 MB). After that it starts quickly.`;
  }
  el.voiceHelp.textContent = help;
  el.voiceHelp.hidden = !help;
  updateScript();
}

el.voice.addEventListener('change', () => { updateVoiceUi(); syncPlayerWithVoice(); saveSettings(); });

el.redo.addEventListener('click', () => {
  const take = state.current;
  const studio = studioVoiceForRedo();
  if (!take || !studio) return;
  el.text.value = take.text;
  el.voice.value = `piper:${studio.id}`;
  updateVoiceUi();
  saveSettings();
  el.form.requestSubmit();
});

// -------------------------------------------------------------- settings

function updateOutputs() {
  $('speed-out').textContent = `${Number(el.speed.value).toFixed(2)}x`;
  $('expressiveness-out').textContent = `${Math.round(el.expressiveness.value * 100)}%`;
  $('rhythm-out').textContent = `${Math.round((el.rhythm.value / 1.2) * 100)}%`;
  $('pitch-out').textContent = `${Number(el.pitch.value).toFixed(2)}`;
}

function applySliders(values) {
  for (const key of Object.keys(DEFAULTS)) el[key].value = values[key] ?? DEFAULTS[key];
  updateOutputs();
}

function saveSettings() {
  remember('settings', {
    voice: el.voice.value,
    speed: Number(el.speed.value), expressiveness: Number(el.expressiveness.value),
    rhythm: Number(el.rhythm.value), pitch: Number(el.pitch.value),
  });
}

for (const key of Object.keys(DEFAULTS)) el[key].addEventListener('input', () => { updateOutputs(); saveSettings(); });
$('reset').addEventListener('click', () => { applySliders(DEFAULTS); saveSettings(); });

// ---------------------------------------------------------------- script

function updateScript() {
  const text = el.text.value;
  const n = text.trim().length;
  const max = state.config.maxChars;
  el.count.textContent = `${fmtNumber(n)} / ${fmtNumber(max)}`;
  el.count.dataset.over = String(n > max);

  // A Hindi studio voice reading Roman-script text mispronounces it.
  const voice = state.config ? selectedVoice() : null;
  const latin = (text.match(/[a-z]/gi) || []).length;
  const devanagari = (text.match(/[ऀ-ॿ]/g) || []).length;
  el.scriptHint.hidden = !(voice?.kind === 'file' && voice.langCode.startsWith('hi') && latin > 8 && latin > devanagari);
}

el.text.addEventListener('input', () => { updateScript(); remember('draft', el.text.value); });
el.text.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); el.form.requestSubmit(); }
});

function renderStarters() {
  $('starters').replaceChildren(...STARTERS.map((line) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.lang = 'hi';
    btn.textContent = line;
    btn.addEventListener('click', () => { el.text.value = line; updateScript(); remember('draft', line); el.text.focus(); });
    li.append(btn);
    return li;
  }));
}

// -------------------------------------------------------------- generate

let worker = null;
let nextRequest = 0;
const waiting = new Map();

function startWorker() {
  worker = new Worker('tts-worker.js');
  worker.onmessage = (event) => {
    const message = event.data;
    const job = waiting.get(message.id);
    if (!job) return;
    if (message.type === 'progress') job.onProgress(message);
    else if (message.type === 'done') { waiting.delete(message.id); job.resolve(message.wav); }
    else if (message.type === 'error') { waiting.delete(message.id); job.reject(new Error(message.message)); }
  };
  worker.onerror = (event) => {
    for (const job of waiting.values()) job.reject(new Error(event.message || 'The speech engine stopped unexpectedly.'));
    waiting.clear();
    worker = null; // a fresh one is started on the next try
  };
}

/** Generates speech in the background worker and resolves with WAV bytes. */
function synthesize(voice, text, settings, onProgress) {
  if (!worker) startWorker();
  const id = ++nextRequest;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, onProgress });
    worker.postMessage({ type: 'generate', id, voice: { id: voice.id, path: voice.path, bytes: voice.bytes }, text, ...settings, config: window.DOST_CONFIG });
  });
}

const toMb = (bytes) => Math.round(bytes / 1048576);

function progressLine(voice, message) {
  if (message.stage === 'engine') return 'Getting the speech engine ready.';
  if (message.stage === 'voice') return `Downloading ${voice.name}: ${toMb(message.received)} of ${toMb(message.total)} MB. This happens once on this device.`;
  if (message.stage === 'loading') return `Loading ${voice.name}.`;
  if (message.stage === 'speaking') return message.parts > 1 ? `Generating part ${message.part} of ${message.parts}.` : 'Generating the voice.';
  return 'Working.';
}

async function refreshSavedVoices() {
  try {
    const cache = await caches.open(VOICE_CACHE);
    const urls = (await cache.keys()).map((request) => request.url);
    state.saved = new Set(CATALOG.filter((v) => urls.some((url) => url.endsWith(`${v.id}.onnx`))).map((v) => v.id));
  } catch { state.saved = new Set(); }
}

async function addTake(take) {
  const saved = await store.add({ ...take, createdAt: Date.now() });
  state.takes.unshift(saved);
  for (const old of state.takes.splice(MAX_TAKES)) { releaseUrl(old.id); store.remove(old.id); }
  return saved;
}

el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.busy || !state.config) return;

  const text = el.text.value.trim();
  const max = state.config.maxChars;
  if (!text) { showNotice('Type something for the voice to say.'); el.text.focus(); return; }
  if (text.length > max) { showNotice(`The text is longer than ${fmtNumber(max)} characters.`, 'Split it into shorter parts and generate each one.'); return; }

  const voice = selectedVoice();
  if (!voice) {
    showNotice('Choose a speaker first.');
    return;
  }

  hideNotice();
  stopEverything();

  if (voice.kind === 'browser') {
    const take = await addTake({
      kind: 'browser', text, chars: text.length, voiceUri: voice.id, voiceName: voice.name,
      settings: { speed: Number(el.speed.value), pitch: Number(el.pitch.value) },
    });
    loadTake(take, true);
    return;
  }

  state.busy = true;
  el.go.disabled = true;
  el.go.textContent = 'Generating…';
  setSpeakerState('busy', 'Getting the speech engine ready.');

  try {
    const settings = { speed: Number(el.speed.value), expressiveness: Number(el.expressiveness.value), rhythm: Number(el.rhythm.value) };
    const full = state.config.voices.find((v) => v.id === voice.id);
    const wav = await synthesize(full, text, settings, (message) => setSpeakerState('busy', progressLine(full, message)));
    const blob = new Blob([wav], { type: 'audio/wav' });
    if (blob.size < 100) throw new Error('The engine returned an empty audio file.');
    if (!state.saved.has(voice.id)) { await refreshSavedVoices(); updateVoiceUi(); }
    const take = await addTake({
      kind: 'file', text, blob, chars: text.length, voiceId: voice.id, voiceName: voice.name,
      settings, fileName: fileName(voice.name),
    });
    state.busy = false;
    loadTake(take, true);
  } catch (err) {
    showNotice(err.message, err.hint);
    setSpeakerState(state.current ? 'ready' : 'idle', state.current ? 'That one failed. Your last take is still loaded.' : idleStatus());
  } finally {
    state.busy = false;
    el.go.disabled = false;
    el.go.textContent = 'Generate voice';
  }
});

// ------------------------------------------------------------------ boot

async function boot() {
  renderStarters();
  applySliders(DEFAULTS);

  if (typeof WebAssembly !== 'object' || !window.Worker) {
    showNotice('This browser cannot run the studio voices.', 'Try a current version of Chrome, Edge, Firefox or Safari. Browser voices may still work.');
  }
  await refreshSavedVoices();

  const saved = recall('settings', {});
  applySliders({ ...DEFAULTS, ...saved });
  el.text.value = recall('draft', '');

  state.browserVoices = loadBrowserVoices();
  renderVoices(saved.voice);
  if (synth) {
    // Browsers often fill the voice list a moment after the page loads.
    synth.addEventListener('voiceschanged', () => {
      state.browserVoices = loadBrowserVoices();
      renderVoices(el.voice.value || saved.voice);
      syncPlayerWithVoice();
    });
  }

  await store.open();
  state.takes = (await store.all()).filter((t) => t.kind === 'browser' || t.blob);
  renderTakes();
  syncPlayerWithVoice();
}

boot();
