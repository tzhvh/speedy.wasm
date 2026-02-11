import initSpeedy from './speedy.js';
import { WaveformViewer } from './waveform.js';

class SpeedyDemo {
    constructor() {
        this.audioContext = null;
        this.sourceNode = null;
        this.sourceIdCounter = 0;
        this.originalBuffer = null;
        this.processedBuffer = null;
        this.linearBuffer = null;
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

        // Parameters (must be defined before setting speed reference)
        this.params = {
            speed: 2.0,
            nonlinear: 1.0,
            feedback: 0.1,
            preemphasis: 0.97,
            tensionEnergyWeight: 0.5,
            tensionSpeechWeight: 0.25,
            tensionEnergyOffset: 0.7,
            tensionSpeechOffset: 1.0,
            binThresholdDivisor: 100,
            lowEnergyScale: 0.04,
            speechChangeCapMultiplier: 4.0,
            linearRefEnabled: false
        };

        // Initialize speed reference line with default value
        this.waveformViewer.setSpeedReference(this.params.speed);

        // Track last processed parameters for staleness detection
        this.lastProcessedParams = null;

        this.selectedBufferType = 'original'; // 'original' or 'processed'

        this.stats = {
            input: {},
            output: {},
            perf: {}
        };

        this.bindEvents();
        this.bindWaveformEvents();

        // Initialize processBtn state
        this.updateProcessBtnState();
    }

