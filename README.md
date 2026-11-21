# Dost Voice Studio (web)

Free Hindi and English text to voice that runs entirely in the browser. Type a
line, listen to it, and download the audio as a WAV file. There is no server,
no account and no API key.

## How it works

Everything happens on the visitor's device:

1. The text is turned into phonemes by espeak-ng, compiled to WebAssembly.
2. A Piper voice model turns the phonemes into audio, using ONNX Runtime Web.
3. The audio is wrapped as a WAV file for playback and download.

The text never leaves the device. The first time a voice is used, the speech
engine and that voice are downloaded (about 100 MB in total); the voice is then
kept in the browser's storage.

## Files

```
index.html     The page
styles.css     Styles
app.js         Interface logic
tts-worker.js  Speech generation, in a background worker
config.js      Addresses the engine and voices are loaded from
favicon.svg    Icon
```

It is a plain static site: host these files anywhere (GitHub Pages, Netlify,
Cloudflare Pages). There is no build step.

## Limits

- Works best on a laptop or desktop. Phones can be slow or run out of memory.
- Needs a current browser (Chrome, Edge, Firefox or Safari).
- Hindi voices read Devanagari well; Roman-script Hinglish is mispronounced.
- The site depends on two free public hosts, set in `config.js`: jsDelivr for
  the engine and Hugging Face for the voices. If either is down, generating
  will not work until it is back.

## Credits and licences

- Voices: the [Piper voice collection](https://huggingface.co/rhasspy/piper-voices).
  Each voice has its own licence, set by the recordings it was trained on.
  Some do not allow commercial use. Read a voice's MODEL_CARD before using its
  audio in paid or monetised work.
- Phonemizer: [piper-wasm](https://github.com/diffusion-studio/piper-wasm)
  (MIT), which includes espeak-ng (GPL-3.0).
- Model runtime: [ONNX Runtime Web](https://onnxruntime.ai) (MIT).
- App code in this repository: MIT.
