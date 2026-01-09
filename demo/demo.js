import initSpeedy from '../dist/speedy.js';
import { WaveformViewer } from './waveform.js';

class SpeedyDemo {
    constructor() {
        this.audioContext = null;
        this.sourceNode = null;
        this.originalBuffer = null;
        this.processedBuffer = null;
        this.isProcessing = false;
        this.moduleLoaded = false;
        this.SonicStream = null;

        // Playback state
        this.playbackState = {
            isPlaying: false,
            isPaused: false,
            startTime: 0,
            pauseTime: 0,
            currentBuffer: null,
            animationId: null,
            duration: 0
        };
        
        // UI Elements
        this.statusEl = document.getElementById('status');
        this.processBtn = document.getElementById('processBtn');
        this.stopBtn = document.getElementById('stopBtn');
        this.fileInput = document.getElementById('audioFile');
        this.canvas = document.getElementById('waveformCanvas');
        this.indicator = document.getElementById('processingIndicator');

        // Waveform Viewer
        this.waveformViewer = new WaveformViewer(this.canvas);
        
        // Parameters
        this.params = {
            speed: 2.0,
            nonlinear: 1.0,
            feedback: 0.1
        };

        this.stats = {
            input: {},
            output: {},
            perf: {}
        };

        this.bindEvents();
        this.bindWaveformEvents();
    }

