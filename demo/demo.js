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
            duration: 0,
            selectionDuration: 0 // Duration when in selection mode
        };

        // Selection state
        this.activeSelection = null; // {start: time, end: time} or null
        
        // UI Elements
        this.statusLogEl = document.getElementById('statusLog');
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

        this.selectedBufferType = 'original'; // 'original' or 'processed'

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

        // Buffer Selection (Cassette Toggles)
        document.getElementById('playOriginalBtn').addEventListener('click', () => {
            this.setBufferSelection('original');
        });

        document.getElementById('playProcessedBtn').addEventListener('click', () => {
            this.setBufferSelection('processed');
        });

        // Play/Pause
        document.getElementById('playPauseBtn').addEventListener('click', () => {
            if (this.playbackState.isPlaying && !this.playbackState.isPaused) {
                this.pausePlayback();
            } else {
                this.resumePlayback();
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
             const buffer = this.selectedBufferType === 'original' ? this.originalBuffer : this.processedBuffer;
             if (!buffer) return;

             // Clamp time to selection bounds if active
             if (this.activeSelection) {
                 time = Math.max(this.activeSelection.start, Math.min(time, this.activeSelection.end));
             } else {
                 time = Math.max(0, Math.min(time, buffer.duration));
             }

             this.stopPlayback(false); // Don't reset view completely
             this.playBuffer(buffer, this.selectedBufferType, time);
        };

        this.waveformViewer.onSelectionChange = (selection) => {
            this.activeSelection = selection;
            this.updateSelectionUI();

            // If currently playing, restart to apply/remove selection bounds
            if (this.playbackState.isPlaying && !this.playbackState.isPaused) {
                const buffer = this.selectedBufferType === 'original' ? this.originalBuffer : this.processedBuffer;
                if (buffer) {
                    const currentTime = this.playbackState.currentTime;
                    let seekTime = currentTime;

                    if (selection) {
                        // Selection created: if current time is outside, seek to selection start
                        if (currentTime > selection.end) {
                            seekTime = selection.start;
                        }
                    }
                    // If selection cleared, just continue from current time

                    this.stopPlayback(false);
                    this.playBuffer(buffer, this.selectedBufferType, seekTime);
                }
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
        // Create timestamp
        const now = new Date();
        const ts = now.toTimeString().split(' ')[0]; // HH:MM:SS
        
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        
        const timeSpan = document.createElement('span');
        timeSpan.className = 'log-time';
        timeSpan.textContent = ts;
        
        const msgSpan = document.createElement('span');
        msgSpan.className = 'log-msg';
        msgSpan.textContent = msg;
        
        entry.appendChild(timeSpan);
        entry.appendChild(msgSpan);
        
        this.statusLogEl.appendChild(entry);
        this.statusLogEl.scrollTop = this.statusLogEl.scrollHeight;
        
        console.log(`[${ts}] ${msg}`);
    }

    setBufferSelection(type) {
        if (this.selectedBufferType === type) return;
        
        this.selectedBufferType = type;
        
        // If playing, switch audio stream
        if (this.playbackState.isPlaying && !this.playbackState.isPaused) {
            // Get current relative progress
            const elapsed = (this.audioContext.currentTime - this.playbackState.startTime) % this.playbackState.duration;
            const progress = elapsed / this.playbackState.duration;
            
            const newBuffer = type === 'original' ? this.originalBuffer : this.processedBuffer;
            if (newBuffer) {
                const newTime = progress * newBuffer.duration;
                this.stopPlayback(false);
                this.playBuffer(newBuffer, type, newTime);
            }
        } else {
             // Just update UI and Waveform view
             this.updateButtonStates();
             this.waveformViewer.setPlaybackState(
                 this.playbackState.isPlaying, 
                 this.playbackState.currentTime, // Maintain cursor visual
                 type // Update active buffer view
             );
        }
    }

    // ... (rest of methods)

    updateButtonStates() {
        const playOriginalBtn = document.getElementById('playOriginalBtn');
        const playProcessedBtn = document.getElementById('playProcessedBtn');
        const playPauseBtn = document.getElementById('playPauseBtn');
        const playIcon = document.getElementById('playIcon');
        const pauseIcon = document.getElementById('pauseIcon');

        // Toggle Buttons State (Cassette Logic)
        playOriginalBtn.disabled = !this.originalBuffer;
        playProcessedBtn.disabled = !this.processedBuffer;

        playOriginalBtn.classList.toggle('active', this.selectedBufferType === 'original');
        playProcessedBtn.classList.toggle('active', this.selectedBufferType === 'processed');

        // Play/Pause Button
        const hasActiveBuffer = (this.selectedBufferType === 'original' && this.originalBuffer) ||
                              (this.selectedBufferType === 'processed' && this.processedBuffer);

        playPauseBtn.disabled = !hasActiveBuffer;

        const isPlaying = this.playbackState.isPlaying && !this.playbackState.isPaused;
        playIcon.style.display = isPlaying ? 'none' : 'block';
        pauseIcon.style.display = isPlaying ? 'block' : 'none';

        // Optional: Highlight play/pause if playing
        playPauseBtn.classList.toggle('active', isPlaying);
    }

    updateSelectionUI() {
        const indicator = document.getElementById('selectionIndicator');
        const clearBtn = document.getElementById('clearSelectionBtn');
        const timeDisplay = document.getElementById('timeDisplay');

        if (this.activeSelection) {
            // Show selection indicator
            if (indicator) {
                indicator.style.display = 'flex';
                const startStr = this.formatTime(this.activeSelection.start);
                const endStr = this.formatTime(this.activeSelection.end);
                const durStr = this.formatTime(this.activeSelection.end - this.activeSelection.start);
                indicator.querySelector('.selection-range').textContent = `${startStr} - ${endStr} (${durStr})`;
            }
            if (clearBtn) {
                clearBtn.disabled = false;
            }
            timeDisplay.classList.add('selection-active');
        } else {
            // Hide selection indicator
            if (indicator) {
                indicator.style.display = 'none';
            }
            if (clearBtn) {
                clearBtn.disabled = true;
            }
            timeDisplay.classList.remove('selection-active');
        }
    }

    clearSelection() {
        this.waveformViewer.clearSelection();
        const wasPlaying = this.playbackState.isPlaying && !this.playbackState.isPaused;
        const currentTime = this.playbackState.currentTime;

        this.activeSelection = null;
        this.updateSelectionUI();
        this.log('Selection cleared');

        // If playback was active, restart without selection bounds
        if (wasPlaying) {
            const buffer = this.selectedBufferType === 'original' ? this.originalBuffer : this.processedBuffer;
            if (buffer) {
                this.stopPlayback(false);
                this.playBuffer(buffer, this.selectedBufferType, currentTime);
            }
        }
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
                true, // Keep "playing" visually (just paused)
                this.playbackState.pauseTime - this.playbackState.startTime,
                this.selectedBufferType
            );
        }
    }

    resumePlayback() {
        const buffer = this.selectedBufferType === 'original' ? this.originalBuffer : this.processedBuffer;
        if (!buffer) return;

        if (this.playbackState.isPaused) {
            const elapsed = this.playbackState.pauseTime - this.playbackState.startTime;
            this.playBuffer(buffer, this.selectedBufferType, elapsed);
        } else {
            // Start from beginning
            this.playBuffer(buffer, this.selectedBufferType, 0);
        }
    }

    playBuffer(buffer, bufferType, offset = 0) {
        this.sourceNode = this.audioContext.createBufferSource();
        this.sourceNode.buffer = buffer;
        this.sourceNode.connect(this.audioContext.destination);

        // Calculate effective duration and offset based on selection
        let effectiveOffset = offset;
        let effectiveDuration = buffer.duration;

        if (this.activeSelection) {
            // Clamp offset to selection bounds
            effectiveOffset = Math.max(this.activeSelection.start, Math.min(offset, this.activeSelection.end));
            // Store selection duration for animation loop
            this.playbackState.selectionDuration = this.activeSelection.end - this.activeSelection.start;
            effectiveDuration = this.playbackState.selectionDuration;
        } else {
            this.playbackState.selectionDuration = 0;
        }

        this.playbackState.isPlaying = true;
        this.playbackState.isPaused = false;
        this.playbackState.startTime = this.audioContext.currentTime - effectiveOffset;
        this.playbackState.duration = buffer.duration; // Full buffer duration
        this.playbackState.currentBuffer = bufferType;
        this.selectedBufferType = bufferType; // Ensure sync

        this.sourceNode.start(0, effectiveOffset);
        this.startPlaybackAnimation();
        this.updateButtonStates();

        this.sourceNode.onended = () => {
            if (this.playbackState.isPlaying && !this.playbackState.isPaused) {
                this.playbackState.isPlaying = false;
                this.playbackState.currentBuffer = null;
                cancelAnimationFrame(this.playbackState.animationId);
                this.updateButtonStates();
                this.log('Playback finished');

                this.waveformViewer.setPlaybackState(false, 0, this.selectedBufferType);
            }
        };
    }

    stopPlayback(reset = true) {
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
        
        if (reset) {
            this.waveformViewer.setPlaybackState(false, 0, this.selectedBufferType);
        }
    }

    async initialize() {
        try {
            this.log('Loading WASM module...');
            const Module = await initSpeedy();
            this.SonicStream = Module.SonicStream;
            this.moduleLoaded = true;
            this.log('Ready. Select an audio file.');

            // Init AudioContext if needed
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
        } catch (err) {
            this.log('Failed to load WASM module: ' + err.message);
        }
    }

    async handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        this.log(`Loading file: ${file.name}`);

        try {
            const arrayBuffer = await file.arrayBuffer();
            this.audioContext = this.audioContext || new AudioContext();
            const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

            this.originalBuffer = audioBuffer;
            this.log(`File loaded: ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz, ${audioBuffer.numberOfChannels}ch`);

            // Only enable process button if module is loaded
            this.processBtn.disabled = !this.moduleLoaded;
            this.waveformViewer.setData(audioBuffer, null);
            this.updateButtonStates();
            this.updateInputStats();

            // Clear output stats from previous run
            document.getElementById('outDuration').textContent = '-';
            document.getElementById('outSamples').textContent = '-';
            document.getElementById('compressionRatio').textContent = '-';
            document.getElementById('outSize').textContent = '-';
            document.getElementById('procTime').textContent = '-';
            document.getElementById('rtFactor').textContent = '-';
        } catch (err) {
            this.log('Error loading file: ' + err.message);
        }
    }

    analyzeAudio(float32Array) {
        let sumSquares = 0;
        let peak = 0;

        for (let i = 0; i < float32Array.length; i++) {
            const sample = Math.abs(float32Array[i]);
            sumSquares += sample * sample;
            if (sample > peak) peak = sample;
        }

        return {
            peak: peak.toFixed(3),
            rms: Math.sqrt(sumSquares / float32Array.length).toFixed(3)
        };
    }

    updateAudioAnalysisDisplay(inputData, outputData, chunkCount) {
        const container = document.getElementById('audioAnalysisContainer');
        container.style.display = 'block';

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

    async processAndPlay() {
        if (!this.originalBuffer || this.isProcessing) return;

        this.isProcessing = true;
        this.indicator.style.display = 'inline-block';
        this.processBtn.disabled = true;
        this.log('Processing started...');

        const startTime = performance.now();

        try {
            if (!this.moduleLoaded) {
                await this.initialize();
            }

            this.stopPlayback();
            this.log('Processing...');

            // Create SonicStream
            const channels = 1; // Force mono
            const sampleRate = this.originalBuffer.sampleRate;

            const sonic = new this.SonicStream(sampleRate, channels);
            sonic.setSpeed(this.params.speed);
            sonic.enableNonlinearSpeedup(this.params.nonlinear);
            sonic.setDurationFeedbackStrength(this.params.feedback);

            // Prepare input data (convert to mono if needed)
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

            this.updateOutputStats(procTime / 1000);
            this.updateAudioAnalysisDisplay(inputData, result, outputChunks.length);
            this.waveformViewer.setData(this.originalBuffer, this.processedBuffer);
            this.setBufferSelection('processed');
            this.playBuffer(this.processedBuffer, 'processed', 0);

        } catch (err) {
            this.log('Processing error: ' + err.message);
        } finally {
            this.isProcessing = false;
            this.indicator.style.display = 'none';
            this.processBtn.disabled = false;
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

    updateInputStats() {
        if (!this.originalBuffer) return;
        document.getElementById('inDuration').textContent = this.originalBuffer.duration.toFixed(2) + 's';
        document.getElementById('inSampleRate').textContent = this.originalBuffer.sampleRate + ' Hz';
        document.getElementById('inChannels').textContent = this.originalBuffer.numberOfChannels;
        document.getElementById('inSamples').textContent = this.originalBuffer.length.toLocaleString();
        document.getElementById('statsContainer').style.display = 'block';
    }

    updateOutputStats(procTimeSeconds) {
        if (!this.processedBuffer) return;

        // Duration and samples
        document.getElementById('outDuration').textContent = this.processedBuffer.duration.toFixed(2) + 's';
        document.getElementById('outSamples').textContent = this.processedBuffer.length.toLocaleString();

        // Compression ratio (input / output)
        const ratio = this.originalBuffer.duration / this.processedBuffer.duration;
        document.getElementById('compressionRatio').textContent = ratio.toFixed(2) + 'x';

        // Est WAV size (16-bit mono)
        const bytes = this.processedBuffer.length * 2;
        document.getElementById('outSize').textContent = (bytes / 1024).toFixed(1) + ' KB';

        // Performance
        document.getElementById('procTime').textContent = (procTimeSeconds * 1000).toFixed(1) + ' ms';
        const rtf = this.originalBuffer.duration / procTimeSeconds;
        document.getElementById('rtFactor').textContent = rtf.toFixed(1) + 'x';

        // Parameters
        document.getElementById('paramSpeed').textContent = this.params.speed.toFixed(1) + 'x';
        document.getElementById('paramNonlinear').textContent = this.params.nonlinear.toFixed(1);
    }

    startPlaybackAnimation() {
        const animate = () => {
            if (!this.playbackState.isPlaying || this.playbackState.isPaused) return;

            const elapsed = this.audioContext.currentTime - this.playbackState.startTime;
            const duration = this.playbackState.duration;

            // Determine effective end time based on selection
            let effectiveEndTime = duration;
            if (this.activeSelection) {
                effectiveEndTime = this.activeSelection.end;
            }

            if (elapsed >= effectiveEndTime) {
                // Stop at selection end or buffer end
                this.playbackState.currentTime = this.activeSelection ? this.activeSelection.start : 0;
                this.waveformViewer.setPlaybackState(false, this.playbackState.currentTime, this.selectedBufferType);
                this.stopPlayback(false); // Don't reset view
                return;
            }

            this.playbackState.currentTime = elapsed;
            // Update time display to show current time and effective end
            const displayDuration = this.activeSelection ? this.playbackState.selectionDuration : duration;
            const displayStart = this.activeSelection ? this.activeSelection.start : 0;
            const timeStr = this.formatTime(elapsed) + ' / ' + this.formatTime(displayStart + displayDuration);
            document.getElementById('timeDisplay').textContent = timeStr;

            this.waveformViewer.setPlaybackState(true, elapsed, this.selectedBufferType);
            this.playbackState.animationId = requestAnimationFrame(animate);
        };
        this.playbackState.animationId = requestAnimationFrame(animate);
    }

    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
}

const demo = new SpeedyDemo();
demo.initialize();

// Expose demo globally for inline script access
window.demo = demo;