    bindEvents() {
        // Parameter inputs
        [
            'speed',
            'nonlinear',
            'feedback',
            'preemphasis',
            'tensionEnergyWeight',
            'tensionSpeechWeight',
            'tensionEnergyOffset',
            'tensionSpeechOffset',
            'binThresholdDivisor',
            'lowEnergyScale',
            'speechChangeCapMultiplier'
        ].forEach(id => {
            const el = document.getElementById(id);
            const valEl = document.getElementById(id + 'Val');
            el.addEventListener('input', (e) => {
                this.params[id] = parseFloat(e.target.value);
                valEl.textContent = this.params[id] + (id === 'speed' ? 'x' : '');
                // Update speed reference line in waveform viewer
                if (id === 'speed' && this.waveformViewer) {
                    this.waveformViewer.setSpeedReference(this.params.speed);
                }
                // Update processBtn ready state when params change
                this.updateProcessBtnState();
            });
        });

        // Linear Reference checkbox
        const linearRefCheckbox = document.getElementById('linearRef');
        // Initialize param from checkbox state
        this.params.linearRefEnabled = linearRefCheckbox.checked;
        this.waveformViewer.setLinearReferenceEnabled(linearRefCheckbox.checked);
        linearRefCheckbox.addEventListener('change', (e) => {
            this.params.linearRefEnabled = e.target.checked;
            this.waveformViewer.setLinearReferenceEnabled(e.target.checked);
            this.updateProcessBtnState();
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

        document.getElementById('playLinearBtn').addEventListener('click', () => {
            this.setBufferSelection('linear');
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
             const buffer = this.selectedBufferType === 'original' ? this.originalBuffer
                              : this.selectedBufferType === 'linear' ? this.linearBuffer
                              : this.processedBuffer;
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
                const buffer = this.selectedBufferType === 'original' ? this.originalBuffer
                                 : this.selectedBufferType === 'linear' ? this.linearBuffer
                                 : this.processedBuffer;
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
            
            const newBuffer = type === 'original' ? this.originalBuffer
                             : type === 'linear' ? this.linearBuffer
                             : this.processedBuffer;
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
        const playLinearBtn = document.getElementById('playLinearBtn');
        const playProcessedBtn = document.getElementById('playProcessedBtn');
        const playPauseBtn = document.getElementById('playPauseBtn');
        const playIcon = document.getElementById('playIcon');
        const pauseIcon = document.getElementById('pauseIcon');

        // Toggle Buttons State (Cassette Logic)
        playOriginalBtn.disabled = !this.originalBuffer;
        playLinearBtn.disabled = !this.linearBuffer;
        playProcessedBtn.disabled = !this.processedBuffer;

        playOriginalBtn.classList.toggle('active', this.selectedBufferType === 'original');
        playLinearBtn.classList.toggle('active', this.selectedBufferType === 'linear');
        playProcessedBtn.classList.toggle('active', this.selectedBufferType === 'processed');

        // Play/Pause Button
        const hasActiveBuffer = (this.selectedBufferType === 'original' && this.originalBuffer) ||
                              (this.selectedBufferType === 'linear' && this.linearBuffer) ||
                              (this.selectedBufferType === 'processed' && this.processedBuffer);

        playPauseBtn.disabled = !hasActiveBuffer;

        const isPlaying = this.playbackState.isPlaying && !this.playbackState.isPaused;
        playIcon.style.display = isPlaying ? 'none' : 'block';
        pauseIcon.style.display = isPlaying ? 'block' : 'none';

        // Optional: Highlight play/pause if playing
        playPauseBtn.classList.toggle('active', isPlaying);
    }

    checkProcessStaleness() {
        // Stale if no processed buffer exists yet
        if (!this.processedBuffer) {
            return true;
        }
        // Stale if params have changed since last processing
        if (!this.lastProcessedParams) {
            return true;
        }
        // Compare each parameter
        return this.params.speed !== this.lastProcessedParams.speed ||
               this.params.nonlinear !== this.lastProcessedParams.nonlinear ||
               this.params.feedback !== this.lastProcessedParams.feedback ||
               this.params.linearRefEnabled !== this.lastProcessedParams.linearRefEnabled;
    }

    updateProcessBtnState() {
        const isStale = this.checkProcessStaleness();
        const isEnabled = !this.processBtn.disabled;
        this.processBtn.classList.toggle('ready', isStale && isEnabled);
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
            const buffer = this.selectedBufferType === 'original' ? this.originalBuffer
                             : this.selectedBufferType === 'linear' ? this.linearBuffer
                             : this.processedBuffer;
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
        const buffer = this.selectedBufferType === 'original' ? this.originalBuffer
                         : this.selectedBufferType === 'linear' ? this.linearBuffer
                         : this.processedBuffer;
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
        // Capture source ID before creating new node to guard against stale callbacks
        const currentSourceId = ++this.sourceIdCounter;

        this.sourceNode = this.audioContext.createBufferSource();
        this.sourceNode.buffer = buffer;
        this.sourceNode.connect(this.audioContext.destination);

        // Always reset selection duration first to clear any stale state
        this.playbackState.selectionDuration = 0;

        // Calculate effective duration and offset based on selection
        let effectiveOffset = offset;
        let effectiveDuration = buffer.duration;

        if (this.activeSelection) {
            // Clamp offset to selection bounds
            effectiveOffset = Math.max(this.activeSelection.start, Math.min(offset, this.activeSelection.end));
            // Store selection duration for animation loop
            this.playbackState.selectionDuration = this.activeSelection.end - this.activeSelection.start;
            effectiveDuration = this.playbackState.selectionDuration;
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
            // Only run if this is still the current source (prevents stale callbacks from killing new playback)
            if (currentSourceId !== this.sourceIdCounter) return;

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
            // Show ready state when audio is loaded but not processed
            this.updateProcessBtnState();
            this.waveformViewer.setData(audioBuffer, null);
            this.updateButtonStates();
            this.updateInputStats();

            // Clear output stats from previous run
            const statsToClear = [
                'outDuration', 'outSamples', 'compressionRatio', 'timeSaved', 'outSize',
                'outPeak', 'outRMS', 'outCrest', 'levelChange',
                'inPeak', 'inRMS', 'inCrest', 'inZeroX',  // Clear input analysis from previous run
                'procTime', 'rtFactor', 'framesAnalyzed', 'fftSize', 'frameRate', 'lookaheadLatency',
                'paramSpeed', 'avgSpeed', 'speedRange', 'speedVariance', 'paramNonlinear', 'paramFeedback', 'driftCorrection',
                'inSamplesDbg', 'outSamplesDbg', 'chunksProcessed', 'spectrogramData', 'speedProfileInfo', 'wasmHeap'
            ];
            statsToClear.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.textContent = '-';
            });
        } catch (err) {
            this.log('Error loading file: ' + err.message);
        }
    }

    analyzeAudio(float32Array) {
        let sumSquares = 0;
        let peak = 0;
        let zeroCrossings = 0;
        let prevSample = 0;

        for (let i = 0; i < float32Array.length; i++) {
            const sample = Math.abs(float32Array[i]);
            sumSquares += sample * sample;
            if (sample > peak) peak = sample;
            
            // Count zero crossings
            if ((prevSample >= 0 && float32Array[i] < 0) || (prevSample < 0 && float32Array[i] >= 0)) {
                zeroCrossings++;
            }
            prevSample = float32Array[i];
        }

        const rms = Math.sqrt(sumSquares / float32Array.length);
        const crestFactor = rms > 0 ? peak / rms : 0;

        return {
            peak: peak,
            rms: rms,
            crestFactor: crestFactor,
            zeroCrossings: zeroCrossings
        };
    }

    updateAudioAnalysisDisplay(inputData, outputData, chunkCount) {
        const inputAnalysis = this.analyzeAudio(inputData);

        // Input Signal stats with verbose format
        document.getElementById('inPeak').textContent = `${inputAnalysis.peak.toFixed(6)} · ${this.formatDb(inputAnalysis.peak)} dBFS · ${(inputAnalysis.peak * 100).toFixed(2)}% FS`;
        document.getElementById('inRMS').textContent = `${inputAnalysis.rms.toFixed(6)} · ${this.formatDb(inputAnalysis.rms)} dBFS · ${(inputAnalysis.rms * 100).toFixed(2)}% FS`;
        document.getElementById('inCrest').textContent = `${inputAnalysis.crestFactor.toFixed(2)}x · ${this.formatDb(inputAnalysis.crestFactor)} dB`;
        document.getElementById('inZeroX').textContent = `${inputAnalysis.zeroCrossings.toLocaleString()} · ${((inputAnalysis.zeroCrossings / inputData.length) * 100).toFixed(2)}% · ${(inputAnalysis.zeroCrossings / this.originalBuffer.duration).toFixed(0)} Hz`;

        // Store input analysis for later use
        this.inputAnalysis = inputAnalysis;

        if (outputData) {
            const outputAnalysis = this.analyzeAudio(outputData);

            // Output Signal stats with verbose format
            document.getElementById('outPeak').textContent = `${outputAnalysis.peak.toFixed(6)} · ${this.formatDb(outputAnalysis.peak)} dBFS · ${(outputAnalysis.peak * 100).toFixed(2)}% FS`;
            document.getElementById('outRMS').textContent = `${outputAnalysis.rms.toFixed(6)} · ${this.formatDb(outputAnalysis.rms)} dBFS · ${(outputAnalysis.rms * 100).toFixed(2)}% FS`;
            document.getElementById('outCrest').textContent = `${outputAnalysis.crestFactor.toFixed(2)}x · ${this.formatDb(outputAnalysis.crestFactor)} dB`;
            
            // Level change
            const peakChange = outputAnalysis.peak - inputAnalysis.peak;
            const rmsChange = outputAnalysis.rms - inputAnalysis.rms;
            document.getElementById('levelChange').textContent = `Δpeak: ${(peakChange >= 0 ? '+' : '')}${peakChange.toFixed(6)} · Δrms: ${(rmsChange >= 0 ? '+' : '')}${rmsChange.toFixed(6)} · ${peakChange > 0 ? 'louder' : peakChange < 0 ? 'quieter' : 'same'} · ${outputAnalysis.crestFactor > inputAnalysis.crestFactor ? 'more' : 'less'} compressed`;
            
            this.outputAnalysis = outputAnalysis;
        }

        document.getElementById('chunksProcessed').textContent = `${chunkCount.toLocaleString()} · avg ${(inputData.length / chunkCount).toFixed(0)} smp/chk`;
    }

    applySpeedyParams(sonicStream) {
        if (typeof sonicStream.setSpeedyPreemphasisFactor === 'function') {
            sonicStream.setSpeedyPreemphasisFactor(this.params.preemphasis);
        }
        if (typeof sonicStream.setSpeedyTensionWeights === 'function') {
            sonicStream.setSpeedyTensionWeights(
                this.params.tensionEnergyWeight,
                this.params.tensionSpeechWeight
            );
        }
        if (typeof sonicStream.setSpeedyTensionOffsets === 'function') {
            sonicStream.setSpeedyTensionOffsets(
                this.params.tensionEnergyOffset,
                this.params.tensionSpeechOffset
            );
        }
        if (typeof sonicStream.setSpeedyBinThresholdDivisor === 'function') {
            sonicStream.setSpeedyBinThresholdDivisor(this.params.binThresholdDivisor);
        }
        if (typeof sonicStream.setSpeedyLowEnergyThresholdScale === 'function') {
            sonicStream.setSpeedyLowEnergyThresholdScale(this.params.lowEnergyScale);
        }
        if (typeof sonicStream.setSpeedySpeechChangeCapMultiplier === 'function') {
            sonicStream.setSpeedySpeechChangeCapMultiplier(
                this.params.speechChangeCapMultiplier
            );
        }
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

            // Create SonicStream instances
            const channels = 1; // Force mono
            const sampleRate = this.originalBuffer.sampleRate;

            // Processed stream (with nonlinear)
            const sonicProcessed = new this.SonicStream(sampleRate, channels);
            sonicProcessed.setSpeed(this.params.speed);
            sonicProcessed.enableNonlinearSpeedup(this.params.nonlinear);
            sonicProcessed.setDurationFeedbackStrength(this.params.feedback);
            this.applySpeedyParams(sonicProcessed);
            sonicProcessed.setupSpeedCallback();

            // Linear stream (nonlinear=0)
            let sonicLinear = null;
            if (this.params.linearRefEnabled) {
                sonicLinear = new this.SonicStream(sampleRate, channels);
                sonicLinear.setSpeed(this.params.speed);
                sonicLinear.enableNonlinearSpeedup(0);
                sonicLinear.setDurationFeedbackStrength(this.params.feedback);
                this.applySpeedyParams(sonicLinear);
                sonicLinear.setupSpeedCallback();
            }

            // Prepare input data (convert to mono if needed)
            const inputData = this.getMonoData(this.originalBuffer);

            // Process in chunks (parallel when both enabled)
            const chunkSize = 8192;
            const processedChunks = [];
            const linearChunks = [];

            for (let offset = 0; offset < inputData.length; offset += chunkSize) {
                const chunk = inputData.subarray(offset, offset + chunkSize);

                // Write to both streams
                sonicProcessed.writeFloatToStream(chunk, chunk.length);
                if (sonicLinear) {
                    sonicLinear.writeFloatToStream(chunk, chunk.length);
                }

                // Read from processed stream
                let output;
                while ((output = sonicProcessed.readFloatFromStream(chunkSize))) {
                    processedChunks.push(output);
                }

                // Read from linear stream (if enabled)
                if (sonicLinear) {
                    while ((output = sonicLinear.readFloatFromStream(chunkSize))) {
                        linearChunks.push(output);
                    }
                }

                if (offset % (chunkSize * 10) === 0) {
                    const progress = Math.round((offset / inputData.length) * 100);
                    this.log(`Processing... ${progress}%`);
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            // Flush both streams
            sonicProcessed.flushStream();
            let output;
            while ((output = sonicProcessed.readFloatFromStream(chunkSize))) {
                processedChunks.push(output);
            }

            if (sonicLinear) {
                sonicLinear.flushStream();
                while ((output = sonicLinear.readFloatFromStream(chunkSize))) {
                    linearChunks.push(output);
                }
            }

            const endTime = performance.now();
            const procTime = endTime - startTime;

            // Combine processed chunks
            const totalProcessedLength = processedChunks.reduce((sum, c) => sum + c.length, 0);
            const processedResult = new Float32Array(totalProcessedLength);
            let offset = 0;
            for (const chunk of processedChunks) {
                processedResult.set(chunk, offset);
                offset += chunk.length;
            }

            this.processedBuffer = this.audioContext.createBuffer(1, totalProcessedLength, sampleRate);
            this.processedBuffer.copyToChannel(processedResult, 0);

            // Combine linear chunks (if enabled)
            if (this.params.linearRefEnabled && sonicLinear) {
                const totalLinearLength = linearChunks.reduce((sum, c) => sum + c.length, 0);
                const linearResult = new Float32Array(totalLinearLength);
                offset = 0;
                for (const chunk of linearChunks) {
                    linearResult.set(chunk, offset);
                    offset += chunk.length;
                }

                this.linearBuffer = this.audioContext.createBuffer(1, totalLinearLength, sampleRate);
                this.linearBuffer.copyToChannel(linearResult, 0);
            } else {
                this.linearBuffer = null;
            }

            // Build position map for bifurcated playhead
            const speedProfile = sonicProcessed.getSpeedProfile();
            if (speedProfile && this.originalBuffer && this.processedBuffer) {
                this.waveformViewer.setSpeedProfile(speedProfile);
                this.waveformViewer.buildPositionMap(
                    this.originalBuffer.duration,
                    this.processedBuffer.duration,
                    speedProfile
                );
                // Update processing stats with speed profile data
                this.updateProcessingStats(speedProfile, sonicProcessed);
            }

            this.log(`Done! Original: ${this.originalBuffer.duration.toFixed(2)}s, Processed: ${this.processedBuffer.duration.toFixed(2)}s`);

            this.updateOutputStats(procTime / 1000);
            this.updateAudioAnalysisDisplay(inputData, processedResult, processedChunks.length);
            this.waveformViewer.setData(this.originalBuffer, this.processedBuffer, this.linearBuffer);
            this.setBufferSelection('processed');
            this.playBuffer(this.processedBuffer, 'processed', 0);

        } catch (err) {
            this.log('Processing error: ' + err.message);
        } finally {
            this.isProcessing = false;
            this.indicator.style.display = 'none';
            this.processBtn.disabled = false;
            // Store params that were used for this processing
            this.lastProcessedParams = { ...this.params };
            // Clear ready state since we just processed
            this.updateProcessBtnState();
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
        const dur = this.originalBuffer.duration;
        const sr = this.originalBuffer.sampleRate;
        const samples = this.originalBuffer.length;
        const ch = this.originalBuffer.numberOfChannels;
        
        // Input Signal verbose format
        document.getElementById('inDuration').textContent = `${dur.toFixed(2)} s · ${(dur * 1000).toFixed(0)} ms · ${(dur / 60).toFixed(2)} min`;
        document.getElementById('inSamples').textContent = `${samples.toLocaleString()} · 0x${samples.toString(16).toUpperCase()} · ${(samples * 4 / 1024 / 1024).toFixed(2)} MB raw`;
        document.getElementById('inSampleRate').textContent = `${sr.toLocaleString()} Hz · ${(1000000 / sr).toFixed(2)} µs period · ${(sr / 2 / 1000).toFixed(2)} kHz nyquist`;
        document.getElementById('inChannels').textContent = `${ch} · ${ch === 1 ? 'mono' : ch === 2 ? 'stereo' : 'multi'} · ${(ch * sr * 4 / 1000).toFixed(1)} kB/s`;
        
        document.getElementById('statsContainer').style.display = 'block';
    }

    updateOutputStats(procTimeSeconds) {
        if (!this.processedBuffer) return;

        const outDur = this.processedBuffer.duration;
        const outSamples = this.processedBuffer.length;
        const inDur = this.originalBuffer.duration;
        const inSamples = this.originalBuffer.length;

        // Output Signal verbose format
        const framesAt100Hz = outDur * 100;
        document.getElementById('outDuration').textContent = `${outDur.toFixed(2)} s · ${(outDur * 1000).toFixed(0)} ms · ${framesAt100Hz.toFixed(0)} frames @ 100Hz`;
        document.getElementById('outSamples').textContent = `${outSamples.toLocaleString()} · 0x${outSamples.toString(16).toUpperCase()} · ${(outSamples * 4 / 1024 / 1024).toFixed(2)} MB raw`;

        // Compression ratio
        const ratio = inDur / outDur;
        const timeSaved = inDur - outDur;
        const percentSaved = ((timeSaved / inDur) * 100);
        document.getElementById('compressionRatio').textContent = `${ratio.toFixed(2)}x · ${percentSaved.toFixed(1)}% reduction · ${(ratio * 100).toFixed(0)}% speed`;
        document.getElementById('timeSaved').textContent = `${timeSaved.toFixed(2)} s · ${(timeSaved * 1000).toFixed(0)} ms · ${percentSaved.toFixed(1)}% of original`;

        // Est WAV size (16-bit mono)
        const bytes = outSamples * 2;
        document.getElementById('outSize').textContent = `${(bytes / 1024).toFixed(1)} KB · ${(bytes / 1024 / 1024).toFixed(3)} MB · 16-bit mono`;

        // Performance verbose format
        const procMs = procTimeSeconds * 1000;
        const rtf = inDur / procTimeSeconds;
        const rtfPercent = (1 / rtf) * 100;
        const usPerSample = (procMs * 1000) / inSamples;
        document.getElementById('procTime').textContent = `${procMs.toFixed(1)} ms · ${procMs.toFixed(3)} s · ${rtfPercent.toFixed(2)}% RT load`;
        document.getElementById('rtFactor').textContent = `${rtf.toFixed(1)}x · ${(rtf / 60).toFixed(2)} min/min · ${usPerSample.toFixed(3)} µs/sample`;

        // Debug section
        document.getElementById('inSamplesDbg').textContent = `${inSamples.toLocaleString()} · 0x${inSamples.toString(16).toUpperCase()} · ${(inSamples * 4 / 1024 / 1024).toFixed(2)} MB`;
        document.getElementById('outSamplesDbg').textContent = `${outSamples.toLocaleString()} · 0x${outSamples.toString(16).toUpperCase()} · ${(outSamples * 4 / 1024 / 1024).toFixed(2)} MB`;
    }

    updateProcessingStats(speedProfile, sonicStream) {
        if (!speedProfile || speedProfile.length < 2) return;

        const numPoints = Math.floor(speedProfile.length / 2);
        const sampleRate = this.originalBuffer.sampleRate;

        // Get Speedy algorithm parameters from WASM
        const frameRate = sonicStream.getSpeedyFrameRate();  // 100 Hz from WASM
        const lookaheadFrames = sonicStream.getSpeedyTemporalHysteresisFuture();  // 12 from WASM

        // Calculate FFT size based on sample rate (matches speedy.c formula)
        const windowSize = Math.round(1.5 * sampleRate / frameRate);
        const fftSize = 2 * windowSize;
        const fftWindowMs = (fftSize / sampleRate) * 1000;
        const fftResolution = sampleRate / fftSize;

        // Frame step and lookahead
        const frameStepMs = 1000 / frameRate;
        const lookaheadMs = lookaheadFrames * frameStepMs;
        const lookaheadSamples = Math.round(lookaheadMs * sampleRate / 1000);
        
        // Speed profile analysis
        let speeds = [];
        let minSpeed = Infinity;
        let maxSpeed = -Infinity;
        let sumSpeed = 0;
        
        for (let i = 0; i < numPoints; i++) {
            const speed = speedProfile[i * 2 + 1];
            speeds.push(speed);
            minSpeed = Math.min(minSpeed, speed);
            maxSpeed = Math.max(maxSpeed, speed);
            sumSpeed += speed;
        }
        
        const avgSpeed = sumSpeed / numPoints;
        
        // Calculate variance
        let sumSquaredDiff = 0;
        for (const speed of speeds) {
            sumSquaredDiff += Math.pow(speed - avgSpeed, 2);
        }
        const variance = sumSquaredDiff / numPoints;
        const stdDev = Math.sqrt(variance);
        const coeffVar = (stdDev / avgSpeed) * 100;
        
        // Update Processing stats
        document.getElementById('framesAnalyzed').textContent = `${numPoints.toLocaleString()} · ${(numPoints / frameRate).toFixed(2)} s coverage · 100% analyzed`;
        document.getElementById('fftSize').textContent = `${fftSize} samples · ${fftWindowMs.toFixed(2)} ms window · ${fftResolution.toFixed(2)} Hz resolution`;
        document.getElementById('frameRate').textContent = `${frameRate} Hz · ${frameStepMs.toFixed(2)} ms step · ~33% overlap`;
        document.getElementById('lookaheadLatency').textContent = `${lookaheadMs.toFixed(0)} ms · ${lookaheadFrames} frames · ${lookaheadSamples.toLocaleString()} samples`;
        
        document.getElementById('paramSpeed').textContent = `${this.params.speed.toFixed(2)}x · ${(100 / this.params.speed).toFixed(1)}% time`;
        document.getElementById('avgSpeed').textContent = `${avgSpeed.toFixed(2)}x · ${(100 / avgSpeed).toFixed(1)}% time · ${(avgSpeed / this.params.speed * 100).toFixed(1)}% of target`;
        document.getElementById('speedRange').textContent = `${minSpeed.toFixed(2)}x → ${maxSpeed.toFixed(2)}x · ${(maxSpeed / minSpeed).toFixed(2)}:1 dynamic range`;
        document.getElementById('speedVariance').textContent = `±${stdDev.toFixed(2)}x · σ=${stdDev.toFixed(3)} · ${coeffVar.toFixed(1)}% CV`;
        document.getElementById('paramNonlinear').textContent = `${(this.params.nonlinear * 100).toFixed(0)}% · factor ${this.params.nonlinear.toFixed(3)} · ${this.params.nonlinear === 1.0 ? 'full Speedy' : this.params.nonlinear === 0.0 ? 'linear only' : 'blend'}`;
        document.getElementById('paramFeedback').textContent = `${(this.params.feedback * 100).toFixed(0)}% · ${this.params.feedback.toFixed(3)} · ±${(this.params.feedback * 100).toFixed(0)}% speed adj`;
        
        // Drift correction (simulated based on actual vs expected duration)
        const inDur = this.originalBuffer.duration;
        const outDur = this.processedBuffer.duration;
        const expectedDuration = inDur / avgSpeed;
        const actualDuration = outDur;
        const driftMs = (actualDuration - expectedDuration) * 1000;
        const driftFrames = driftMs / frameStepMs;
        const driftSamples = Math.round(driftMs * sampleRate / 1000);
        document.getElementById('driftCorrection').textContent = `${(driftMs >= 0 ? '+' : '')}${driftMs.toFixed(1)} ms · ${(driftFrames >= 0 ? '+' : '')}${driftFrames.toFixed(1)} frames · ${(driftSamples >= 0 ? '+' : '')}${driftSamples.toLocaleString()} samples`;
        
        // Debug section
        const spectrogramPoints = numPoints * (fftSize / 2);
        const spectrogramMB = (spectrogramPoints * 4 / 1024 / 1024).toFixed(2);
        document.getElementById('spectrogramData').textContent = `${numPoints.toLocaleString()} frames × ${fftSize / 2} bins · ${spectrogramPoints.toLocaleString()} points · ${spectrogramMB} MB`;
        document.getElementById('speedProfileInfo').textContent = `${numPoints.toLocaleString()} points · ${(numPoints * 8).toLocaleString()} bytes · 2 points/frame`;
        document.getElementById('wasmHeap').textContent = 'N/A · heap metrics not exposed';
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

    // Helper to format dB values, handling silent audio gracefully
    formatDb(linearValue) {
        if (linearValue <= 0) return '-∞';
        return (20 * Math.log10(linearValue)).toFixed(2);
    }
}

const demo = new SpeedyDemo();
demo.initialize();

// Expose demo globally for inline script access
window.demo = demo;