    bindEvents() {
        // Parameter inputs
        ['speed', 'nonlinear', 'feedback'].forEach(id => {
            const el = document.getElementById(id);
            const valEl = document.getElementById(id + 'Val');
            el.addEventListener('input', (e) => {
                this.params[id] = parseFloat(e.target.value);
                valEl.textContent = this.params[id] + (id === 'speed' ? 'x' : '');
            });
        });

        // File input
        this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

        // Process button
        this.processBtn.addEventListener('click', () => this.processAndPlay());
        this.stopBtn.addEventListener('click', () => this.stopPlayback());

        // Playback controls
        document.getElementById('playOriginalBtn').addEventListener('click', () => {
            this.switchToBuffer('original');
        });

        document.getElementById('playProcessedBtn').addEventListener('click', () => {
            this.switchToBuffer('processed');
        });

        document.getElementById('pauseBtn').addEventListener('click', () => {
            if (this.playbackState.isPaused) {
                this.resumePlayback();
            } else {
                this.pausePlayback();
            }
        });

        // Theme Toggle
        const themeBtn = document.getElementById('themeToggle');
        const setTheme = (theme) => {
            document.documentElement.setAttribute('data-theme', theme);
            localStorage.setItem('theme', theme);
            themeBtn.textContent = theme === 'dark' ? 'LIGHT MODE' : 'DARK MODE';
            // Update waveform colors
            if (this.waveformViewer) {
                 this.waveformViewer.updateThemeColors();
                 this.waveformViewer.draw();
            }
        };

        // Init theme
        const savedTheme = localStorage.getItem('theme') || 'dark';
        setTheme(savedTheme);

        themeBtn.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme');
            setTheme(current === 'dark' ? 'light' : 'dark');
        });
    }

    bindWaveformEvents() {
        // Connect waveform viewer callbacks
        this.waveformViewer.onSeek = (time) => {
             if (!this.originalBuffer && !this.processedBuffer) return;
             
             // Determine buffer to use
             let buffer = null;
             let bufferType = this.playbackState.currentBuffer;

             if (bufferType === 'original' && this.originalBuffer) {
                 buffer = this.originalBuffer;
             } else if (bufferType === 'processed' && this.processedBuffer) {
                 buffer = this.processedBuffer;
             } else if (this.originalBuffer) {
                 buffer = this.originalBuffer;
                 bufferType = 'original';
             } else if (this.processedBuffer) {
                 buffer = this.processedBuffer;
                 bufferType = 'processed';
             }

             if (buffer) {
                 // Clamp time
                 time = Math.max(0, Math.min(time, buffer.duration));
                 
                 this.stopPlayback();
                 this.playBuffer(buffer, bufferType, time);
             }
        };
        
        this.waveformViewer.onZoom = (level) => {
            document.getElementById('zoomLevel').value = level;
        };

        this.waveformViewer.onModeChange = (mode) => {
            document.getElementById('viewMode').value = mode;
        };
        
        // Connect UI controls
        document.getElementById('viewMode').addEventListener('change', (e) => {
            this.waveformViewer.setScaleMode(e.target.value);
        });
        
        document.getElementById('inspectMode').addEventListener('change', (e) => {
            this.waveformViewer.setInspectMode(e.target.checked);
        });
        
        document.getElementById('zoomToSelectBtn').addEventListener('click', () => {
            const mode = this.waveformViewer.zoomToSelection();
            if (mode) {
                document.getElementById('viewMode').value = mode;
            }
        });
        
        document.getElementById('zoomLevel').addEventListener('input', (e) => {
            this.waveformViewer.setZoom(parseFloat(e.target.value));
        });
    }

    log(msg) {
        this.statusEl.textContent = msg;
        console.log(msg);
    }

    updateDisplayStats() {
        const s = document.getElementById('statsContainer');
        s.style.display = 'block';

        // Input
        if (this.stats.input.duration) {
            document.getElementById('inDuration').textContent = this.stats.input.duration.toFixed(3) + 's';
            document.getElementById('inSampleRate').textContent = this.stats.input.sampleRate + ' Hz';
            document.getElementById('inChannels').textContent = this.stats.input.channels;
            document.getElementById('inSamples').textContent = this.stats.input.length.toLocaleString();
        }

        // Params
        document.getElementById('paramSpeed').textContent = this.params.speed.toFixed(1) + 'x';
        document.getElementById('paramNonlinear').textContent = this.params.nonlinear.toFixed(1);

        // Perf
        if (this.stats.perf.timeMs) {
            document.getElementById('procTime').textContent = this.stats.perf.timeMs.toFixed(1) + ' ms';
            const rtf = this.stats.input.duration / (this.stats.perf.timeMs / 1000);
            document.getElementById('rtFactor').textContent = rtf.toFixed(1) + 'x';
        } else {
            document.getElementById('procTime').textContent = '-';
            document.getElementById('rtFactor').textContent = '-';
        }

        // Output
        if (this.stats.output.duration) {
            document.getElementById('outDuration').textContent = this.stats.output.duration.toFixed(3) + 's';
            document.getElementById('outSamples').textContent = this.stats.output.length.toLocaleString();

            const ratio = (this.stats.input.duration / this.stats.output.duration).toFixed(2);
            document.getElementById('compressionRatio').textContent = ratio + 'x';

            // Est WAV size (16-bit mono)
            const bytes = this.stats.output.length * 2;
            document.getElementById('outSize').textContent = (bytes / 1024).toFixed(1) + ' KB';
        } else {
            document.getElementById('outDuration').textContent = '-';
            document.getElementById('outSamples').textContent = '-';
            document.getElementById('compressionRatio').textContent = '-';
            document.getElementById('outSize').textContent = '-';
        }
    }

    analyzeAudio(float32Array) {
        let sum = 0;
        let sumSquares = 0;
        let peak = 0;

        for (let i = 0; i < float32Array.length; i++) {
            const sample = Math.abs(float32Array[i]);
            sum += sample;
            sumSquares += sample * sample;
            if (sample > peak) peak = sample;
        }

        return {
            peak: peak.toFixed(3),
            rms: Math.sqrt(sumSquares / float32Array.length).toFixed(3)
        };
    }

    updateAudioAnalysisDisplay(inputData, outputData, chunkCount) {
        const a = document.getElementById('audioAnalysisContainer');
        a.style.display = 'block';

        const inputAnalysis = this.analyzeAudio(inputData);
        document.getElementById('inPeak').textContent = inputAnalysis.peak;
        document.getElementById('inRMS').textContent = inputAnalysis.rms;

        if (outputData) {
            const outputAnalysis = this.analyzeAudio(outputData);
            document.getElementById('outPeak').textContent = outputAnalysis.peak;
            document.getElementById('outRMS').textContent = outputAnalysis.rms;
        }

        document.getElementById('chunksProcessed').textContent = chunkCount;
    }

    updateTimeDisplay(current, total) {
        const fmt = (t) => {
            const m = Math.floor(t / 60);
            const s = Math.floor(t % 60);
            return `${m}:${s.toString().padStart(2, '0')}`;
        };
        document.getElementById('timeDisplay').textContent = `${fmt(current)} / ${fmt(total)}`;
    }

    updateButtonStates() {
        const playOriginalBtn = document.getElementById('playOriginalBtn');
        const playProcessedBtn = document.getElementById('playProcessedBtn');
        const pauseBtn = document.getElementById('pauseBtn');

        playOriginalBtn.disabled = !this.originalBuffer;
        playProcessedBtn.disabled = !this.processedBuffer;
        pauseBtn.disabled = !this.playbackState.isPlaying;
        pauseBtn.textContent = this.playbackState.isPaused ? 'Resume' : 'Pause';

        // Update active button styling
        playOriginalBtn.classList.toggle('active', this.playbackState.currentBuffer === 'original' && this.playbackState.isPlaying && !this.playbackState.isPaused);
        playProcessedBtn.classList.toggle('active', this.playbackState.currentBuffer === 'processed' && this.playbackState.isPlaying && !this.playbackState.isPaused);
    }

    pausePlayback() {
        if (this.sourceNode && this.playbackState.isPlaying && !this.playbackState.isPaused) {
            this.playbackState.isPaused = true;
            this.playbackState.pauseTime = this.audioContext.currentTime;
            this.sourceNode.stop();
            this.sourceNode = null;
            cancelAnimationFrame(this.playbackState.animationId);
            this.updateButtonStates();
            
            this.waveformViewer.setPlaybackState(
                this.playbackState.isPlaying && !this.playbackState.isPaused, 
                this.playbackState.pauseTime - this.playbackState.startTime,
                this.playbackState.currentBuffer
            );
        }
    }

    resumePlayback() {
        if (this.playbackState.isPaused) {
            const elapsed = this.playbackState.pauseTime - this.playbackState.startTime;
            const buffer = this.playbackState.currentBuffer === 'original' ? this.originalBuffer : this.processedBuffer;
            if (buffer) {
                this.playBuffer(buffer, this.playbackState.currentBuffer, elapsed);
            }
        }
    }

    playBuffer(buffer, bufferType, offset = 0) {
        this.sourceNode = this.audioContext.createBufferSource();
        this.sourceNode.buffer = buffer;
        this.sourceNode.connect(this.audioContext.destination);

        this.playbackState.isPlaying = true;
        this.playbackState.isPaused = false;
        this.playbackState.startTime = this.audioContext.currentTime - offset;
        this.playbackState.duration = buffer.duration;
        this.playbackState.currentBuffer = bufferType;

        this.sourceNode.start(0, offset);
        this.startPlaybackAnimation();
        this.updateButtonStates();

        this.sourceNode.onended = () => {
            if (this.playbackState.isPlaying && !this.playbackState.isPaused) {
                this.playbackState.isPlaying = false;
                this.playbackState.currentBuffer = null;
                cancelAnimationFrame(this.playbackState.animationId);
                this.updateButtonStates();
                this.log('Playback finished');
                
                this.waveformViewer.setPlaybackState(false, 0, null);
            }
        };
    }

    switchToBuffer(bufferType) {
        const buffer = bufferType === 'original' ? this.originalBuffer : this.processedBuffer;
        if (!buffer) return;

        if (this.playbackState.isPlaying && !this.playbackState.isPaused) {
            const elapsed = (this.audioContext.currentTime - this.playbackState.startTime) % this.playbackState.duration;
            this.stopPlayback();
            this.playBuffer(buffer, bufferType, elapsed);
        } else {
            this.playBuffer(buffer, bufferType, 0);
        }
    }

    startPlaybackAnimation() {
        const animate = () => {
            if (!this.playbackState.isPlaying || this.playbackState.isPaused) {
                this.playbackState.animationId = null;
                return;
            }

            const elapsed = (this.audioContext.currentTime - this.playbackState.startTime) % this.playbackState.duration;
            
            this.waveformViewer.setPlaybackState(true, elapsed, this.playbackState.currentBuffer);

            this.updateTimeDisplay(elapsed, this.playbackState.duration);
            this.playbackState.animationId = requestAnimationFrame(animate);
        };

        this.playbackState.animationId = requestAnimationFrame(animate);
    }

    async initialize() {
        try {
            this.log('Loading WASM module...');
            const Module = await initSpeedy();
            this.SonicStream = Module.SonicStream;
            this.moduleLoaded = true;
            this.log('Ready. Select an audio file.');
            
            // Init AudioContext on first user interaction if needed
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            this.log(`Error loading WASM: ${e.message}`);
            console.error(e);
        }
    }

    async handleFileSelect(e) {
        if (!e.target.files.length) return;
        
        const file = e.target.files[0];
        this.processBtn.disabled = true;
        this.stopBtn.disabled = true;
        
        try {
            this.log(`Loading ${file.name}...`);
            const arrayBuffer = await file.arrayBuffer();
            this.log('Decoding audio...');
            this.originalBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
            
            this.log(`Loaded: ${this.originalBuffer.duration.toFixed(2)}s, ${this.originalBuffer.numberOfChannels}ch, ${this.originalBuffer.sampleRate}Hz`);
            this.processBtn.disabled = !this.moduleLoaded;

            // Enable playback button for original audio
            this.updateButtonStates();
            
            // Update Stats
            this.stats.input = {
                duration: this.originalBuffer.duration,
                sampleRate: this.originalBuffer.sampleRate,
                channels: this.originalBuffer.numberOfChannels,
                length: this.originalBuffer.length
            };
            this.stats.output = {}; // Clear output stats
            this.stats.perf = {};   // Clear perf stats
            this.updateDisplayStats();

            // Set data to viewer
            this.waveformViewer.setData(this.originalBuffer, null);
            
        } catch (err) {
            this.log(`Error loading file: ${err.message}`);
        }
    }

    async processAndPlay() {
        if (!this.originalBuffer || this.isProcessing) return;
        
        this.isProcessing = true;
        this.processBtn.disabled = true;
        this.stopBtn.disabled = true;
        this.indicator.style.display = 'inline-block';
        
        const startTime = performance.now();

        try {
            this.stopPlayback();
            this.log('Processing...');
            
            // Create SonicStream
            const channels = 1; // Force mono
            const sampleRate = this.originalBuffer.sampleRate;
            
            const sonic = new this.SonicStream(sampleRate, channels);
            sonic.setSpeed(this.params.speed);
            sonic.enableNonlinearSpeedup(this.params.nonlinear);
            sonic.setDurationFeedbackStrength(this.params.feedback);
            
            // Prepare input data
            const inputData = this.getMonoData(this.originalBuffer);
            
            // Process in chunks
            const chunkSize = 8192;
            const outputChunks = [];
            
            for (let offset = 0; offset < inputData.length; offset += chunkSize) {
                const chunk = inputData.subarray(offset, offset + chunkSize);

                sonic.writeFloatToStream(chunk, chunk.length);

                let output;
                while ((output = sonic.readFloatFromStream(chunkSize))) {
                    outputChunks.push(output);
                }

                if (offset % (chunkSize * 10) === 0) {
                    const progress = Math.round((offset / inputData.length) * 100);
                    this.log(`Processing... ${progress}%`);
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            sonic.flushStream();
            let output;
            while ((output = sonic.readFloatFromStream(chunkSize))) {
                outputChunks.push(output);
            }

            const endTime = performance.now();
            const procTime = endTime - startTime;

            const totalLength = outputChunks.reduce((sum, c) => sum + c.length, 0);

            const result = new Float32Array(totalLength);
            let offset = 0;
            for (const chunk of outputChunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }
            
            this.processedBuffer = this.audioContext.createBuffer(1, totalLength, sampleRate);
            this.processedBuffer.copyToChannel(result, 0);
            
            this.log(`Done! Original: ${this.originalBuffer.duration.toFixed(2)}s, Processed: ${this.processedBuffer.duration.toFixed(2)}s`);

            this.stats.perf = { timeMs: procTime };
            this.stats.output = {
                duration: this.processedBuffer.duration,
                length: totalLength
            };
            this.updateDisplayStats();
            this.updateAudioAnalysisDisplay(inputData, result, outputChunks.length);

            // Update viewer
            this.waveformViewer.setData(this.originalBuffer, this.processedBuffer);
            this.playBuffer(this.processedBuffer, 'processed');
            
        } catch (e) {
            this.log(`Error processing: ${e.message}`);
            console.error(e);
        } finally {
            this.isProcessing = false;
            this.processBtn.disabled = false;
            this.stopBtn.disabled = false;
            this.indicator.style.display = 'none';
        }
    }

    getMonoData(audioBuffer) {
        if (audioBuffer.numberOfChannels === 1) {
            return audioBuffer.getChannelData(0);
        }
        
        const ch0 = audioBuffer.getChannelData(0);
        const ch1 = audioBuffer.getChannelData(1);
        const mono = new Float32Array(ch0.length);
        
        for (let i = 0; i < ch0.length; i++) {
            mono[i] = (ch0[i] + ch1[i]) / 2;
        }
        return mono;
    }

    stopPlayback() {
        if (this.sourceNode) {
            try {
                this.sourceNode.stop();
            } catch (e) {} 
            this.sourceNode = null;
        }
        if (this.playbackState.animationId) {
            cancelAnimationFrame(this.playbackState.animationId);
            this.playbackState.animationId = null;
        }
        this.playbackState.isPlaying = false;
        this.playbackState.isPaused = false;
        this.updateButtonStates();
        
        this.waveformViewer.setPlaybackState(false, 0, null);
    }
}

const demo = new SpeedyDemo();
demo.initialize();