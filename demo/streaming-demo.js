import { AudioRingBuffer } from './ring-buffer.js';

class StreamingDemo {
    constructor() {
        this.context = null;
        this.workletNode = null;
        this.ringBuffer = null;
        this.sourceBuffer = null;
        this.isPlaying = false;
        this.pushInterval = null;
        
        // UI
        this.logEl = document.getElementById('statusLog');
        this.speedSlider = document.getElementById('speed');
        this.bufferMeter = document.getElementById('bufferLevel');
        
        this.bindEvents();
    }
    
    log(msg) {
        const line = document.createElement('div');
        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        this.logEl.appendChild(line);
        this.logEl.scrollTop = this.logEl.scrollHeight;
    }
    
    bindEvents() {
        document.getElementById('audioFile').addEventListener('change', e => this.loadFile(e));
        document.getElementById('playBtn').addEventListener('click', () => this.startStreaming());
        document.getElementById('stopBtn').addEventListener('click', () => this.stop());
        
        this.speedSlider.addEventListener('input', e => {
            const val = parseFloat(e.target.value);
            document.getElementById('speedVal').textContent = val.toFixed(1);
            if (this.workletNode) {
                this.workletNode.port.postMessage({ type: 'setSpeed', payload: val });
            }
        });
    }
    
    async loadFile(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        this.log(`Loading ${file.name}...`);
        
        try {
            const arrayBuffer = await file.arrayBuffer();
            this.context = new (window.AudioContext || window.webkitAudioContext)();
            this.sourceBuffer = await this.context.decodeAudioData(arrayBuffer);
            
            this.log(`Decoded: ${this.sourceBuffer.duration.toFixed(2)}s, ${this.sourceBuffer.sampleRate}Hz`);
            
            document.getElementById('playBtn').disabled = false;
        } catch (e) {
            this.log('Error decoding: ' + e.message);
        }
    }
    
    async initAudioWorklet() {
        if (this.workletNode) return;
        
        this.log('Initializing AudioWorklet...');
        
        try {
            await this.context.audioWorklet.addModule('speedy-worklet.js');
            
            // Create Ring Buffer (1 second buffer)
            const capacity = this.context.sampleRate * 1; 
            const channels = 1; // Mono for now (simplifies demo)
            
            this.ringBuffer = new AudioRingBuffer(capacity, channels);
            
            this.workletNode = new AudioWorkletNode(this.context, 'speedy-processor', {
                processorOptions: {
                    ringBuffer: this.ringBuffer.sharedBuffer,
                    capacity: capacity,
                    channels: channels
                },
                outputChannelCount: [channels]
            });
            
            this.workletNode.connect(this.context.destination);
            
            this.workletNode.port.onmessage = (e) => {
                if (e.data.type === 'ready') {
                    this.log('Worklet Ready!');
                    // Set initial speed
                    this.workletNode.port.postMessage({ 
                        type: 'setSpeed', 
                        payload: parseFloat(this.speedSlider.value) 
                    });
                    
                    // Enable nonlinear for demo
                    this.workletNode.port.postMessage({ type: 'setNonlinear', payload: 1.0 });
                } else if (e.data.type === 'speedProfile') {
                     const profile = e.data.payload;
                     // Profile is [time1, speed1, time2, speed2...]
                     // Just show the last one for now to prove it works
                     if (profile.length >= 2) {
                         const lastSpeed = profile[profile.length - 1];
                         const lastTime = profile[profile.length - 2]; // Frame index
                         // Update a debug element (if exists) or just log occasionally
                         if (Math.random() < 0.05) { // Throttle logs
                             // this.log(`Speedy Sync: Frame ${lastTime} -> Speed ${lastSpeed.toFixed(3)}x`);
                         }
                         document.getElementById('realtimeSpeed').textContent = lastSpeed.toFixed(3) + 'x';
                     }
                }
            };
            
        } catch (e) {
            this.log('Worklet Error: ' + e.message);
            throw e;
        }
    }
    
    async startStreaming() {
        if (this.isPlaying) return;
        if (!this.sourceBuffer) return;
        
        await this.context.resume();
        await this.initAudioWorklet();
        
        this.isPlaying = true;
        document.getElementById('playBtn').disabled = true;
        document.getElementById('stopBtn').disabled = false;
        
        // Start "Streaming" Simulation
        // We will push chunks of audio into the Ring Buffer periodically
        
        const channels = 1; // Force mono
        const rawData = this.getMonoData(this.sourceBuffer);
        
        let offset = 0;
        const chunkSize = 4096;
        
        this.log('Streaming started...');
        
        const pushLoop = () => {
            if (!this.isPlaying) return;
            
            // Push as much as we can fit
            const availableSpace = this.ringBuffer.capacity - this.ringBuffer.available();
            
            // Keep buffer ~80% full
            if (this.ringBuffer.available() < this.ringBuffer.capacity * 0.8) {
                const toWrite = Math.min(chunkSize * 4, rawData.length - offset);
                
                if (toWrite > 0) {
                    const chunk = rawData.subarray(offset, offset + toWrite);
                    // Wrap in array of channels
                    const success = this.ringBuffer.write([chunk]);
                    
                    if (success) {
                        offset += toWrite;
                        if (offset >= rawData.length) {
                            this.log('End of file reached');
                            this.stop();
                            return;
                        }
                    }
                }
            }
            
            // Update UI Meter
            const fill = (this.ringBuffer.available() / this.ringBuffer.capacity) * 100;
            this.bufferMeter.style.width = `${fill}%`;
            
            this.pushInterval = requestAnimationFrame(pushLoop);
        };
        
        pushLoop();
    }
    
    stop() {
        this.isPlaying = false;
        if (this.pushInterval) cancelAnimationFrame(this.pushInterval);
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }
        document.getElementById('playBtn').disabled = false;
        document.getElementById('stopBtn').disabled = true;
        this.log('Stopped');
    }
    
    getMonoData(audioBuffer) {
        if (audioBuffer.numberOfChannels === 1) return audioBuffer.getChannelData(0);
        const left = audioBuffer.getChannelData(0);
        const right = audioBuffer.getChannelData(1);
        const mono = new Float32Array(left.length);
        for(let i=0; i<left.length; i++) mono[i] = (left[i] + right[i]) / 2;
        return mono;
    }
}

new StreamingDemo();
