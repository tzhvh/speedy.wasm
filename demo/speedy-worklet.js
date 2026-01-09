import initSpeedy from '../dist/speedy.js';
import { AudioRingBuffer } from './ring-buffer.js';

class SpeedyProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ready = false;
    this.sonic = null;
    this.ringBuffer = null;
    this.inputBufferPtr = 0;
    this.outputBufferPtr = 0;
    this.bufferSize = 4096; // Max chunks size for Sonic
    this.channels = 1; // Default
    
    if (options.processorOptions && options.processorOptions.ringBuffer) {
        // Reconstruct RingBuffer from SharedArrayBuffer
        const sab = options.processorOptions.ringBuffer;
        const capacity = options.processorOptions.capacity;
        const channels = options.processorOptions.channels;
        this.channels = channels;
        
        // Hack: We need to manually reconstruct the class wrapper since we can't pass the object prototype
        this.ringBuffer = {
             header: new Int32Array(sab, 0, 2),
             storage: new Float32Array(sab, 8),
             capacity: capacity,
             channelCount: channels,
             read: function(outputData, count) {
                const writeIndex = Atomics.load(this.header, 0);
                const readIndex = Atomics.load(this.header, 1);
                
                let available;
                if (writeIndex >= readIndex) {
                    available = writeIndex - readIndex;
                } else {
                    available = this.capacity - (readIndex - writeIndex);
                }
                
                if (available < count) return false;
                
                for (let i = 0; i < count; i++) {
                    const pos = (readIndex + i) % this.capacity;
                    for (let ch = 0; ch < this.channelCount; ch++) {
                        outputData[ch][i] = this.storage[pos * this.channelCount + ch];
                    }
                }
                
                Atomics.store(this.header, 1, (readIndex + count) % this.capacity);
                return true;
             },
             available: function() {
                const writeIndex = Atomics.load(this.header, 0);
                const readIndex = Atomics.load(this.header, 1);
                if (writeIndex >= readIndex) return writeIndex - readIndex;
                return this.capacity - (readIndex - writeIndex);
             }
        };
    }

    this.port.onmessage = this.handleMessage.bind(this);
    this.initWasm();
  }

  async initWasm() {
    try {
        const module = await initSpeedy();
        this.SonicStream = module.SonicStream;
        
        // Allocate memory for data transfer
        // We use 4096 samples as internal chunk size
        const bytesPerSample = 4;
        this.inputBufferPtr = module._malloc(this.bufferSize * this.channels * bytesPerSample);
        this.outputBufferPtr = module._malloc(this.bufferSize * this.channels * bytesPerSample);
        
        // Create Sonic Stream
        // Sample rate is fixed in AudioWorklet (usually 44100 or 48000)
        this.sonic = new this.SonicStream(sampleRate, this.channels);
        
        this.ready = true;
        this.port.postMessage({ type: 'ready' });
    } catch (e) {
        console.error('SpeedyWorklet Error:', e);
        this.port.postMessage({ type: 'error', message: e.toString() });
    }
  }

  handleMessage(event) {
    if (!this.ready) return;
    
    const { type, payload } = event.data;
    switch (type) {
        case 'setSpeed':
            this.sonic.setSpeed(payload);
            break;
        case 'setPitch':
            this.sonic.setRate(payload);
            break;
    }
  }

  process(inputs, outputs, parameters) {
    if (!this.ready || !this.ringBuffer) return true;

    const output = outputs[0];
    const frameCount = output[0].length; // Usually 128
    
    // 1. Pull data from Ring Buffer
    // We need to decide how much to pull. Sonic needs input to produce output.
    // If speed is 2.0, we need ~256 input samples to get 128 output samples.
    // Strategy: Pull as much as available (up to buffer limit), write to Sonic, then read 128.
    
    const available = this.ringBuffer.available();
    
    // We limit the read to our temp buffer size
    const toRead = Math.min(available, this.bufferSize);
    
    if (toRead > 0) {
        // Create views on WASM heap
        // Note: For now we copy from RingBuffer -> JS Array -> WASM Heap
        // Optimization: RingBuffer could map directly to WASM memory if we pass the WASM memory buffer to JS...
        // But for now, let's use the pointer approach.
        
        // We need a temp JS buffer to read from RingBuffer
        // (Optimizable later)
        const tempInput = [];
        for(let c=0; c<this.channels; c++) tempInput[c] = new Float32Array(toRead);
        
        this.ringBuffer.read(tempInput, toRead);
        
        // Interleave if multi-channel (Sonic expects interleaved if channels > 1??)
        // Checking bindings.cpp... 
        // writeFloatToStream uses `sonicWriteFloatToStream`.
        // sonicWriteFloatToStream expects interleaved? "inBuffer points to the data... numSamples is per channel".
        // Usually audio libs expect interleaved [L, R, L, R].
        
        const heap = new Float32Array(this.module.HEAPF32.buffer, this.inputBufferPtr, toRead * this.channels);
        
        if (this.channels === 1) {
            heap.set(tempInput[0]);
        } else {
            for (let i = 0; i < toRead; i++) {
                for (let c = 0; c < this.channels; c++) {
                    heap[i * this.channels + c] = tempInput[c][i];
                }
            }
        }
        
        // Write to Sonic (using pointer)
        this.sonic.writeFloatToStreamPtr(this.inputBufferPtr, toRead);
    }
    
    // 2. Read from Sonic
    // We want exactly 'frameCount' samples
    
    const samplesRead = this.sonic.readFloatFromStreamPtr(this.outputBufferPtr, frameCount);
    
    if (samplesRead > 0) {
        const heapOut = new Float32Array(this.module.HEAPF32.buffer, this.outputBufferPtr, samplesRead * this.channels);
        
        // De-interleave to output
        if (this.channels === 1) {
            output[0].set(heapOut);
        } else {
            for (let i = 0; i < samplesRead; i++) {
                 for (let c = 0; c < this.channels; c++) {
                     output[c][i] = heapOut[i * this.channels + c];
                 }
            }
        }
        
        // If we didn't get enough samples, pad with silence?
        // Or just let it be (it will be 0 from previous buffer or empty). 
        // AudioWorklet buffers are zero-initialized by host? usually.
    }
    
    return true;
  }
}

registerProcessor('speedy-processor', SpeedyProcessor);
