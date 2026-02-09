# Speedy.wasm

Nonlinear speech speedup for the web using WebAssembly.

An independent fork of Google's [speedy](https://github.com/google/speedy) algorithm — **not** an officially supported Google product.

---

## Overview

Speedy.wasm brings the Mach1 nonlinear speech speedup algorithm to the browser. Instead of compressing all audio equally (standard 2x playback), it compresses vowels and unstressed portions more than consonants — mimicking how humans naturally speak faster and maintaining higher intelligibility at speed.

**Features:**
- WebAssembly bindings for `SpeedyStream` (analysis) and `SonicStream` (time-scale modification)
- Zero-copy architecture with direct WASM heap access
- AudioWorklet support for off-main-thread processing
- Pre-built ES6 and UMD modules
- Interactive demo with waveform visualization

---

## Quick Start

### Installation

Copy the contents of `dist/` into your project:

```
dist/
├── speedy.js         # ES6 module
├── speedy.wasm       # WebAssembly binary
├── speedy.umd.js     # UMD bundle
└── speedy.umd.wasm   # WebAssembly binary (UMD)
```

### ES6 Module

```javascript
import initSpeedy from './dist/speedy.js';

const Module = await initSpeedy();
const stream = new Module.SonicStream(44100, 1);
stream.setSpeed(2.0);
stream.enableNonlinearSpeedup(1.0);
```

### UMD (Script Tag)

```html
<script src="dist/speedy.umd.js"></script>
<script>
  SpeedyWasm().then(Module => {
    const stream = new Module.SonicStream(44100, 1);
  });
</script>
```

### Demo

```bash
python3 -m http.server 8000
# Open http://localhost:8000/demo/index.html
```

A local web server is required due to WASM CORS restrictions.

---

## Architecture

```
SpeedyStream (Analysis) → Tension Value (0.0–1.0) → SonicStream (Time-Scale Modification)
```

| Component | Role |
|-----------|------|
| **SpeedyStream** | Analyzes spectral content to compute per-frame "tension" values |
| **SonicStream** | Performs time-scale modification using SOLA, with optional nonlinear speed control |
| **Tension** | How much a segment should be sped up — higher tension = more compression |

### Key Terms

| Term | Description | Range |
|------|-------------|-------|
| `speed` | Playback speed multiplier | 0.5–4.0 |
| `nonlinearFactor` | Degree of non-linearity (0 = linear, 1 = full) | 0.0–1.0 |
| `feedbackStrength` | Duration correction strength | 0.0–0.5 |
| `tension` | Computed per-frame speedup factor | 0.0–1.0+ |

### Data Format

Audio uses **interleaved Float32Array** in the range **[-1.0, 1.0]**:

```
Mono:   [S0, S1, S2, ...]
Stereo: [L0, R0, L1, R1, ...]
```

---

## Usage

### Whole-File Processing

```javascript
const Module = await initSpeedy();
const audioContext = new AudioContext();

// Decode audio file
const arrayBuffer = await file.arrayBuffer();
const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

// Configure stream
const stream = new Module.SonicStream(audioBuffer.sampleRate, 1);
stream.setSpeed(2.0);
stream.enableNonlinearSpeedup(1.0);

// Process
const input = audioBuffer.getChannelData(0);
stream.writeFloatToStream(input, input.length);
stream.flushStream();

// Collect output
const chunks = [];
let output;
while ((output = stream.readFloatFromStream(8192))) {
    chunks.push(output);
}

const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
const result = new Float32Array(totalLength);
let offset = 0;
for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
}

// Play
const outBuffer = audioContext.createBuffer(1, result.length, audioBuffer.sampleRate);
outBuffer.copyToChannel(result, 0);
const source = audioContext.createBufferSource();
source.buffer = outBuffer;
source.connect(audioContext.destination);
source.start();
```

### Chunked / Streaming Processing

