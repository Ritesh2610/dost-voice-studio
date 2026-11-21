// Where the speech engine and voices are loaded from. All three are free,
// public hosts. To serve the files yourself, change these addresses.
window.DOST_CONFIG = {
  // ONNX Runtime Web: runs the voice model in the browser
  ortBase: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/',
  // Piper's phonemizer (espeak-ng) compiled to WebAssembly
  piperBase: 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/',
  // The official Piper voice collection
  voiceBase: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/',
};
