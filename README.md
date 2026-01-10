# Speedy.wasm - Nonlinear Speech Speedup for the Web

**Note:** This is an independent fork of Google's [speedy](https://github.com/google/speedy) project. It is **not** an officially supported Google product.

## Overview

**Speedy.wasm** brings Google's nonlinear speech speedup algorithm to the web using WebAssembly (via Emscripten).

The goal of this work is to allow speech to be sped up non-linearly, where vowels and unstressed portions are compressed more than consonants. This mimics how humans naturally speak faster, maintaining higher intelligibility compared to linear speedup (e.g., standard 2x playback).

This fork provides:
*   **WebAssembly Bindings:** `SpeedyStream` and `SonicStream` classes exposed to JavaScript.
*   **Zero-Copy Architecture:** Optimized data passing between JS and WASM to minimize garbage collection.
*   **AudioWorklet Support:** Designed for off-main-thread audio processing to keep the UI smooth.
*   **Browser-Ready:** Pre-compiled ES6 and UMD modules.
*   **Interactive Demo:** A feature-rich waveform visualizer and player.

## Quick Start

### Web Demo

A comprehensive demo is available in the `demo/` directory. It features:
*   Real-time nonlinear speedup processing.
*   Interactive waveform visualization.
*   Comparison with linear speedup.
*   Visual speed profile inspection.

To run the demo locally, serve the project root with a web server (required due to CORS/WASM restrictions):

```bash
# Example using python
python3 -m http.server 8000
# Open http://localhost:8000/demo/index.html
```

### Installation

Include the pre-built files from the `dist/` directory in your project.

**ES6 Module:**
```javascript
import initSpeedy, { SonicStream } from './dist/speedy.js';

async function main() {
  const Module = await initSpeedy();
  // Initialize stream: 44.1kHz, Mono
  const sonic = new SonicStream(44100, 1); 
  
  sonic.setSpeed(2.0); // Set 2x speed
  sonic.enableNonlinearSpeedup(1.0); // Enable full nonlinear processing
  
  // See docs/DEMO_IMPLEMENTATION_GUIDE.md for full API details
}
```

**UMD (Script Tag):**
```html
<script src="dist/speedy.umd.js"></script>
<script>
  SpeedyWasm().then(Module => {
    const sonic = new Module.SonicStream(44100, 1);
  });
</script>
```

## Building from Source

Requirements: [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html).

```bash
# Clone the repository with submodules
git clone --recursive https://github.com/your-username/speedy.wasm.git
cd speedy.wasm

# Build ES6 and UMD modules
make -f Makefile.emscripten all
```

This will generate the artifacts in `dist/`.

## Architecture & Implementation

This implementation focuses on performance for real-time applications:
*   **KissFFT:** Replaces FFTW for a lighter WASM footprint.
*   **Direct Memory Access:** Minimizes garbage collection overhead by allowing direct writing to the WASM heap.
*   **Speed Profile Sync:** Exposes the internal speed curve to allow precise synchronization with video or UI elements.

---

## Original Algorithm Context

*The following information describes the underlying algorithm developed by Google.*

Speedy is a reimplementation of the Mach1 algorithm published in: M. Covell, M. Withgott and M. Slaney, "MACH1: nonuniform time-scale modification of speech," Proceedings of the 1998 IEEE International Conference on Acoustics, Speech and Signal Processing, ICASSP '98. [IEEE Link](https://ieeexplore.ieee.org/document/674439).

Normal speed up algorithms change all the parts of the speech at the same rate, i.e. 2x. But when we speak faster, we don't say the words with constant speed. The vowels and unstressed portions of the sound are easy to speedup and are greatly time compressed. Consonants are already pretty short, are important to intelligibility, and are not sped up as much. Speedy attempts to replicate this idea in an automatic algorithm.

### Results

Speedy is designed to mimic the way that humans speak faster, and by doing so maintain the intelligibility of the original speech. In our case we measure intelligibility using the TOEFL audio tests. Using Speedy we sped up 9 sample stories by a factor of 3.5x, and then sped the story up linearly so that it has the same overall length. We play a random story to a subject, ask the comprehension questions, and then score their results. Their accuracy is a measure of comprehension.

The results of our study, using Amazon Turk subjects, is shown below. We saw significantly improved comprehension results.

![Speedy comprehension test results](g3doc/SpeedyComprehension.png)

### Notes and Implementation

The high-level flow chart for Speedy is shown below.
![Speedy speed control](g3doc/SpeedySpeedControl.png)

As part of this calculation the emphasis and relative speaking rate are calculated as shown below (where solid and dotted lines show signal dependencies). 

![Speedy emphasis and speed](g3doc/SpeedyFlowchart.png)

The plots below show the internal calculations for a single speaker speaking the sentence "A huge tapestry hung in her hallway."

![Speedy internal calculations](g3doc/SpeedyInternalCalculations.png)

## Credits

*   **Original Implementation:** [Google Speedy](https://github.com/google/speedy)
*   **Sonic Library:** [Sonic](https://github.com/waywardgeek/sonic)
*   **WASM Port:** [Claude Code]

## License

Apache 2.0 (See [LICENSE](LICENSE))