```javascript
const stream = new Module.SonicStream(sampleRate, 1);
stream.setSpeed(2.0);
stream.enableNonlinearSpeedup(1.0);

for (let i = 0; i < audioData.length; i += chunkSize) {
    const chunk = audioData.subarray(i, i + chunkSize);
    stream.writeFloatToStream(chunk, chunk.length);

    let output;
    while ((output = stream.readFloatFromStream(chunkSize))) {
        // handle output chunk
    }
}

stream.flushStream();
let output;
while ((output = stream.readFloatFromStream(chunkSize))) {
    // handle remaining output
}
```

### Zero-Copy (Direct Memory Access)

```javascript
const numBytes = audioData.length * 4;
const ptr = Module._malloc(numBytes);
Module.HEAPF32.set(audioData, ptr >> 2);

stream.writeFloatToStreamPtr(ptr, audioData.length);

const outPtr = Module._malloc(4096 * 4);
const samplesRead = stream.readFloatFromStreamPtr(outPtr, 4096);
if (samplesRead > 0) {
    const view = new Float32Array(Module.HEAPF32.buffer, outPtr, samplesRead);
    // use view directly — no copy
}

Module._free(ptr);
Module._free(outPtr);
```

### Custom Tension Computation

```javascript
const speedy = new Module.SpeedyStream(sampleRate);
const sonic = new Module.SonicStream(sampleRate, 1);

const frameSize = speedy.inputFrameSize();
const frameStep = speedy.inputFrameStep();

for (let i = 0, frame = 0; i < audioData.length; i += frameStep, frame++) {
    const data = audioData.subarray(i, i + frameSize);
    speedy.addData(data, frame);

    try {
        const tension = speedy.computeTension(frame);
        const speed = speedy.computeSpeedFromTension(tension, 2.0, 0.1);
        sonic.setSpeed(speed);
    } catch (e) {
        sonic.setSpeed(2.0); // fallback until enough data
    }

    sonic.writeFloatToStream(data, data.length);
}
```

### Speed Profile Inspection

```javascript
stream.setupSpeedCallback();

// ... process audio ...

const profile = stream.getSpeedProfile();
// Float32Array: [time0, speed0, time1, speed1, ...]
for (let i = 0; i < profile.length; i += 2) {
    console.log(`t=${profile[i]}: ${profile[i + 1]}x`);
}
```

---

## Audio Preprocessing Helpers

### Resample

```javascript
async function resample(audioBuffer, targetRate) {
    if (audioBuffer.sampleRate === targetRate) return audioBuffer;
    const ctx = new OfflineAudioContext(
        audioBuffer.numberOfChannels,
        audioBuffer.duration * targetRate,
        targetRate
    );
    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(ctx.destination);
    src.start();
    return await ctx.startRendering();
}
```

### Convert to Mono

```javascript
function toMono(audioBuffer) {
    if (audioBuffer.numberOfChannels === 1) return audioBuffer.getChannelData(0);
    const mono = new Float32Array(audioBuffer.length);
    const n = audioBuffer.numberOfChannels;
    for (let ch = 0; ch < n; ch++) {
        const data = audioBuffer.getChannelData(ch);
        for (let i = 0; i < mono.length; i++) mono[i] += data[i] / n;
    }
    return mono;
}
```

### Export to WAV

```javascript
function toWav(samples, sampleRate) {
    const dataSize = samples.length * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0,'RIFF'); v.setUint32(4, 36+dataSize, true); w(8,'WAVE');
    w(12,'fmt '); v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate*2, true);
    v.setUint16(32,2,true); v.setUint16(34,16,true); w(36,'data'); v.setUint32(40, dataSize, true);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(44 + i*2, s < 0 ? s*0x8000 : s*0x7FFF, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
}
```

---

## API Reference

### SonicStream

```javascript
const stream = new Module.SonicStream(sampleRate, numChannels);
```

