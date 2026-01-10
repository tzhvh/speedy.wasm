export class AudioRingBuffer {
    constructor(capacity, channelCount) {
        this.capacity = capacity;
        this.channelCount = channelCount;
        
        // Memory Layout:
        // [0]: writeIndex (int32) - volatile
        // [1]: readIndex (int32) - volatile
        // [2...]: data (float32)
        
        // Header size in bytes (2 * 4 bytes)
        const headerSize = 8;
        // Data size in bytes
        const dataSize = capacity * channelCount * 4;
        
        this.sharedBuffer = new SharedArrayBuffer(headerSize + dataSize);
        this.view = new DataView(this.sharedBuffer);
        this.header = new Int32Array(this.sharedBuffer, 0, 2);
        this.storage = new Float32Array(this.sharedBuffer, headerSize);
    }
    
    // Called from Main Thread
    write(inputData) {
        // inputData is array of Float32Arrays (one per channel)
        const inputLen = inputData[0].length;
        const writeIndex = Atomics.load(this.header, 0);
        const readIndex = Atomics.load(this.header, 1);
        
        let availableSpace;
        if (writeIndex >= readIndex) {
            availableSpace = this.capacity - (writeIndex - readIndex);
        } else {
            availableSpace = readIndex - writeIndex;
        }
        
        if (availableSpace < inputLen + 1) { // +1 for safety
            return false; // Buffer overflow
        }
        
        // Write data
        for (let i = 0; i < inputLen; i++) {
            const pos = (writeIndex + i) % this.capacity;
            for (let ch = 0; ch < this.channelCount; ch++) {
                this.storage[pos * this.channelCount + ch] = inputData[ch][i];
            }
        }
        
        // Update write pointer
        Atomics.store(this.header, 0, (writeIndex + inputLen) % this.capacity);
        return true;
    }
    
    // Called from Audio Thread
    read(outputData, count) {
        // outputData is array of Float32Arrays to fill
        const writeIndex = Atomics.load(this.header, 0);
        const readIndex = Atomics.load(this.header, 1);
        
        let available;
        if (writeIndex >= readIndex) {
            available = writeIndex - readIndex;
        } else {
            available = this.capacity - (readIndex - writeIndex);
        }
        
        if (available < count) {
            return false; // Underflow
        }
        
        for (let i = 0; i < count; i++) {
            const pos = (readIndex + i) % this.capacity;
            for (let ch = 0; ch < this.channelCount; ch++) {
                outputData[ch][i] = this.storage[pos * this.channelCount + ch];
            }
        }
        
        Atomics.store(this.header, 1, (readIndex + count) % this.capacity);
        return true;
    }
    
    available() {
        const writeIndex = Atomics.load(this.header, 0);
        const readIndex = Atomics.load(this.header, 1);
        if (writeIndex >= readIndex) {
            return writeIndex - readIndex;
        } else {
            return this.capacity - (readIndex - writeIndex);
        }
    }
}
