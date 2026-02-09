# Speedy WASM Usage Manual

A comprehensive guide for using the Speedy WebAssembly bindings for nonlinear speech speedup in web applications.

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Core Concepts](#2-core-concepts)
3. [Module Loading & Initialization](#3-module-loading--initialization)
4. [Stream Creation & Configuration](#4-stream-creation--configuration)
5. [Audio Preprocessing](#5-audio-preprocessing)
6. [Processing Patterns](#6-processing-patterns)
7. [Advanced Features](#7-advanced-features)
8. [Web Audio API Integration](#8-web-audio-api-integration)
9. [Error Handling & Debugging](#9-error-handling--debugging)
10. [Performance & Memory](#10-performance--memory)
11. [Reference API](#11-reference-api)
12. [Complete Examples](#12-complete-examples)
13. [Troubleshooting](#13-troubleshooting)
14. [Appendix](#14-appendix)

---

## 1. Quick Start

### 1.1. Installation

Copy the pre-built files from the `dist/` directory to your project:

```
dist/
├── speedy.js          # ES6 module
├── speedy.wasm        # WebAssembly binary
├── speedy.umd.js      # UMD bundle
└── speedy.umd.wasm    # WebAssembly binary for UMD
```

**Via npm (if published):**
```bash
npm install speedy-wasm
```

**Via script tag (CDN):**
```html
<script src="https://your-cdn.com/speedy.umd.js"></script>
```

### 1.2. Hello World

Minimal working example:

```html
<!DOCTYPE html>
<html>
<head>
    <title>Speedy WASM Hello World</title>
</head>
<body>
    <input type="file" id="fileInput" accept="audio/*">
    <button id="playBtn">Process & Play</button>
    
    <script type="module">
        import initSpeedy, { SonicStream } from './dist/speedy.js';
        
        const Module = await initSpeedy();
        const audioContext = new AudioContext();
        
        document.getElementById('fileInput').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            const arrayBuffer = await file.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            
            // Create stream: sampleRate, numChannels
            const stream = new Module.SonicStream(audioBuffer.sampleRate, 1);
            stream.setSpeed(2.0);                    // 2x speed
            stream.enableNonlinearSpeedup(1.0);      // Full nonlinear
            
            // Process audio
            const inputData = audioBuffer.getChannelData(0);
            stream.writeFloatToStream(inputData, inputData.length);
            stream.flushStream();
            
            // Read output
            const outputChunks = [];
            let output;
            while ((output = stream.readFloatFromStream(4096))) {
                outputChunks.push(output);
            }
            
            // Combine and play
            const totalLength = outputChunks.reduce((sum, c) => sum + c.length, 0);
            const result = new Float32Array(totalLength);
            let offset = 0;
            for (const chunk of outputChunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }
            
            const outputBuffer = audioContext.createBuffer(1, result.length, audioBuffer.sampleRate);
            outputBuffer.copyToChannel(result, 0);
            
            const source = audioContext.createBufferSource();
            source.buffer = outputBuffer;
            source.connect(audioContext.destination);
            source.start();
        });
    </script>
</body>
</html>
```

### 1.3. Running the Demo

Serve the project root with a local web server (required due to CORS/WASM restrictions):

```bash
# Python 3
python3 -m http.server 8000

# Node.js (http-server)
npx http-server -p 8000

# Open http://localhost:8000/demo/public_demo/
```

---

## 2. Core Concepts

### 2.1. What is Non-linear Speedup?

Traditional speedup algorithms compress all parts of speech equally (e.g., 2x = everything plays at double speed). However, humans naturally speak faster by compressing vowels and unstressed portions more than consonants.

**Linear Speedup (2x):**
- Vowels: 100ms → 50ms
- Consonants: 50ms → 25ms

**Non-linear Speedup (Speedy algorithm):**
- Vowels: 100ms → 40ms (more compression)
- Consonants: 50ms → 35ms (less compression)

This mimics natural fast speech and maintains higher intelligibility, especially at high speedup factors (2.5x-3.5x).

### 2.2. Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  SpeedyStream   │────▶│  Tension Value  │────▶│  SonicStream    │
│  (Analysis)     │     │  (0.0 - 1.0)    │     │  (Time-Scale)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

- **SpeedyStream**: Analyzes audio spectral content to compute "tension" values
- **Tension**: Represents how much a segment should be sped up (higher = more speedup)
- **SonicStream**: Performs the actual time-scale modification (TSM) using SOLA algorithm

### 2.3. Key Terms

| Term | Description | Typical Range |
|------|-------------|---------------|
| `speed` | Playback speed multiplier | 0.5 - 4.0 |
| `nonlinearFactor` | Amount of non-linearity (0=linear, 1=full) | 0.0 - 1.0 |
| `feedbackStrength` | Duration correction strength | 0.0 - 0.5 |
| `tension` | Computed speedup factor per frame | 0.0 - 1.0+ |
| `R_g` | Global target speed ratio | 1.0 - 3.5 |

### 2.4. Data Layout

Audio data uses **interleaved Float32Array** format:

```
Stereo: [L0, R0, L1, R1, L2, R2, ...]
Mono:   [S0, S1, S2, ...]
```

- Samples are in range **[-1.0, 1.0]** for float format
- Samples are in range **[-32768, 32767]** for int16 format
- Channel data is interleaved (all channels for sample N, then all channels for sample N+1)

---

## 3. Module Loading & Initialization

### 3.1. Loading Methods

#### ES6 Module (Recommended)

```javascript
import initSpeedy, { SpeedyStream, SonicStream } from './dist/speedy.js';

async function main() {
    const Module = await initSpeedy();
    const stream = new Module.SonicStream(44100, 1);
}
```

#### UMD Global (Script Tag)

```html
<script src="dist/speedy.umd.js"></script>
<script>
    SpeedyWasm().then(Module => {
        const { SpeedyStream, SonicStream } = Module;
        const stream = new SonicStream(44100, 1);
    });
</script>
```

#### Dynamic Import (On-Demand)

```javascript
async function loadSpeedy() {
    const module = await import('./dist/speedy.js');
    return await module.default();
}

// Load when needed
const speedyModule = await loadSpeedy();
const stream = new speedyModule.SonicStream(44100, 1);
```

### 3.2. Initialization Pattern

```javascript
class SpeedyProcessor {
    constructor() {
        this.module = null;
        this.ready = false;
    }
    
    async initialize() {
        try {
            this.module = await initSpeedy();
            this.ready = true;
            console.log('Speedy WASM initialized');
        } catch (error) {
            console.error('Failed to initialize Speedy:', error);
            throw error;
        }
    }
    
    ensureReady() {
        if (!this.ready) {
            throw new Error('Speedy module not initialized. Call initialize() first.');
        }
    }
}

// Usage
const processor = new SpeedyProcessor();
await processor.initialize();
```

### 3.3. Browser Compatibility

| Feature | Requirement |
|---------|-------------|
| WebAssembly | Required (all modern browsers) |
| CORS | Required for loading .wasm files |
| MIME type | `.wasm` must be served as `application/wasm` |
| AudioContext | Required for Web Audio API integration |

**Common CORS Issues:**
- Use `python3 -m http.server` instead of `file://` protocol
- Ensure server sends `Content-Type: application/wasm` for .wasm files
- Add `Cross-Origin-Opener-Policy: same-origin` headers for SharedArrayBuffer

---

## 4. Stream Creation & Configuration

### 4.1. SonicStream (for Speed Modification)

```javascript
// Constructor: new SonicStream(sampleRate, numChannels)
const stream = new SonicStream(44100, 1);  // Mono, 44.1kHz
const stream = new SonicStream(22050, 2);  // Stereo, 22.05kHz
```

**Configuration Methods:**

```javascript
// Set playback speed (2.0 = 2x faster)
stream.setSpeed(2.0);

// Set pitch shift (independent of speed)
stream.setRate(1.0);  // 1.0 = normal pitch

// Enable nonlinear speedup (1.0 = full Speedy algorithm)
stream.enableNonlinearSpeedup(1.0);

// Set duration feedback strength (0.1 recommended)
stream.setDurationFeedbackStrength(0.1);

// Get current settings
const currentSpeed = stream.getSpeed();
const currentRate = stream.getRate();
```

### 4.2. SpeedyStream (for Tension Only)

```javascript
// Constructor: new SpeedyStream(sampleRate)
const speedy = new SpeedyStream(22050);

// Get frame requirements
const frameSize = speedy.inputFrameSize();   // e.g., 330 samples @ 22050Hz
const frameStep = speedy.inputFrameStep();   // e.g., 220 samples @ 22050Hz

// Add audio data at specific frame time
speedy.addData(float32Array, at_time);

// Compute tension for a frame
try {
    const tension = speedy.computeTension(at_time);
    
    // Convert tension to speed
    const speed = speedy.computeSpeedFromTension(
        tension,    // Tension value
        2.0,        // Global speed ratio (R_g)
        0.1         // Feedback strength
    );
} catch (e) {
    // Insufficient data for tension computation
}
```

### 4.3. Frame Sizes

Frame sizes depend on sample rate:

| Sample Rate | Frame Size | Frame Step | Duration |
|-------------|------------|------------|----------|
| 22050 Hz | 330 samples | 220 samples | ~15ms |
| 44100 Hz | 661 samples | 441 samples | ~15ms |
| 48000 Hz | 720 samples | 480 samples | ~15ms |

```javascript
const frameSize = stream.inputFrameSize();   // Required input samples
const frameStep = stream.inputFrameStep();   // Step between frames
```

---

## 5. Audio Preprocessing

### 5.1. Loading Audio

#### From File

```javascript
async function loadAudioFile(file, audioContext) {
    const arrayBuffer = await file.arrayBuffer();
    return await audioContext.decodeAudioData(arrayBuffer);
}
```

#### From URL

```javascript
async function loadAudioFromUrl(url, audioContext) {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    return await audioContext.decodeAudioData(arrayBuffer);
}
```

#### From Microphone

```javascript
async function getMicrophoneStream(audioContext) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return audioContext.createMediaStreamSource(stream);
}
```

### 5.2. Resampling

```javascript
async function resampleAudio(audioBuffer, targetSampleRate) {
    if (audioBuffer.sampleRate === targetSampleRate) {
        return audioBuffer;
    }
    
    const offlineContext = new OfflineAudioContext(
        audioBuffer.numberOfChannels,
        audioBuffer.duration * targetSampleRate,
        targetSampleRate
    );
    
    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineContext.destination);
    source.start();
    
    return await offlineContext.startRendering();
}
```

### 5.3. Converting to Mono

```javascript
function toMono(audioBuffer) {
    if (audioBuffer.numberOfChannels === 1) {
        return audioBuffer.getChannelData(0);
    }
    
    const length = audioBuffer.length;
    const mono = new Float32Array(length);
    
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < length; i++) {
            mono[i] += channelData[i] / audioBuffer.numberOfChannels;
        }
    }
    
    return mono;
}
```

### 5.4. Normalization

```javascript
function normalizeRMS(audioData, targetLevel = 0.9) {
    // Calculate RMS
    let sumSquares = 0;
    for (let i = 0; i < audioData.length; i++) {
        sumSquares += audioData[i] * audioData[i];
    }
    const rms = Math.sqrt(sumSquares / audioData.length);
    
    if (rms === 0) return audioData;
    
    // Scale to target
    const scale = targetLevel / rms;
    const normalized = new Float32Array(audioData.length);
    
    for (let i = 0; i < audioData.length; i++) {
        normalized[i] = Math.max(-1, Math.min(1, audioData[i] * scale));
    }
    
    return normalized;
}
```

### 5.5. Format Conversion

#### Float32 to Int16

```javascript
function floatToInt16(floatArray) {
    const int16Array = new Int16Array(floatArray.length);
    for (let i = 0; i < floatArray.length; i++) {
        const s = Math.max(-1, Math.min(1, floatArray[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
}
```

#### Int16 to Float32

```javascript
function int16ToFloat(int16Array) {
    const floatArray = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
        floatArray[i] = int16Array[i] / 0x8000;
    }
    return floatArray;
}
```

---

## 6. Processing Patterns

### 6.1. Whole-File Processing

```javascript
async function processWholeFile(audioBuffer, Module) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    
    // Create stream
    const stream = new Module.SonicStream(sampleRate, numChannels);
    stream.setSpeed(2.0);
    stream.enableNonlinearSpeedup(1.0);
    
    // Interleave channels
    const interleaved = interleaveChannels(audioBuffer);
    
    // Write all data
    stream.writeFloatToStream(interleaved, interleaved.length / numChannels);
    
    // Flush to get remaining output
    stream.flushStream();
    
    // Read all output
    const outputChunks = [];
    const chunkSize = 4096;
    let output;
    
    while ((output = stream.readFloatFromStream(chunkSize))) {
        outputChunks.push(output);
    }
    
    // Combine chunks
    const totalLength = outputChunks.reduce((sum, c) => sum + c.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of outputChunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
    }
    
    // De-interleave
    return deinterleaveToAudioBuffer(combined, numChannels, sampleRate);
}
```

### 6.2. Chunked/Streaming Processing

```javascript
async function* processInChunks(audioBuffer, Module, chunkSize = 8192) {
    const numChannels = audioBuffer.numberOfChannels;
    const stream = new Module.SonicStream(audioBuffer.sampleRate, numChannels);
    stream.setSpeed(2.0);
    stream.enableNonlinearSpeedup(1.0);
    
    const interleaved = interleaveChannels(audioBuffer);
    
    // Process in chunks
    for (let offset = 0; offset < interleaved.length; offset += chunkSize) {
        const chunk = interleaved.subarray(offset, offset + chunkSize);
        stream.writeFloatToStream(chunk, chunk.length / numChannels);
        
        // Read available output
        let output;
        while ((output = stream.readFloatFromStream(chunkSize))) {
            yield output;
        }
        
        // Yield to event loop for UI responsiveness
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    // Flush remaining
    stream.flushStream();
    let output;
    while ((output = stream.readFloatFromStream(chunkSize))) {
        yield output;
    }
}
```

### 6.3. Real-time Processing with AudioWorklet

```javascript
// speedy-processor.js (AudioWorklet)
class SpeedyProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.stream = null;
        this.port.onmessage = (e) => {
            if (e.data.type === 'init') {
                this.stream = e.data.stream;
            }
        };
    }
    
    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        
        if (!this.stream || input.length === 0) return true;
        
        // Get input data (mono)
        const inputData = input[0];
        
        // Write to Speedy stream
        this.stream.writeFloatToStream(inputData, inputData.length);
        
        // Read from Speedy stream
        const processed = this.stream.readFloatFromStream(128);
        
        if (processed) {
            output[0].set(processed);
        } else {
            output[0].fill(0);
        }
        
        return true;
    }
}

registerProcessor('speedy-processor', SpeedyProcessor);
```

### 6.4. Zero-Copy Pattern

For maximum performance, use direct memory access:

```javascript
function processWithZeroCopy(stream, audioData, Module) {
    // Allocate WASM memory
    const numBytes = audioData.length * audioData.BYTES_PER_ELEMENT;
    const ptr = Module._malloc(numBytes);
    
    // Copy data to WASM heap
    Module.HEAPF32.set(audioData, ptr >> 2);
    
    // Write using pointer (no copy)
    stream.writeFloatToStreamPtr(ptr, audioData.length);
    
    // Read using pointer
    const outputPtr = Module._malloc(4096 * 4);
    const samplesRead = stream.readFloatFromStreamPtr(outputPtr, 4096);
    
    if (samplesRead > 0) {
        // Copy result from WASM heap
        const output = new Float32Array(
            Module.HEAPF32.buffer,
            outputPtr,
            samplesRead
        );
        // Process output...
    }
    
    // Free memory
    Module._free(ptr);
    Module._free(outputPtr);
}
```

---

## 7. Advanced Features

### 7.1. Speed Profile Callbacks

Track how speed varies over time:

```javascript
// Set up callback before processing
stream.setupSpeedCallback();

// Process audio...
stream.writeFloatToStream(audioData, sampleCount);
stream.flushStream();

// Get speed profile
const speedProfile = stream.getSpeedProfile();
// Returns: Float32Array [time0, speed0, time1, speed1, ...]

// Parse profile
for (let i = 0; i < speedProfile.length; i += 2) {
    const time = speedProfile[i];
    const speed = speedProfile[i + 1];
    console.log(`Time ${time}: speed ${speed}x`);
}
```

### 7.2. Custom Tension Computation

For advanced use cases, compute tension separately:

```javascript
class TensionBasedProcessor {
    constructor(Module, sampleRate) {
        this.speedy = new Module.SpeedyStream(sampleRate);
        this.sonic = new Module.SonicStream(sampleRate, 1);
        
        this.frameSize = this.speedy.inputFrameSize();
        this.frameStep = this.speedy.inputFrameStep();
    }
    
    async processWithDynamicSpeed(audioData) {
        const tensionHistory = [];
        
        for (let i = 0; i < audioData.length; i += this.frameStep) {
            const frame = audioData.subarray(i, i + this.frameSize);
            const frameTime = Math.floor(i / this.frameStep);
            
            // Send to Speedy
            this.speedy.addData(frame, frameTime);
            
            // Compute tension
            try {
                const tension = this.speedy.computeTension(frameTime);
                const speed = this.speedy.computeSpeedFromTension(
                    tension,
                    2.0,  // Global speed
                    0.1   // Feedback
                );
                
                tensionHistory.push({ time: frameTime, tension, speed });
                
                // Update Sonic speed dynamically
                this.sonic.setSpeed(speed);
                this.sonic.writeFloatToStream(frame, frame.length);
                
            } catch (e) {
                // Not enough data yet
            }
        }
        
        return tensionHistory;
    }
}
```

### 7.3. Multi-Channel Audio

```javascript
// Stereo processing
const stream = new SonicStream(44100, 2);  // 2 channels

// Interleave stereo data
function interleave(left, right) {
    const result = new Float32Array(left.length * 2);
    for (let i = 0; i < left.length; i++) {
        result[i * 2] = left[i];
        result[i * 2 + 1] = right[i];
    }
    return result;
}

// De-interleave stereo data
function deinterleave(interleaved) {
    const length = interleaved.length / 2;
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    
    for (let i = 0; i < length; i++) {
        left[i] = interleaved[i * 2];
        right[i] = interleaved[i * 2 + 1];
    }
    
    return [left, right];
}
```

---

## 8. Web Audio API Integration

### 8.1. Playback

```javascript
async function playProcessedAudio(processedData, sampleRate) {
    const audioContext = new AudioContext();
    
    // Resume context (required after user gesture)
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }
    
    // Create buffer
    const buffer = audioContext.createBuffer(1, processedData.length, sampleRate);
    buffer.copyToChannel(processedData, 0);
    
    // Create source
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start();
    
    return source; // Return to allow stopping
}
```

### 8.2. Real-time Input

```javascript
async function setupRealTimeProcessing() {
    const Module = await initSpeedy();
    const audioContext = new AudioContext();
    const stream = new Module.SonicStream(audioContext.sampleRate, 1);
    stream.setSpeed(1.5);
    stream.enableNonlinearSpeedup(1.0);
    
    // Get microphone
    const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = audioContext.createMediaStreamSource(mediaStream);
    
    // Create processor (ScriptProcessor is deprecated but widely supported)
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    
    processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        stream.writeFloatToStream(inputData, inputData.length);
        
        const output = stream.readFloatFromStream(4096);
        if (output) {
            e.outputBuffer.copyToChannel(output, 0);
        }
    };
    
    source.connect(processor);
    processor.connect(audioContext.destination);
}
```

### 8.3. Offline Processing

```javascript
async function processOffline(audioBuffer, speed, nonlinearFactor) {
    const Module = await initSpeedy();
    
    // Create offline context
    const duration = audioBuffer.duration / speed;
    const offlineContext = new OfflineAudioContext(
        audioBuffer.numberOfChannels,
        duration * audioBuffer.sampleRate,
        audioBuffer.sampleRate
    );
    
    // Process audio
    const stream = new Module.SonicStream(audioBuffer.sampleRate, audioBuffer.numberOfChannels);
    stream.setSpeed(speed);
    stream.enableNonlinearSpeedup(nonlinearFactor);
    
    // Interleave and write
    const interleaved = interleaveChannels(audioBuffer);
    stream.writeFloatToStream(interleaved, audioBuffer.length);
    stream.flushStream();
    
    // Read output and create buffer
    const chunks = [];
    let output;
    while ((output = stream.readFloatFromStream(8192))) {
        chunks.push(output);
    }
    
    const combined = combineChunks(chunks);
    const resultBuffer = deinterleaveToAudioBuffer(
        combined, 
        audioBuffer.numberOfChannels, 
        audioBuffer.sampleRate
    );
    
    return resultBuffer;
}
```

---

## 9. Error Handling & Debugging

### 9.1. Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| "Module not loaded" | Used classes before `await initSpeedy()` | Always await initialization |
| "Insufficient data" | Called `computeTension()` too early | Wait for enough frames (20+) |
| No output | Forgot `flushStream()` | Always flush after writing |
| Distortion | Samples outside [-1, 1] range | Normalize/clamp input |
| Memory growth | Not cleaning up streams | Set stream = null when done |

### 9.2. Debug Tools

```javascript
function debugStream(stream) {
    console.log('Frame size:', stream.inputFrameSize?.() || 'N/A');
    console.log('Frame step:', stream.inputFrameStep?.() || 'N/A');
    console.log('Current speed:', stream.getSpeed?.() || 'N/A');
    console.log('Samples available:', stream.samplesAvailable?.() || 'N/A');
}

// Monitor I/O
class StreamMonitor {
    constructor(stream) {
        this.stream = stream;
        this.written = 0;
        this.read = 0;
    }
    
    write(data, count) {
        const written = this.stream.writeFloatToStream(data, count);
        this.written += written;
        return written;
    }
    
    read(size) {
        const output = this.stream.readFloatFromStream(size);
        if (output) {
            this.read += output.length;
        }
        return output;
    }
    
    report() {
        console.log(`Written: ${this.written}, Read: ${this.read}, Ratio: ${(this.read/this.written).toFixed(2)}`);
    }
}
```

### 9.3. Validation

```javascript
function validateProcessing(inputBuffer, outputBuffer, expectedSpeed) {
    const inputDuration = inputBuffer.length / inputBuffer.sampleRate;
    const outputDuration = outputBuffer.length / outputBuffer.sampleRate;
    const actualSpeed = inputDuration / outputDuration;
    
    console.log(`Input: ${inputDuration.toFixed(2)}s`);
    console.log(`Output: ${outputDuration.toFixed(2)}s`);
    console.log(`Speed: ${actualSpeed.toFixed(2)}x (expected: ${expectedSpeed}x)`);
    
    // Check if within 10% of expected
    const error = Math.abs(actualSpeed - expectedSpeed) / expectedSpeed;
    if (error > 0.1) {
        console.warn('Speed mismatch detected!');
    }
}
```

---

## 10. Performance & Memory

### 10.1. Chunk Size Selection

| Chunk Size | Latency | CPU Usage | Use Case |
|------------|---------|-----------|----------|
| 1024 | Low | High | Real-time |
| 4096 | Medium | Medium | Interactive |
| 8192 | High | Low | Batch processing |

### 10.2. Zero-Copy Optimization

```javascript
// Slow: Creates copies
const output = stream.readFloatFromStream(4096);
if (output) {
    process(output); // Copy from WASM to JS
}

// Fast: Direct memory access
const ptr = Module._malloc(4096 * 4);
const count = stream.readFloatFromStreamPtr(ptr, 4096);
if (count > 0) {
    const view = new Float32Array(Module.HEAPF32.buffer, ptr, count);
    process(view); // No copy!
}
Module._free(ptr);
```

### 10.3. Avoiding GC Pressure

```javascript
// Bad: Creates new arrays every frame
function processBad(stream) {
    while (true) {
        const output = stream.readFloatFromStream(4096);
        if (!output) break;
        // output is garbage collected later
    }
}

// Good: Reuse buffers
function processGood(stream) {
    const reuseBuffer = new Float32Array(4096);
    // ... use zero-copy ptr methods
}
```

### 10.4. Streaming Large Files

```javascript
async function* processLargeFile(file, Module) {
    const CHUNK_SIZE = 16384;
    const stream = new Module.SonicStream(22050, 1);
    stream.setSpeed(2.0);
    stream.enableNonlinearSpeedup(1.0);
    
    // Use ReadableStream if available
    const fileStream = file.stream();
    const reader = fileStream.getReader();
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        // Process chunk
        stream.writeFloatToStream(value, value.length);
        
        let output;
        while ((output = stream.readFloatFromStream(CHUNK_SIZE))) {
            yield output;
        }
    }
    
    // Flush
    stream.flushStream();
    let output;
    while ((output = stream.readFloatFromStream(CHUNK_SIZE))) {
        yield output;
    }
}
```

### 10.5. Multi-threading with Web Workers

```javascript
// worker.js
self.importScripts('dist/speedy.umd.js');

SpeedyWasm().then(Module => {
    self.onmessage = async (e) => {
        const { audioData, sampleRate, speed } = e.data;
        
        const stream = new Module.SonicStream(sampleRate, 1);
        stream.setSpeed(speed);
        stream.enableNonlinearSpeedup(1.0);
        
        stream.writeFloatToStream(audioData, audioData.length);
        stream.flushStream();
        
        const chunks = [];
        let output;
        while ((output = stream.readFloatFromStream(8192))) {
            chunks.push(output);
        }
        
        // Transfer result (no copy)
        self.postMessage({ chunks }, [chunks.buffer]);
    };
});

// main.js
const worker = new Worker('worker.js');

async function processInWorker(audioData) {
    return new Promise((resolve) => {
        worker.onmessage = (e) => resolve(e.data.chunks);
        worker.postMessage({
            audioData,
            sampleRate: 22050,
            speed: 2.0
        }, [audioData.buffer]);
    });
}
```

---

## 11. Reference API

### SonicStream

| Method | Returns | Description |
|--------|---------|-------------|
| `constructor(sampleRate, numChannels)` | SonicStream | Create new stream |
| `writeFloatToStream(array, sampleCount)` | int | Write float32 audio |
| `writeFloatToStreamPtr(ptr, sampleCount)` | int | Write via pointer (zero-copy) |
| `writeShortToStream(array, sampleCount)` | int | Write int16 audio |
| `readFloatFromStream(bufferSize)` | Float32Array \| undefined | Read processed audio |
| `readFloatFromStreamPtr(ptr, bufferSize)` | int | Read via pointer (zero-copy) |
| `readShortFromStream(bufferSize)` | Int16Array \| undefined | Read as int16 |
| `flushStream()` | int | Flush remaining samples |
| `setSpeed(rate)` | void | Set playback speed |
| `getSpeed()` | float | Get current speed |
| `setRate(rate)` | void | Set pitch rate |
| `getRate()` | float | Get current rate |
| `enableNonlinearSpeedup(factor)` | void | Enable Speedy algorithm |
| `setDurationFeedbackStrength(factor)` | void | Set feedback strength |
| `samplesAvailable()` | int | Samples ready to read |
| `setupSpeedCallback()` | void | Enable speed tracking |
| `getSpeedProfile()` | Float32Array \| undefined | Get [time, speed] pairs |

### SpeedyStream

| Method | Returns | Description |
|--------|---------|-------------|
| `constructor(sampleRate)` | SpeedyStream | Create new stream |
| `inputFrameSize()` | int | Required input samples |
| `inputFrameStep()` | int | Frame step in samples |
| `addData(Float32Array, at_time)` | void | Add audio frame |
| `addDataPtr(ptr, size, at_time)` | void | Add via pointer |
| `addDataShort(Int16Array, at_time)` | void | Add int16 frame |
| `computeTension(at_time)` | float | Compute tension (throws if insufficient) |
| `computeSpeedFromTension(tension, R_g, feedback)` | float | Convert tension to speed |
| `getCurrentTime()` | int64 | Current frame index |

### Module Functions

```javascript
const Module = await initSpeedy();

// Memory management
Module._malloc(size);      // Allocate WASM memory
Module._free(ptr);         // Free WASM memory
Module.HEAPF32;            // Float32 view of WASM heap
Module.HEAP16;             // Int16 view of WASM heap
```

---

## 12. Complete Examples

### 12.1. Basic File Processor

```html
<!DOCTYPE html>
<html>
<head><title>Basic Speedy Processor</title></head>
<body>
    <input type="file" id="fileInput" accept="audio/*">
    <button id="processBtn" disabled>Process</button>
    <div id="status"></div>

    <script type="module">
        import initSpeedy, { SonicStream } from './dist/speedy.js';

        const status = document.getElementById('status');
        const processBtn = document.getElementById('processBtn');
        let Module = null;
        let audioContext = null;
        let currentFile = null;

        // Initialize
        async function init() {
            try {
                Module = await initSpeedy();
                audioContext = new AudioContext();
                status.textContent = 'Ready';
            } catch (e) {
                status.textContent = 'Error: ' + e.message;
            }
        }

        // Load file
        document.getElementById('fileInput').addEventListener('change', (e) => {
            currentFile = e.target.files[0];
            processBtn.disabled = !currentFile;
            status.textContent = currentFile ? `Loaded: ${currentFile.name}` : 'No file';
        });

        // Process
        processBtn.addEventListener('click', async () => {
            if (!currentFile) return;
            
            // Resume context on user gesture
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            status.textContent = 'Processing...';
            
            try {
                const arrayBuffer = await currentFile.arrayBuffer();
                const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
                
                const stream = new Module.SonicStream(audioBuffer.sampleRate, 1);
                stream.setSpeed(2.0);
                stream.enableNonlinearSpeedup(1.0);
                
                const inputData = audioBuffer.getChannelData(0);
                stream.writeFloatToStream(inputData, inputData.length);
                stream.flushStream();
                
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
                const outputBuffer = audioContext.createBuffer(1, result.length, audioBuffer.sampleRate);
                outputBuffer.copyToChannel(result, 0);
                
                const source = audioContext.createBufferSource();
                source.buffer = outputBuffer;
                source.connect(audioContext.destination);
                source.start();
                
                status.textContent = `Done! ${audioBuffer.duration.toFixed(1)}s → ${(result.length/audioBuffer.sampleRate).toFixed(1)}s`;
            } catch (e) {
                status.textContent = 'Error: ' + e.message;
            }
        });

        init();
    </script>
</body>
</html>
```

### 12.2. Dynamic Speed Based on Tension

```javascript
class DynamicSpeedProcessor {
    constructor(Module, sampleRate) {
        this.speedy = new Module.SpeedyStream(sampleRate);
        this.sonic = new Module.SonicStream(sampleRate, 1);
        
        this.frameSize = this.speedy.inputFrameSize();
        this.frameStep = this.speedy.inputFrameStep();
        
        // Configuration
        this.globalSpeed = 2.0;
        this.feedbackStrength = 0.1;
        this.tensionHistory = [];
    }
    
    async process(audioData) {
        const outputChunks = [];
        let frameIndex = 0;
        
        for (let offset = 0; offset < audioData.length; offset += this.frameStep) {
            // Extract frame
            let frame = audioData.subarray(offset, offset + this.frameSize);
            
            // Pad if needed
            if (frame.length < this.frameSize) {
                const padded = new Float32Array(this.frameSize);
                padded.set(frame);
                frame = padded;
            }
            
            // Send to Speedy
            this.speedy.addData(frame, frameIndex);
            
            // Compute tension if possible
            try {
                const tension = this.speedy.computeTension(frameIndex);
                const speed = this.speedy.computeSpeedFromTension(
                    tension,
                    this.globalSpeed,
                    this.feedbackStrength
                );
                
                this.tensionHistory.push({
                    frame: frameIndex,
                    tension,
                    speed
                });
                
                // Update Sonic speed
                this.sonic.setSpeed(speed);
                
            } catch (e) {
                // Not enough data yet, use default speed
                this.sonic.setSpeed(this.globalSpeed);
            }
            
            // Process through Sonic
            this.sonic.writeFloatToStream(frame, this.frameSize);
            
            // Read output
            const output = this.sonic.readFloatFromStream(this.frameStep);
            if (output) {
                outputChunks.push(output);
            }
            
            frameIndex++;
        }
        
        // Flush
        this.sonic.flushStream();
        let output;
        while ((output = this.sonic.readFloatFromStream(4096))) {
            outputChunks.push(output);
        }
        
        return {
            audio: this.combineChunks(outputChunks),
            profile: this.tensionHistory
        };
    }
    
    combineChunks(chunks) {
        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        const result = new Float32Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }
}
```

### 12.3. Batch Processing Multiple Files

```javascript
async function processBatch(files, options = {}) {
    const { speed = 2.0, nonlinearFactor = 1.0 } = options;
    const Module = await initSpeedy();
    const audioContext = new AudioContext();
    
    const results = [];
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        console.log(`Processing ${i + 1}/${files.length}: ${file.name}`);
        
        try {
            const arrayBuffer = await file.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            
            const stream = new Module.SonicStream(audioBuffer.sampleRate, 1);
            stream.setSpeed(speed);
            stream.enableNonlinearSpeedup(nonlinearFactor);
            
            const inputData = audioBuffer.getChannelData(0);
            stream.writeFloatToStream(inputData, inputData.length);
            stream.flushStream();
            
            const chunks = [];
            let output;
            while ((output = stream.readFloatFromStream(8192))) {
                chunks.push(output);
            }
            
            results.push({
                file: file.name,
                success: true,
                chunks,
                inputDuration: audioBuffer.duration,
                outputDuration: chunks.reduce((sum, c) => sum + c.length, 0) / audioBuffer.sampleRate
            });
            
        } catch (error) {
            results.push({
                file: file.name,
                success: false,
                error: error.message
            });
        }
    }
    
    return results;
}
```

### 12.4. Export to WAV

```javascript
function floatToWav(audioData, sampleRate, numChannels = 1) {
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = audioData.length * bytesPerSample;
    
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    
    // Write WAV header
    const writeString = (offset, string) => {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };
    
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);  // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);  // 16-bit
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);
    
    // Write audio data
    let offset = 44;
    for (let i = 0; i < audioData.length; i++) {
        const sample = Math.max(-1, Math.min(1, audioData[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        offset += 2;
    }
    
    return new Blob([buffer], { type: 'audio/wav' });
}

// Download function
function downloadWav(audioData, sampleRate, filename = 'output.wav') {
    const blob = floatToWav(audioData, sampleRate);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
```

---

## 13. Troubleshooting

### Symptom: No sound

| Check | Solution |
|-------|----------|
| AudioContext suspended | Call `await audioContext.resume()` on user gesture |
| Output buffer empty | Check `readFloatFromStream()` returns data |
| Output not connected | Ensure `source.connect(audioContext.destination)` |
| Samples all zeros | Check input data range [-1, 1] |

### Symptom: Audio too slow/fast

| Check | Solution |
|-------|----------|
| Speed value | Verify `setSpeed(2.0)` for 2x speed |
| Nonlinear factor | Check `enableNonlinearSpeedup(1.0)` |
| Sample rate match | Ensure input matches stream sample rate |

### Symptom: Memory leak

| Check | Solution |
|-------|----------|
| Flush called? | Always call `flushStream()` |
| Streams released? | Set `stream = null` when done |
| Large files | Use streaming pattern |

### Symptom: Crackling/popping

| Check | Solution |
|-------|----------|
| Sample format | Ensure float32 in [-1, 1] range |
| NaN/Inf values | Filter or clamp input data |
| Buffer underruns | Increase ring buffer size |

### Symptom: High CPU

| Check | Solution |
|-------|----------|
| Chunk size | Try larger chunks (8192+) |
| Zero-copy | Use pointer-based methods |
| SIMD build | Use optimized WASM build |

---

## 14. Appendix

### A. Building from Source

Requirements: [Emscripten SDK](https://emscripten.org/)

```bash
# Clone with submodules
git clone --recursive https://github.com/tzhvh0/speedy.wasm.git
cd speedy.wasm

# Build all targets
make -f Makefile.emscripten all

# Output in dist/
```

### B. API Design Rationale

**Why interleaved audio?**
- Matches Web Audio API's `getChannelData()` format
- Consistent with most audio processing libraries
- Simplifies multi-channel processing loops

**Why frame-based input for Speedy?**
- Speedy uses spectral analysis requiring fixed window sizes
- Frame step determines temporal resolution (100Hz = 10ms)
- Enables lookahead for better tension estimation

### C. Algorithm Internals

Speedy computes tension through these steps:

1. **Spectrogram computation**: FFT-based power spectrum
2. **Energy normalization**: Per-frame loudness adjustment
3. **Spectral difference**: Compare consecutive frames
4. **Emphasis weighting**: Weight by perceptual importance
5. **Temporal hysteresis**: Smooth across 20-frame window
6. **Tension mapping**: Convert to speed multiplier

### D. Performance Benchmarks

Typical performance on modern browsers:

| Operation | Throughput | Latency |
|-----------|------------|---------|
| Sonic processing | ~10x real-time | ~50ms |
| Speedy analysis | ~5x real-time | ~150ms |
| Combined | ~3x real-time | ~200ms |

### E. Known Limitations

- Mono audio recommended for best quality
- Minimum latency ~150ms (due to lookahead)
- Memory usage grows with stream duration (flush periodically)
- Safari: May require polyfill for some TypedArray methods

### F. Contributing / Resources

- **Repository**: https://github.com/tzhvh0/speedy.wasm
- **Original Project**: https://github.com/google/speedy
- **Sonic Library**: https://github.com/waywardgeek/sonic
- **Algorithm Paper**: [Mach1 Paper](https://ieeexplore.ieee.org/document/674439)

---

## License

Apache 2.0 - See [LICENSE](../LICENSE)