| Method | Returns | Description |
|--------|---------|-------------|
| `setSpeed(rate)` | void | Set playback speed multiplier |
| `getSpeed()` | float | Current speed |
| `setRate(rate)` | void | Set pitch rate (independent of speed) |
| `getRate()` | float | Current pitch rate |
| `enableNonlinearSpeedup(factor)` | void | Enable Speedy algorithm (0–1) |
| `setDurationFeedbackStrength(f)` | void | Set feedback strength |
| `writeFloatToStream(array, count)` | int | Write float32 samples |
| `writeFloatToStreamPtr(ptr, count)` | int | Write via WASM pointer |
| `writeShortToStream(array, count)` | int | Write int16 samples |
| `readFloatFromStream(maxSamples)` | Float32Array \| undefined | Read processed float32 |
| `readFloatFromStreamPtr(ptr, max)` | int | Read via WASM pointer |
| `readShortFromStream(maxSamples)` | Int16Array \| undefined | Read processed int16 |
| `flushStream()` | int | Flush remaining buffered samples |
| `samplesAvailable()` | int | Number of output samples ready |
| `setupSpeedCallback()` | void | Enable speed profile tracking |
| `getSpeedProfile()` | Float32Array \| undefined | Get `[time, speed, ...]` pairs |

### SpeedyStream

```javascript
const speedy = new Module.SpeedyStream(sampleRate);
```

| Method | Returns | Description |
|--------|---------|-------------|
| `inputFrameSize()` | int | Required samples per frame |
| `inputFrameStep()` | int | Step between frames |
| `addData(Float32Array, time)` | void | Add audio frame at time index |
| `addDataPtr(ptr, size, time)` | void | Add via WASM pointer |
| `addDataShort(Int16Array, time)` | void | Add int16 frame |
| `computeTension(time)` | float | Compute tension (throws if insufficient data) |
| `computeSpeedFromTension(t, Rg, fb)` | float | Convert tension to speed multiplier |
| `getCurrentTime()` | int64 | Current frame index |

### Frame Sizes by Sample Rate

| Sample Rate | Frame Size | Frame Step | ~Duration |
|-------------|------------|------------|-----------|
| 22050 Hz | 330 | 220 | 15ms |
| 44100 Hz | 661 | 441 | 15ms |
| 48000 Hz | 720 | 480 | 15ms |

---

## Performance Notes

| Tip | Details |
|-----|---------|
| **Chunk size** | Larger chunks (8192+) reduce overhead for batch processing; smaller (1024) for low latency |
| **Zero-copy** | Use `*Ptr` methods to avoid JS/WASM data copying |
| **Web Workers** | Offload processing to a worker to keep the UI responsive |
| **Memory** | Call `flushStream()` when done; set streams to `null` for GC |
| **Throughput** | Combined analysis + TSM runs ~3× real-time on modern browsers |

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| No sound | AudioContext suspended | `await audioContext.resume()` on user gesture |
| Empty output | Missing flush | Call `flushStream()` after all writes |
| Wrong speed | Mismatched sample rate | Ensure input sample rate matches stream constructor |
| Crackling | Samples out of range | Clamp input to [-1, 1] |
| WASM load failure | CORS / wrong MIME type | Serve via HTTP with `application/wasm` content type |
| `computeTension` throws | Not enough frames buffered | Wait ~20 frames before calling |

---

## Building from Source

Requires the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html).

```bash
git clone --recursive https://github.com/tzhvh0/speedy.wasm.git
cd speedy.wasm
make -f Makefile.emscripten all
# Output in dist/
```

---

## Algorithm Background

Reimplements the Mach1 algorithm from:

> M. Covell, M. Withgott, M. Slaney. "MACH1: Nonuniform Time-Scale Modification of Speech." *IEEE ICASSP*, 1998. [Link](https://ieeexplore.ieee.org/document/674439)

At 3.5× speedup, nonlinear processing showed significantly improved comprehension over linear speedup in TOEFL-based listening tests:

![Comprehension results](g3doc/SpeedyComprehension.png)

<details>
<summary>Algorithm flow diagrams</summary>

![Speed control flow](g3doc/SpeedySpeedControl.png)
![Emphasis and speed computation](g3doc/SpeedyFlowchart.png)
![Internal calculations](g3doc/SpeedyInternalCalculations.png)

</details>

---

## Credits

- **Original algorithm:** [Google Speedy](https://github.com/google/speedy)
- **Time-scale modification:** [Sonic](https://github.com/waywardgeek/sonic)
- **WASM port:** Claude Code

## License

Apache 2.0 — see [LICENSE](LICENSE)