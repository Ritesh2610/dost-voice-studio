'use strict';
/*
 * Dost Voice Studio - speech worker
 *
 * Turns text into audio entirely inside the browser:
 *   text -> phonemes (espeak-ng, WebAssembly) -> audio (Piper voice, ONNX Runtime Web) -> WAV
 * Nothing typed is sent to any server. Only the engine and voice files are
 * downloaded, and the voice is kept in this browser's storage for next time.
 */

const VOICE_CACHE = 'dost-voices-v1';
const SENTENCE_GAP_SECONDS = 0.25;

let cfg = null;
let phonemizer = null;
let phonemeLines = [];
let loaded = { id: null, session: null, config: null };

function post(message, transfer) { self.postMessage(message, transfer || []); }

function loadEngine() {
  try {
    if (!self.ort) {
      importScripts(cfg.ortBase + 'ort.wasm.min.js');
      self.ort.env.wasm.wasmPaths = cfg.ortBase;
      self.ort.env.wasm.numThreads = 1; // more threads need special server headers that free static hosts do not send
    }
    if (!self.createPiperPhonemize) importScripts(cfg.piperBase + 'piper_phonemize.js');
  } catch (error) {
    throw new Error('The speech engine could not be downloaded. Check your internet connection and try again.');
  }
}

async function getPhonemizer() {
  if (!phonemizer) {
    phonemizer = await self.createPiperPhonemize({
      print: (line) => phonemeLines.push(line),
      printErr: () => {},
      locateFile: (file) => cfg.piperBase + file,
    });
  }
  return phonemizer;
}

async function phonemize(text, espeakVoice) {
  const module = await getPhonemizer();
  phonemeLines = [];
  module.callMain(['-l', espeakVoice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
  const ids = [];
  for (const line of phonemeLines) {
    try { ids.push(...(JSON.parse(line).phoneme_ids || [])); } catch { /* not a result line */ }
  }
  return ids;
}

async function fetchWithCache(url, expectedBytes, onProgress) {
  let cache = null;
  try { cache = await caches.open(VOICE_CACHE); } catch { /* storage unavailable, e.g. private mode */ }
  const hit = cache && await cache.match(url);
  if (hit) return hit.arrayBuffer();

  let response;
  try { response = await fetch(url); }
  catch { throw new Error('The voice could not be downloaded. Check your internet connection and try again.'); }
  if (!response.ok) throw new Error(`The voice could not be downloaded (the voice library answered ${response.status}).`);

  const total = Number(response.headers.get('Content-Length')) || expectedBytes || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received, Math.max(total, received));
  }
  const blob = new Blob(chunks);
  if (cache) {
    try { await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream' } })); }
    catch { /* out of space: the voice still works for this visit */ }
  }
  return blob.arrayBuffer();
}

async function loadVoice(voice, requestId) {
  if (loaded.id === voice.id) return loaded;
  if (loaded.session) { try { await loaded.session.release(); } catch { /* ignore */ } }
  loaded = { id: null, session: null, config: null };

  const base = cfg.voiceBase + voice.path;
  const configBuffer = await fetchWithCache(base + '.onnx.json');
  const config = JSON.parse(new TextDecoder().decode(configBuffer));
  const model = await fetchWithCache(base + '.onnx', voice.bytes, (received, total) => {
    post({ type: 'progress', id: requestId, stage: 'voice', received, total });
  });
  post({ type: 'progress', id: requestId, stage: 'loading' });
  const session = await self.ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] });
  loaded = { id: voice.id, session, config };
  return loaded;
}

function splitSentences(text) {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[।॥.!?])\s+/))
    .map((part) => part.trim())
    .filter(Boolean);
}

function toPcm16(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  const gain = peak > 0 ? 0.97 / peak : 1; // same idea as Piper: use the full range without clipping
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * gain * 32767)));
  }
  return pcm;
}

function encodeWav(parts, sampleRate) {
  const frames = parts.reduce((sum, part) => sum + part.length, 0);
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const tag = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  tag(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, frames * 2, true);
  let offset = 44;
  for (const part of parts) { new Int16Array(buffer, offset, part.length).set(part); offset += part.length * 2; }
  return buffer;
}

async function generate(request) {
  cfg = request.config;
  post({ type: 'progress', id: request.id, stage: 'engine' });
  loadEngine();
  const { session, config } = await loadVoice(request.voice, request.id);

  const inference = config.inference || {};
  const scales = Float32Array.from([
    request.expressiveness,                       // noise scale
    (inference.length_scale || 1) / request.speed, // a larger length scale means slower speech
    request.rhythm,                               // phoneme width noise
  ]);
  const sampleRate = (config.audio && config.audio.sample_rate) || 22050;
  const gap = new Int16Array(Math.round(sampleRate * SENTENCE_GAP_SECONDS));
  const sentences = splitSentences(request.text);
  const parts = [];

  for (let i = 0; i < sentences.length; i++) {
    post({ type: 'progress', id: request.id, stage: 'speaking', part: i + 1, parts: sentences.length });
    const ids = await phonemize(sentences[i], config.espeak.voice);
    if (!ids.length) continue;
    const feeds = {
      input: new self.ort.Tensor('int64', BigInt64Array.from(ids.map((n) => BigInt(n))), [1, ids.length]),
      input_lengths: new self.ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new self.ort.Tensor('float32', scales, [3]),
    };
    if ((config.num_speakers || 1) > 1) feeds.sid = new self.ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
    const result = await session.run(feeds);
    const audio = result[session.outputNames[0]].data;
    if (parts.length) parts.push(gap);
    parts.push(toPcm16(audio));
  }

  if (!parts.length) throw new Error('There was nothing to say in that text. Try adding some words.');
  const wav = encodeWav(parts, sampleRate);
  post({ type: 'done', id: request.id, wav }, [wav]);
}

let queue = Promise.resolve();
self.onmessage = (event) => {
  const request = event.data;
  if (request.type !== 'generate') return;
  queue = queue.then(() => generate(request)).catch((error) => {
    post({ type: 'error', id: request.id, message: (error && error.message) || String(error) });
  });
};
