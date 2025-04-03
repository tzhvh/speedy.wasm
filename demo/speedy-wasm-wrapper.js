import Module from './speedy.js'; // Path to Emscripten's generated JS file

class SpeedyWasmWrapper {
    constructor() {
        this._module = null;
        this._wasmApi = null;
        this._streamPtr = null;
        this._inputBufferPtr = null;
        this._outputBufferPtr = null;
        this._inputBufferSize = 0; // In floats
        this._outputBufferSize = 0; // In floats
        this.sampleRate = 0;
        this.numChannels = 0;
    }

    async init() {
        if (this._module) return; // Already initialized

        this._module = await Module();

        // Expose WASM functions using cwrap
        this._wasmApi = {
            createStream: this._module.cwrap('sonicIntCreateStream', 'number', ['number', 'number']),
            destroyStream: this._module.cwrap('sonicIntDestroyStream', null, ['number']),
            writeFloat: this._module.cwrap('sonicIntWriteFloatToStream', 'number', ['number', 'number', 'number']),
            readFloat: this._module.cwrap('sonicIntReadFloatFromStream', 'number', ['number', 'number', 'number']),
            flush: this._module.cwrap('sonicIntFlushStream', 'number', ['number']),
            setSpeed: this._module.cwrap('sonicIntSetSpeed', null, ['number', 'number']),
            enableNonlinear: this._module.cwrap('sonicEnableNonlinearSpeedup', null, ['number', 'number']),
            setDurationFeedback: this._module.cwrap('sonicSetDurationFeedbackStrength', null, ['number', 'number']),
            getNumChannels: this._module.cwrap('sonicIntGetNumChannels', 'number', ['number']),
            getSampleRate: this._module.cwrap('sonicIntGetSampleRate', 'number', ['number']),
            samplesAvailable: this._module.cwrap('sonicIntSamplesAvailable', 'number', ['number']),
            malloc: this._module._malloc,
            free: this._module._free,
        };
        console.log("Speedy WASM module initialized.");
    }

    create(sampleRate, numChannels, inputBufferSize = 8192, outputBufferSize = 16384) {
        if (!this._wasmApi) throw new Error("WASM module not initialized. Call init() first.");
        if (this._streamPtr) this.destroy(); // Clean up previous stream if any

        this.sampleRate = sampleRate;
        this.numChannels = numChannels;
        this._streamPtr = this._wasmApi.createStream(sampleRate, numChannels);
        if (!this._streamPtr) {
            throw new Error("Failed to create Speedy stream.");
        }

        // Allocate persistent buffers in WASM heap
        this._inputBufferSize = inputBufferSize;
        this._outputBufferSize = outputBufferSize;
        // Size is in bytes: num floats * num channels * sizeof(float)
        this._inputBufferPtr = this._wasmApi.malloc(inputBufferSize * numChannels * 4);
        this._outputBufferPtr = this._wasmApi.malloc(outputBufferSize * numChannels * 4);

        if (!this._inputBufferPtr || !this._outputBufferPtr) {
            this.destroy(); // Clean up partial allocation
            throw new Error("Failed to allocate WASM memory buffers.");
        }
        console.log(`Speedy stream created (ptr: ${this._streamPtr}) for ${numChannels}ch @ ${sampleRate}Hz`);
    }

    _getWasmInputBufferView() {
        // Get a Float32Array view into the WASM heap for the input buffer
        return new Float32Array(this._module.HEAPF32.buffer, this._inputBufferPtr, this._inputBufferSize * this.numChannels);
    }

     _getWasmOutputBufferView() {
        // Get a Float32Array view into the WASM heap for the output buffer
        return new Float32Array(this._module.HEAPF32.buffer, this._outputBufferPtr, this._outputBufferSize * this.numChannels);
    }

    process(inputFloat32Array) {
        if (!this._streamPtr) throw new Error("Stream not created. Call create() first.");
        if (!(inputFloat32Array instanceof Float32Array)) {
            throw new Error("Input must be a Float32Array.");
        }
        if (inputFloat32Array.length % this.numChannels !== 0) {
             throw new Error(`Input length (${inputFloat32Array.length}) must be a multiple of the number of channels (${this.numChannels}).`);
        }

        const inputSamplesPerChannel = inputFloat32Array.length / this.numChannels;
        const wasmInputBufferView = this._getWasmInputBufferView();

        // Check if input fits in WASM buffer
        if (inputFloat32Array.length > wasmInputBufferView.length) {
            console.warn(`Input data (${inputFloat32Array.length} floats) larger than allocated WASM input buffer (${wasmInputBufferView.length} floats). Truncating.`);
            // Optionally handle resizing or erroring instead of truncating
             inputFloat32Array = inputFloat32Array.subarray(0, wasmInputBufferView.length);
        }

        // Copy input data to WASM heap
        wasmInputBufferView.set(inputFloat32Array);

        // Write data to Speedy/Sonic stream
        // sonicWriteFloatToStream expects samples *per channel* as count
        const samplesWritten = this._wasmApi.writeFloat(this._streamPtr, this._inputBufferPtr, inputSamplesPerChannel);
        if (!samplesWritten) {
            console.error("Failed to write samples to Speedy stream.");
            return new Float32Array(0); // Return empty array on failure
        }

        // Read processed data
        const wasmOutputBufferView = this._getWasmOutputBufferView();
        const samplesReadPerChannel = this._wasmApi.readFloat(this._streamPtr, this._outputBufferPtr, this._outputBufferSize);

        if (samplesReadPerChannel > 0) {
             // Create a new JS Float32Array and copy the data from WASM heap
            const totalSamplesRead = samplesReadPerChannel * this.numChannels;
            const outputData = new Float32Array(totalSamplesRead);
            outputData.set(wasmOutputBufferView.subarray(0, totalSamplesRead));
            return outputData;
        } else {
            return new Float32Array(0); // No data ready
        }
    }

    flush() {
        if (!this._streamPtr) throw new Error("Stream not created.");

        const flushed = this._wasmApi.flush(this._streamPtr);
        if (!flushed) {
             console.error("Failed to flush Speedy stream.");
        }

        let outputChunks = [];
        let totalSamplesRead = 0;
        const wasmOutputBufferView = this._getWasmOutputBufferView();

        while (true) {
            // Keep reading until no more samples are available after flushing
            const samplesReadPerChannel = this._wasmApi.readFloat(this._streamPtr, this._outputBufferPtr, this._outputBufferSize);
            if (samplesReadPerChannel <= 0) {
                break; // No more data
            }

            const currentChunkSamples = samplesReadPerChannel * this.numChannels;
            const chunk = new Float32Array(currentChunkSamples);
            chunk.set(wasmOutputBufferView.subarray(0, currentChunkSamples));
            outputChunks.push(chunk);
            totalSamplesRead += currentChunkSamples;
        }

        if (outputChunks.length === 0) {
            return new Float32Array(0);
        } else if (outputChunks.length === 1) {
            return outputChunks[0];
        } else {
            // Concatenate chunks if multiple reads were needed
            const finalOutput = new Float32Array(totalSamplesRead);
            let offset = 0;
            for (const chunk of outputChunks) {
                finalOutput.set(chunk, offset);
                offset += chunk.length;
            }
            return finalOutput;
        }
    }

    setSpeed(speed) {
        if (!this._streamPtr) throw new Error("Stream not created.");
        this._wasmApi.setSpeed(this._streamPtr, speed);
    }

    enableNonlinear(enable) {
        if (!this._streamPtr) throw new Error("Stream not created.");
        this._wasmApi.enableNonlinear(this._streamPtr, enable ? 1.0 : 0.0);
    }

     setDurationFeedback(strength) {
        if (!this._streamPtr) throw new Error("Stream not created.");
        this._wasmApi.setDurationFeedback(this._streamPtr, strength);
    }

    destroy() {
        if (this._streamPtr) {
            this._wasmApi.destroyStream(this._streamPtr);
            this._streamPtr = null;
        }
        if (this._inputBufferPtr) {
            this._wasmApi.free(this._inputBufferPtr);
            this._inputBufferPtr = null;
            this._inputBufferSize = 0;
        }
        if (this._outputBufferPtr) {
            this._wasmApi.free(this._outputBufferPtr);
            this._outputBufferPtr = null;
            this._outputBufferSize = 0;
        }
        this.sampleRate = 0;
        this.numChannels = 0;
        console.log("Speedy stream and buffers destroyed.");
    }
}

export default SpeedyWasmWrapper;