export class WaveformViewer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        
        // Dimensions (Logical)
        this.width = 0;
        this.height = 0;

        this.originalBuffer = null;
        this.processedBuffer = null;
        this.linearBuffer = null;
        
        // View State
        this.scaleMode = 'fit'; // 'fit' or 'realtime'
        this.pixelsPerSecond = 50; // Base zoom level for realtime
        this.scrollX = 0; // Horizontal scroll in pixels
        this.zoomLevel = 1.0; // Multiplier
        
        // Playback State
        this.playbackState = {
            isPlaying: false,
            currentTime: 0,
            activeBuffer: null // 'original' or 'processed'
        };

        // Selection State
        this.isDragging = false;
        this.dragStartX = 0;
        this.selection = null; // { start: time, end: time }
        this.hoverTime = null;

        // Pointer/Touch State (for unified mouse/touch/pen handling)
        this.activePointers = new Map(); // pointerId -> {x, y, startTime, startX, startY}
        this.capturedPointerId = null; // Currently captured pointer for drag operations
        this.isPinching = false; // Two-finger pinch active
        this.lastPinchDistance = 0; // For calculating zoom
        this.lastPinchCenter = { x: 0, y: 0 }; // For pinch-zoom center
        this.minDragDistance = 10; // Pixels to move before starting selection (larger for touch)
        this.playheadHitArea = 20; // Hit area for playhead (larger for touch)

        // Double-tap detection
        this.lastTap = { time: 0, x: 0, y: 0 };
        this.doubleTapTimeout = 300; // ms
        this.doubleTapDistance = 50; // pixels

        this.inspectMode = false; // If true, only show active buffer full height

        // Row-based configuration for flexible rendering
        this.rowConfig = [
            { id: 'original', type: 'waveform', heightRatio: 0.35, data: null, color: 'origin' },
            { id: 'processed', type: 'waveform', heightRatio: 0.35, data: null, color: 'proc' },
            { id: 'speedProfile', type: 'lineChart', heightRatio: 0.30, data: null, color: 'speed', minSpeed: 0.5, maxSpeed: 3.0 }
        ];

        this.linearReferenceEnabled = false;

        // Position mapping for bifurcated playhead
        this.positionMap = {
            originalToProcessed: null,
            processedToOriginal: null,
            originalDuration: 0,
            processedDuration: 0,
            isBuilt: false
        };

        // Speed profile animation state
        this.speedProfileAnimation = {
            isAnimating: false,
            startTime: 0,
            duration: 600,
            startScale: 1.0,
            targetScale: 1.0,
            currentScale: 1.0,
            animationId: null,
            startBuffer: null,
            targetBuffer: null
        };

        this.onSeek = null; // Callback
        this.onZoom = null; // Callback when zoom changes (for UI sync)
        this.onModeChange = null; // Callback when mode changes
        this.onSelectionChange = null; // Callback when selection changes (passes selection or null)
        
        this.colors = {};
        this.updateThemeColors();

        this.bindEvents();
        this.resize();
    }
    
    updateThemeColors() {
        const style = getComputedStyle(document.body);
        this.colors = {
            bg: style.getPropertyValue('--wave-bg').trim() || '#000',
            grid: style.getPropertyValue('--wave-grid').trim() || '#333',
            text: style.getPropertyValue('--wave-text').trim() || '#777',
            origin: style.getPropertyValue('--wave-origin').trim() || '#777',
            proc: style.getPropertyValue('--wave-proc').trim() || '#fff',
            speed: style.getPropertyValue('--wave-speed').trim() || '#8b5cf6',
            linear: style.getPropertyValue('--wave-linear').trim() || '#f59e0b',
            bifurcated: style.getPropertyValue('--wave-bifurcated').trim() || 'rgba(249, 115, 22, 0.5)',
            playhead: style.getPropertyValue('--wave-playhead').trim() || '#0f0',
            selection: style.getPropertyValue('--wave-selection').trim() || 'rgba(255, 255, 255, 0.1)',
            selectionBorder: style.getPropertyValue('--wave-selection-border').trim() || '#fff'
        };
    }

    easeInOutCubic(t) {
        // t: normalized progress [0, 1]
        // Returns: eased progress [0, 1]
        return t < 0.5
            ? 4 * t * t * t
            : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    updateRowData(rowId, data) {
        const row = this.rowConfig.find(r => r.id === rowId);
        if (row) row.data = data;
    }

    setSpeedProfile(speedProfileData) {
        this.updateRowData('speedProfile', speedProfileData);
        this.draw();
    }

    setLinearReferenceEnabled(enabled) {
        this.linearReferenceEnabled = enabled;

        if (enabled) {
            // 4-row layout
            this.rowConfig = [
                { id: 'original', type: 'waveform', heightRatio: 0.25, data: this.originalBuffer, color: 'origin' },
                { id: 'processed', type: 'waveform', heightRatio: 0.25, data: this.processedBuffer, color: 'proc' },
                { id: 'linear', type: 'waveform', heightRatio: 0.25, data: this.linearBuffer, color: 'linear' },
                { id: 'speedProfile', type: 'lineChart', heightRatio: 0.25, data: null, color: 'speed', minSpeed: 0.5, maxSpeed: 3.0 }
            ];
        } else {
            // 3-row layout (original)
            this.rowConfig = [
                { id: 'original', type: 'waveform', heightRatio: 0.35, data: this.originalBuffer, color: 'origin' },
                { id: 'processed', type: 'waveform', heightRatio: 0.35, data: this.processedBuffer, color: 'proc' },
                { id: 'speedProfile', type: 'lineChart', heightRatio: 0.30, data: null, color: 'speed', minSpeed: 0.5, maxSpeed: 3.0 }
            ];
        }
        this.draw();
    }

    buildPositionMap(originalDuration, processedDuration, speedProfile) {
        if (!speedProfile || speedProfile.length < 4) {
            this.positionMap.isBuilt = false;
            return;
        }

        const numPoints = speedProfile.length / 2;
        this.positionMap.originalToProcessed = new Float32Array(numPoints);
        this.positionMap.processedToOriginal = new Float32Array(numPoints);
        this.positionMap.originalDuration = originalDuration;
        this.positionMap.processedDuration = processedDuration;

        // Build forward mapping: original time → processed time
        let cumulativeProcessedTime = 0;

        for (let i = 0; i < numPoints; i++) {
            const frameIndex = speedProfile[i * 2];
            const speed = Math.max(0.01, speedProfile[i * 2 + 1]);

            // Integrate: delta_processed = delta_original / speed
            if (i > 0) {
                const prevFrameIndex = speedProfile[(i - 1) * 2];
                const frameDelta = frameIndex - prevFrameIndex;
                cumulativeProcessedTime += (frameDelta / 100.0) / speed;
            }

            this.positionMap.originalToProcessed[i] = cumulativeProcessedTime;
        }

        // Build reverse mapping: processed time → original time
        // Create sorted processed time array for binary search
        const processedTimes = new Float32Array(numPoints);
        for (let i = 0; i < numPoints; i++) {
            processedTimes[i] = this.positionMap.originalToProcessed[i];
        }

        // For each evenly-spaced processed time, find corresponding original time
        for (let i = 0; i < numPoints; i++) {
            const targetProcessedTime = (i / (numPoints - 1)) * processedDuration;
            this.positionMap.processedToOriginal[i] = this.binarySearchOriginal(processedTimes, targetProcessedTime, speedProfile);
        }

        this.positionMap.isBuilt = true;
    }

    calculateTimeScaleForBuffer(bufferType) {
        const speedProfileRow = this.rowConfig.find(r => r.id === 'speedProfile');
        if (!speedProfileRow || !speedProfileRow.data) return 1.0;

        const data = speedProfileRow.data;
        const speedProfileMaxTime = data[data.length - 2] / 100.0;

        const buffer = bufferType === 'processed'
            ? this.processedBuffer
            : bufferType === 'linear'
                ? this.linearBuffer
                : this.originalBuffer;
        const duration = buffer ? buffer.duration : this.getMaxDuration();

        return duration / (speedProfileMaxTime || 1);
    }

    startSpeedProfileAnimation(targetBuffer) {
        const animation = this.speedProfileAnimation;

        // Cancel existing animation if running
        if (animation.animationId !== null) {
            cancelAnimationFrame(animation.animationId);
            animation.animationId = null;
        }

        // Get speed profile data
        const speedProfileRow = this.rowConfig.find(r => r.id === 'speedProfile');
        if (!speedProfileRow || !speedProfileRow.data) return;

        const data = speedProfileRow.data;
        const speedProfileMaxTime = data[data.length - 2] / 100.0;

        // Calculate target timeScale based on target buffer
        const targetBufferObj = targetBuffer === 'processed'
            ? this.processedBuffer
            : targetBuffer === 'linear'
                ? this.linearBuffer
                : this.originalBuffer;
        const targetDuration = targetBufferObj ? targetBufferObj.duration : this.getMaxDuration();
        const targetScale = targetDuration / (speedProfileMaxTime || 1);

        // Set start state
        animation.startScale = animation.isAnimating
            ? animation.currentScale
            : this.calculateTimeScaleForBuffer(animation.targetBuffer || this.playbackState.activeBuffer);
        animation.targetScale = targetScale;
        animation.startBuffer = this.playbackState.activeBuffer;
        animation.targetBuffer = targetBuffer;
        animation.startTime = performance.now();
        animation.isAnimating = true;

        // Start animation loop
        const animate = (currentTime) => {
            const elapsed = currentTime - animation.startTime;
            const progress = Math.min(elapsed / animation.duration, 1.0);

            // Apply easing
            const easedProgress = this.easeInOutCubic(progress);

            // Interpolate timeScale
            animation.currentScale = animation.startScale +
                (animation.targetScale - animation.startScale) * easedProgress;

            // Trigger redraw
            this.draw();

            // Continue or complete animation
            if (progress < 1.0) {
                animation.animationId = requestAnimationFrame(animate);
            } else {
                animation.isAnimating = false;
                animation.animationId = null;
            }
        };

        animation.animationId = requestAnimationFrame(animate);
    }

    binarySearchOriginal(processedTimes, targetProcessedTime, speedProfile) {
        let left = 0;
        let right = processedTimes.length - 1;

        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (processedTimes[mid] < targetProcessedTime) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }

        // Linear interpolation for better precision
        if (left > 0 && left < processedTimes.length) {
            const t0 = processedTimes[left - 1];
            const t1 = processedTimes[left];
            const ratio = (t1 === t0) ? 0 : (targetProcessedTime - t0) / (t1 - t0);
            const frame0 = speedProfile[(left - 1) * 2];
            const frame1 = speedProfile[left * 2];
            return ((frame0 / 100.0) + ratio * ((frame1 - frame0) / 100.0));
        }

        return speedProfile[left * 2] / 100.0;
    }

    originalToProcessedTime(originalTime) {
        if (!this.positionMap.isBuilt || !this.positionMap.originalToProcessed) {
            return originalTime;
        }

        const speedProfile = this.rowConfig.find(r => r.id === 'speedProfile').data;
        if (!speedProfile) return originalTime;

        const targetFrame = originalTime * 100;
        const processedTimes = this.positionMap.originalToProcessed;
        
        let left = 0;
        let right = (speedProfile.length / 2) - 1;

        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (speedProfile[mid * 2] < targetFrame) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }

        if (left > 0 && left < processedTimes.length) {
            const f0 = speedProfile[(left - 1) * 2];
            const f1 = speedProfile[left * 2];
            const ratio = (f1 === f0) ? 0 : (targetFrame - f0) / (f1 - f0);
            const p0 = processedTimes[left - 1];
            const p1 = processedTimes[left];
            return p0 + ratio * (p1 - p0);
        }

        return processedTimes[left];
    }

    processedToOriginalTime(processedTime) {
        if (!this.positionMap.isBuilt || !this.positionMap.processedToOriginal) {
            return processedTime; // Fallback: assume 1x speed
        }

        const array = this.positionMap.processedToOriginal;
        const ratio = processedTime / this.positionMap.processedDuration;
        const idx = Math.min(Math.max(Math.floor(ratio * (array.length - 1)), 0), array.length - 1);

        // Linear interpolation
        if (idx < array.length - 1) {
            const t = (ratio * (array.length - 1)) - idx;
            return array[idx] + t * (array[idx + 1] - array[idx]);
        }

        return array[idx];
    }

    bindEvents() {
        // Resize Observer
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.canvas);

        // Pointer Events (unified mouse/touch/pen handling)
        this.canvas.addEventListener('pointerdown', this.handlePointerDown.bind(this));
        window.addEventListener('pointermove', this.handlePointerMove.bind(this));
        window.addEventListener('pointerup', this.handlePointerUp.bind(this));
        this.canvas.addEventListener('pointercancel', this.handlePointerCancel.bind(this));
        this.canvas.addEventListener('pointerout', this.handlePointerOut.bind(this));

        // Mouse events (kept for fallback compatibility)
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        window.addEventListener('mousemove', this.handleMouseMove.bind(this));
        window.addEventListener('mouseup', this.handleMouseUp.bind(this));
        this.canvas.addEventListener('wheel', this.handleWheel.bind(this));
    }

    resize() {
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const dpr = window.devicePixelRatio || 1;
        
        // Set physical size
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        
        // Normalize context to logical size
        this.ctx.scale(dpr, dpr);
        
        // Store logical size for calculations
        this.width = rect.width;
        this.height = rect.height;
        
        this.draw();
    }

    setData(original, processed, linear = null) {
        // Cancel any ongoing animation since buffers changed
        if (this.speedProfileAnimation.animationId !== null) {
            cancelAnimationFrame(this.speedProfileAnimation.animationId);
            this.speedProfileAnimation.animationId = null;
            this.speedProfileAnimation.isAnimating = false;
        }

        this.originalBuffer = original;
        this.processedBuffer = processed;
        this.linearBuffer = linear;
        this.updateRowData('original', original);
        this.updateRowData('processed', processed);
        if (this.linearReferenceEnabled) {
            this.updateRowData('linear', linear);
        }
        this.draw();
    }

    setPlaybackState(isPlaying, currentTime, activeBuffer) {
        const previousBuffer = this.playbackState.activeBuffer;

        this.playbackState.isPlaying = isPlaying;
        // If dragging playhead, don't update from playback loop to avoid fighting
        if (!this.isDraggingPlayhead) {
             this.playbackState.currentTime = currentTime;
        }
        this.playbackState.activeBuffer = activeBuffer;

        // Trigger speed profile animation if buffer changed
        if (previousBuffer !== activeBuffer && activeBuffer) {
            this.startSpeedProfileAnimation(activeBuffer);
        }

        // Auto-scroll / Follow Playback
        if (isPlaying && this.scaleMode === 'realtime' && !this.isDraggingPlayhead) {
            const currentX = this.timeToX(currentTime);
            const viewCenter = this.width / 2;
            
            // Continuous scrolling: Keep playhead near center
            // Check if playhead is deviating from center significantly
            const deviation = currentX - viewCenter;
            
            // Allow some slack so we don't jitter on every pixel, but "move with playback head" implies keeping it in view
            // Smoothly adjust scrollX to bring playhead towards center
            if (Math.abs(deviation) > 5) {
                // If it's way off (e.g. seeked or just started), jump or fast scroll.
                // Here we just set scrollX so playhead is at center.
                // Target scrollX:
                const targetScrollX = (currentTime * this.pixelsPerSecond) - viewCenter;
                
                // Determine scrolling speed/smoothing
                // For "realtime", we want it locked or very responsive.
                // Let's lock it to center if it's moving.
                this.scrollX = targetScrollX;
            }
        }

        // Only draw if not animating (animation loop handles drawing)
        if (!this.speedProfileAnimation.isAnimating) {
            this.draw();
        }
    }

    setScaleMode(mode) {
        if (this.scaleMode !== mode) {
            this.scaleMode = mode;
            if (this.onModeChange) this.onModeChange(mode);
        }
        // If switching to fit, reset scroll?
        // If switching to realtime, maybe center on current time?
        if (mode === 'realtime') {
             const centerT = this.playbackState.currentTime || 0;
             this.scrollX = (centerT * this.pixelsPerSecond) - (this.width / 2);
        } else {
             this.scrollX = 0;
        }
        this.draw();
    }

    setZoom(level) {
        const oldTimeCenter = this.xToTime(this.width / 2);
        
        if (this.scaleMode !== 'realtime') {
            this.scaleMode = 'realtime';
            if (this.onModeChange) this.onModeChange('realtime');
        }
        this.zoomLevel = level;
        this.pixelsPerSecond = 50 * level; // Base 50px/sec * zoom
        
        // Maintain center time
        this.scrollX = (oldTimeCenter * this.pixelsPerSecond) - (this.width / 2);
        
        this.draw();
    }
    
    setInspectMode(enabled) {
        this.inspectMode = enabled;
        this.draw();
    }

    clearSelection() {
        if (this.selection) {
            this.selection = null;
            if (this.onSelectionChange) {
                this.onSelectionChange(null);
            }
            this.draw();
        }
    }

    hasSelection() {
        return this.selection !== null;
    }

    getSelection() {
        return this.selection ? {...this.selection} : null;
    }

    getMaxDuration() {
        let max = 0;
        if (this.originalBuffer) max = Math.max(max, this.originalBuffer.duration);
        if (this.processedBuffer) max = Math.max(max, this.processedBuffer.duration);
        if (this.linearBuffer) max = Math.max(max, this.linearBuffer.duration);
        return max;
    }

    timeToX(time, relativeToView = true) {
        let x = 0;
        const maxDur = this.getMaxDuration() || 1;

        if (this.scaleMode === 'fit') {
            const effectiveScale = this.width / maxDur;
             x = time * effectiveScale;
        } else {
            // Realtime
            x = time * this.pixelsPerSecond;
        }

        if (relativeToView) {
            return x - this.scrollX;
        }
        return x;
    }

    xToTime(x, relativeToView = true) {
        const visualX = relativeToView ? x + this.scrollX : x;
        const maxDur = this.getMaxDuration() || 1;

        if (this.scaleMode === 'fit') {
             const effectiveScale = this.width / maxDur;
             return visualX / effectiveScale;
        } else {
            return visualX / this.pixelsPerSecond;
        }
    }

    handleMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;

        // Hit test playhead
        const playheadX = this.timeToX(this.playbackState.currentTime);
        if (Math.abs(x - playheadX) < 10) {
            this.isDraggingPlayhead = true;
            this.isDragging = false; // Mutually exclusive
        } else {
            this.isDragging = true;
            this.isDraggingPlayhead = false;
            this.dragStartX = x;
            // Clear existing selection when starting new drag
            if (this.selection) {
                this.selection = null;
                if (this.onSelectionChange) {
                    this.onSelectionChange(null);
                }
            }
        }
    }

    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;

        if (this.isDraggingPlayhead) {
            // Update local current time (visual scrubbing)
            const t = this.xToTime(x);
            const maxDur = this.getMaxDuration();

            // Clamp to selection bounds if active
            if (this.selection) {
                this.playbackState.currentTime = Math.max(this.selection.start, Math.min(t, this.selection.end));
            } else {
                this.playbackState.currentTime = Math.max(0, Math.min(t, maxDur));
            }
            this.draw();
            return;
        }

        if (!this.isDragging) {
            // Update hover cursor or time tooltip could go here
            return;
        }
        
        // If mouse is down, we are dragging (selection)
        
        // If moved significantly, start selection
        if (Math.abs(x - this.dragStartX) > 5) {
             const t1 = this.xToTime(this.dragStartX);
             const t2 = this.xToTime(x);
             this.selection = {
                 start: Math.min(t1, t2),
                 end: Math.max(t1, t2)
             };
             this.draw();
        }
    }

    handleMouseUp(e) {
        if (this.isDraggingPlayhead) {
            this.isDraggingPlayhead = false;
            if (this.onSeek) {
                this.onSeek(this.playbackState.currentTime);
            }
            return;
        }

        if (!this.isDragging) return;
        this.isDragging = false;

        if (this.selection) {
            // Selection created - notify callback
            if (this.onSelectionChange) {
                this.onSelectionChange({...this.selection});
            }
        } else {
            // Click = Seek (also clears any existing selection)
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const time = this.xToTime(x);
            if (this.onSeek) this.onSeek(time);
            // Clear selection on click
            if (this.selection && this.onSelectionChange) {
                this.selection = null;
                this.onSelectionChange(null);
                this.draw();
            }
        }
    }

    handleWheel(e) {
        e.preventDefault();
        // If ctrl pressed, zoom. Else scroll (if in realtime mode)

        if (e.ctrlKey || e.metaKey) {
            // Zoom
            const delta = -Math.sign(e.deltaY) * 0.1;
            const newZoom = Math.max(0.1, Math.min(100, this.zoomLevel + delta));

            // Zoom towards mouse pointer
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const timeAtMouse = this.xToTime(mouseX);

            this.setZoom(newZoom);
            if (this.onZoom) this.onZoom(newZoom);

            // Adjust scroll to keep timeAtMouse at mouseX
            if (this.scaleMode === 'realtime') {
                const newX = timeAtMouse * this.pixelsPerSecond;
                this.scrollX = newX - mouseX;
            }

        } else {
            // Scroll
            if (this.scaleMode === 'realtime') {
                this.scrollX += e.deltaY;
                // Clamp scroll?
                // const maxW = this.getMaxDuration() * this.pixelsPerSecond;
                // this.scrollX = Math.max(0, Math.min(this.scrollX, maxW - this.width));
                // Better to allow some overscroll
                this.draw();
            }
        }
    }

    // ========== POINTER EVENT HANDLERS (Unified Mouse/Touch/Pen) ==========

    handlePointerDown(e) {
        e.preventDefault();

        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Store pointer info
        this.activePointers.set(e.pointerId, {
            x, y,
            startX: x,
            startY: y,
            startTime: performance.now(),
            isTap: true
        });

        // Check for multi-touch gestures
        if (this.activePointers.size >= 2) {
            // Two or more pointers - potential pinch/pan gesture
            this.updatePinchState();
            return;
        }

        // Single pointer - check for playhead hit or selection start
        const playheadX = this.timeToX(this.playbackState.currentTime);

        if (Math.abs(x - playheadX) < this.playheadHitArea) {
            // Hit playhead - prepare for drag
            this.isDraggingPlayhead = true;
            this.isDragging = false;
            this.capturedPointerId = e.pointerId;
            this.canvas.setPointerCapture(e.pointerId);
        } else {
            // Click on empty space - prepare for potential selection drag
            this.isDragging = true;
            this.isDraggingPlayhead = false;
            this.dragStartX = x;
            this.capturedPointerId = e.pointerId;
            this.canvas.setPointerCapture(e.pointerId);

            // Clear existing selection when starting new drag
            if (this.selection) {
                this.selection = null;
                if (this.onSelectionChange) {
                    this.onSelectionChange(null);
                }
                this.draw();
            }
        }
    }

    handlePointerMove(e) {
        // Only process if this is our captured pointer
        if (this.capturedPointerId !== null && e.pointerId !== this.capturedPointerId) {
            return;
        }

        // Update pointer position
        if (this.activePointers.has(e.pointerId)) {
            const rect = this.canvas.getBoundingClientRect();
            const ptr = this.activePointers.get(e.pointerId);
            ptr.x = e.clientX - rect.left;
            ptr.y = e.clientY - rect.top;

            // Mark as not a tap if moved significantly
            const dx = ptr.x - ptr.startX;
            const dy = ptr.y - ptr.startY;
            if (Math.sqrt(dx * dx + dy * dy) > 10) {
                ptr.isTap = false;
            }
        }

        // Handle pinch/pan gestures
        if (this.activePointers.size >= 2) {
            e.preventDefault();
            this.updatePinchState();
            return;
        }

        // Single pointer drag
        if (this.capturedPointerId === e.pointerId) {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;

            if (this.isDraggingPlayhead) {
                // Dragging playhead
                const t = this.xToTime(x);
                const maxDur = this.getMaxDuration();

                // Clamp to selection bounds if active
                if (this.selection) {
                    this.playbackState.currentTime = Math.max(this.selection.start, Math.min(t, this.selection.end));
                } else {
                    this.playbackState.currentTime = Math.max(0, Math.min(t, maxDur));
                }
                this.draw();

            } else if (this.isDragging) {
                // Creating selection
                if (Math.abs(x - this.dragStartX) > this.minDragDistance) {
                    const t1 = this.xToTime(this.dragStartX);
                    const t2 = this.xToTime(x);
                    this.selection = {
                        start: Math.min(t1, t2),
                        end: Math.max(t1, t2)
                    };
                    this.draw();
                }
            }
        }
    }

    handlePointerUp(e) {
        // Remove from active pointers
        const ptr = this.activePointers.get(e.pointerId);
        if (ptr) {
            this.activePointers.delete(e.pointerId);
        }

        // Release capture if this was our pointer
        if (this.capturedPointerId === e.pointerId) {
            this.canvas.releasePointerCapture(e.pointerId);
            this.capturedPointerId = null;

            if (this.isDraggingPlayhead) {
                // Finalize playhead drag
                this.isDraggingPlayhead = false;
                if (this.onSeek) {
                    this.onSeek(this.playbackState.currentTime);
                }

            } else if (this.isDragging) {
                // Finalize selection or handle tap
                this.isDragging = false;

                if (this.selection) {
                    // Selection created
                    if (this.onSelectionChange) {
                        this.onSelectionChange({...this.selection});
                    }
                } else if (ptr && ptr.isTap) {
                    // Check for double-tap
                    const now = performance.now();
                    const timeSinceLastTap = now - this.lastTap.time;
                    const dx = ptr.startX - this.lastTap.x;
                    const dy = ptr.startY - this.lastTap.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (timeSinceLastTap < this.doubleTapTimeout && dist < this.doubleTapDistance) {
                        // Double-tap detected!
                        this.handleDoubleTap(ptr.startX, ptr.startY);
                        this.lastTap = { time: 0, x: 0, y: 0 }; // Reset
                    } else {
                        // Single tap = seek
                        this.lastTap = { time: now, x: ptr.startX, y: ptr.startY };
                        const time = this.xToTime(ptr.startX);
                        if (this.onSeek) this.onSeek(time);
                    }
                }
            }
        }

        // Exit pinch mode if < 2 pointers remaining
        if (this.activePointers.size < 2) {
            this.isPinching = false;
        }
    }

    handlePointerCancel(e) {
        // Treat like pointerup
        this.handlePointerUp(e);
    }

    handlePointerOut(e) {
        // Only relevant if pointer wasn't captured
        if (this.capturedPointerId === null && this.activePointers.has(e.pointerId)) {
            this.activePointers.delete(e.pointerId);
        }
    }

    // ========== GESTURE HANDLING ==========

    updatePinchState() {
        const pointers = Array.from(this.activePointers.values());
        if (pointers.length < 2) return;

        const p1 = pointers[0];
        const p2 = pointers[1];

        // Calculate distance between pointers
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // Calculate center point
        const centerX = (p1.x + p2.x) / 2;
        const centerY = (p1.y + p2.y) / 2;

        if (this.isPinching && this.lastPinchDistance > 0) {
            // Calculate zoom from pinch
            const scale = distance / this.lastPinchDistance;

            // Apply zoom if change is significant
            if (Math.abs(scale - 1) > 0.01) {
                const rect = this.canvas.getBoundingClientRect();
                const timeAtCenter = this.xToTime(centerX);

                // Calculate new zoom level
                const newZoom = Math.max(0.1, Math.min(100, this.zoomLevel * scale));

                this.setZoom(newZoom);
                if (this.onZoom) this.onZoom(newZoom);

                // Adjust scroll to keep center point stable
                if (this.scaleMode === 'realtime') {
                    const newX = timeAtCenter * this.pixelsPerSecond;
                    this.scrollX = newX - centerX;
                }

                this.lastPinchDistance = distance;
                this.draw();
            }
        } else {
            // Initialize pinch state
            this.isPinching = true;
            this.lastPinchDistance = distance;
        }

        // Handle two-finger pan (horizontal movement of center point)
        if (this.lastPinchCenter.x !== 0) {
            const deltaX = centerX - this.lastPinchCenter.x;

            if (this.scaleMode === 'realtime' && Math.abs(deltaX) > 2) {
                this.scrollX += deltaX;
                this.draw();
            }
        }

        this.lastPinchCenter = { x: centerX, y: centerY };
    }

    handleDoubleTap(x, y) {
        // Double-tap action: toggle inspect mode
        this.inspectMode = !this.inspectMode;

        // If inspect mode is enabled, also clear any selection
        if (this.inspectMode && this.selection) {
            this.selection = null;
            if (this.onSelectionChange) {
                this.onSelectionChange(null);
            }
        }

        this.draw();
    }
    
    zoomToSelection() {
        if (!this.selection) return;
        const duration = this.selection.end - this.selection.start;
        if (duration <= 0) return;

        // Switch to realtime if not already
        if (this.scaleMode !== 'realtime') {
            this.scaleMode = 'realtime';
            if (this.onModeChange) this.onModeChange('realtime');
        }

        // Calculate needed pixelsPerSecond
        // We want duration to fit in width
        this.pixelsPerSecond = this.width / duration;

        // Update Zoom Level for UI
        this.zoomLevel = this.pixelsPerSecond / 50;

        // Scroll to start
        this.scrollX = this.selection.start * this.pixelsPerSecond;

        // Clear selection and notify callback (this resets playback bounds)
        this.selection = null;
        if (this.onSelectionChange) {
            this.onSelectionChange(null);
        }
        this.draw();

        if (this.onZoom) this.onZoom(this.zoomLevel);
        return 'realtime'; // Return mode to update UI selector
    }

    draw() {
        // Clear
        this.ctx.fillStyle = this.colors.bg;
        this.ctx.fillRect(0, 0, this.width, this.height);

        // Draw Grid
        this.drawGrid();

        // Draw Buffers
        if (this.inspectMode) {
             if (this.playbackState.activeBuffer === 'original' && this.originalBuffer) {
                 this.drawBuffer(this.originalBuffer, this.colors.origin, 0, 1.0, true);
             } else if (this.playbackState.activeBuffer === 'processed' && this.processedBuffer) {
                 this.drawBuffer(this.processedBuffer, this.colors.proc, 0, 1.0, true);
             } else {
                 // Fallback
                 this.inspectMode = false;
                 this.draw();
                 return;
             }
        } else {
             // Draw rows using row configuration
             let currentY = 0;
             for (const row of this.rowConfig) {
                 const rowHeight = this.height * row.heightRatio;
                 const yCenter = currentY + rowHeight / 2;

                 if (row.type === 'waveform' && row.data) {
                     const isActive = this.playbackState.activeBuffer === row.id;
                     this.drawBuffer(row.data, this.colors[row.color], yCenter, 0.8, isActive, currentY, rowHeight);
                 } else if (row.type === 'lineChart' && row.data) {
                     this.drawSpeedProfile(row, currentY, rowHeight);
                 }

                 currentY += rowHeight;
             }
        }

        // Draw Selection
        if (this.selection) {
            const x1 = this.timeToX(this.selection.start);
            const x2 = this.timeToX(this.selection.end);
            
            // Hatching pattern or just simple industrial block
            this.ctx.fillStyle = this.colors.selection;
            this.ctx.fillRect(x1, 0, x2 - x1, this.height);
            this.ctx.strokeStyle = this.colors.selectionBorder;
            this.ctx.lineWidth = 1;
            this.ctx.setLineDash([4, 4]);
            this.ctx.strokeRect(x1, 0, x2 - x1, this.height);
            this.ctx.setLineDash([]);
        }

        // Draw bifurcated playhead (for inactive buffer)
        if (this.positionMap.isBuilt && this.playbackState.currentTime >= 0) {
            const currentTime = this.playbackState.currentTime;
            const isActiveOriginal = this.playbackState.activeBuffer === 'original';

            // Calculate position in inactive buffer
            let inactiveTime;
            if (isActiveOriginal) {
                // Playing original: show where we'd be in processed
                inactiveTime = this.originalToProcessedTime(currentTime);
            } else {
                // Playing processed: show where we'd be in original
                inactiveTime = this.processedToOriginalTime(currentTime);
            }

            // Find inactive row bounds
            const inactiveRow = this.rowConfig.find(r =>
                (isActiveOriginal && r.id === 'processed') ||
                (!isActiveOriginal && r.id === 'original')
            );

            if (inactiveRow && inactiveRow.data) {
                const rowHeight = this.height * inactiveRow.heightRatio;
                let currentY = 0;

                // Calculate Y offset for inactive row
                for (const row of this.rowConfig) {
                    if (row.id === inactiveRow.id) break;
                    currentY += this.height * row.heightRatio;
                }

                const x = this.timeToX(inactiveTime);

                if (x >= -5 && x <= this.width + 5) {
                    this.ctx.strokeStyle = this.colors.bifurcated;
                    this.ctx.lineWidth = 1;
                    this.ctx.setLineDash([4, 4]); // Dashed line
                    this.ctx.beginPath();
                    this.ctx.moveTo(x, currentY);
                    this.ctx.lineTo(x, currentY + rowHeight);
                    this.ctx.stroke();
                    this.ctx.setLineDash([]); // Reset

                    // Smaller triangle marker
                    this.ctx.fillStyle = this.colors.bifurcated;
                    this.ctx.beginPath();
                    this.ctx.moveTo(x - 3, currentY);
                    this.ctx.lineTo(x + 3, currentY);
                    this.ctx.lineTo(x, currentY + 4);
                    this.ctx.fill();
                }
            }
        }

        // Draw Playhead
        if (this.playbackState.currentTime >= 0) {
            const x = this.timeToX(this.playbackState.currentTime);
            // Only draw if visible
            if (x >= -5 && x <= this.width + 5) {
                this.ctx.strokeStyle = this.colors.playhead;
                this.ctx.lineWidth = 1;
                this.ctx.beginPath();
                this.ctx.moveTo(x, 0);
                this.ctx.lineTo(x, this.height);
                this.ctx.stroke();

                // Simple triangle marker top
                this.ctx.fillStyle = this.colors.playhead;
                this.ctx.beginPath();
                this.ctx.moveTo(x - 4, 0);
                this.ctx.lineTo(x + 4, 0);
                this.ctx.lineTo(x, 6);
                this.ctx.fill();
            }
        }
    }

    drawGrid() {
        const ctx = this.ctx;
        ctx.fillStyle = this.colors.grid;
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';

        // Determine grid interval
        let pixelsPerSec = this.pixelsPerSecond;
        if (this.scaleMode === 'fit') {
            pixelsPerSec = this.width / (this.getMaxDuration() || 1);
        }

        const minGridPx = 100;
        let timeStep = 1;
        
        if (pixelsPerSec > 0) {
            while (timeStep * pixelsPerSec < minGridPx) timeStep *= 2;
            while (timeStep * pixelsPerSec > minGridPx * 2) timeStep /= 2;
        }

        const startT = this.xToTime(0);
        const endT = this.xToTime(this.width);
        
        const startGrid = Math.floor(startT / timeStep) * timeStep;

        // Draw vertical grid lines as dots
        for (let t = startGrid; t < endT; t += timeStep) {
            if (t < 0) continue;
            const x = Math.floor(this.timeToX(t)) + 0.5; // Crisp lines
            
            // Draw dotted line
            ctx.fillStyle = this.colors.grid;
            for (let y = 0; y < this.height; y += 4) {
                ctx.fillRect(x, y, 1, 1);
            }
            
            // Time label
            ctx.fillStyle = this.colors.text;
            ctx.fillText(t.toFixed(2) + 's', x + 4, this.height - 4);
        }
        
        // Draw horizontal center line (zero crossing)
        ctx.fillStyle = this.colors.grid; // Or slightly dimmer
        for (let x = 0; x < this.width; x += 4) {
             ctx.fillRect(x, this.height / 2, 1, 1);
             ctx.fillRect(x, this.height / 4, 1, 1);
             ctx.fillRect(x, this.height * 0.75, 1, 1);
        }
    }

    drawBuffer(buffer, color, yCenter, heightScale, isActive, yOffset = 0, rowHeight = this.height) {
        const ctx = this.ctx;
        const data = buffer.getChannelData(0);
        const duration = buffer.duration;
        const amp = (this.height * (this.inspectMode ? 1.0 : 0.5)) / 2 * heightScale;

        if (this.inspectMode) {
             yCenter = this.height / 2;
        }

        // Clip to row bounds
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, yOffset, this.width, rowHeight);
        ctx.clip();

        ctx.beginPath();
        // Sharper, thinner lines
        ctx.strokeStyle = isActive ? color : this.adjustColorOpacity(color, 0.3);
        ctx.lineWidth = 1;

        const startPixel = 0;
        const endPixel = this.width;

        for (let x = startPixel; x < endPixel; x++) {
            const tStart = this.xToTime(x);
            const tEnd = this.xToTime(x + 1);

            let idxStart = Math.floor(tStart * buffer.sampleRate);
            let idxEnd = Math.ceil(tEnd * buffer.sampleRate);

            if (idxStart < 0) idxStart = 0;
            if (idxEnd > data.length) idxEnd = data.length;
            if (idxStart >= idxEnd) continue;

            let min = 1.0;
            let max = -1.0;

            const step = Math.ceil((idxEnd - idxStart) / 50);

            let hasData = false;
            for (let i = idxStart; i < idxEnd; i += Math.max(1, step)) {
                const val = data[i];
                if (val < min) min = val;
                if (val > max) max = val;
                hasData = true;
            }

            if (hasData) {
                if (min === 1.0 && max === -1.0) {
                     min = 0; max = 0;
                }
                // Crisp rendering
                const xPos = x + 0.5;
                ctx.moveTo(xPos, yCenter + min * amp);
                ctx.lineTo(xPos, yCenter + max * amp);
            }
        }
        ctx.stroke();
        ctx.restore();
    }

    drawSpeedProfile(row, yOffset, rowHeight) {
        const data = row.data; // Float32Array: [time, speed, time, speed, ...]
        if (!data || data.length < 4) return;

        const ctx = this.ctx;
        const padding = 4;
        const drawHeight = rowHeight - padding * 2;
        const drawYTop = yOffset + padding;
        const speedRange = row.maxSpeed - row.minSpeed;

        // Calculate time scaling based on active buffer
        // Speed profile times are relative to original audio timeline
        // When processed buffer is active, scale to fit its duration

        // Use animated scale if animating, otherwise calculate directly
        let timeScale;
        if (this.speedProfileAnimation.isAnimating) {
            timeScale = this.speedProfileAnimation.currentScale;
        } else {
            const activeBuffer = this.playbackState.activeBuffer === 'processed' && this.processedBuffer
                ? this.processedBuffer
                : this.originalBuffer;
            const activeDuration = activeBuffer ? activeBuffer.duration : this.getMaxDuration();

            // Get speed profile max time (last frame index / 100)
            const speedProfileMaxTime = data[data.length - 2] / 100.0;
            timeScale = activeDuration / (speedProfileMaxTime || 1);
        }

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, yOffset, this.width, rowHeight);
        ctx.clip();

        // Build path
        ctx.beginPath();
        let firstPoint = true;
        for (let i = 0; i < data.length; i += 2) {
            const frameIndex = data[i];
            const speed = data[i + 1];
            const timeSeconds = frameIndex / 100.0; // 100Hz
            // Scale time to match active buffer duration
            const scaledTime = timeSeconds * timeScale;
            const x = this.timeToX(scaledTime);

            if (x < -10 || x > this.width + 10) continue;

            const normalizedSpeed = (speed - row.minSpeed) / speedRange;
            const y = drawYTop + drawHeight * (1 - normalizedSpeed);

            if (firstPoint) { ctx.moveTo(x, y); firstPoint = false; }
            else { ctx.lineTo(x, y); }
        }

        // Draw line with gradient fill
        ctx.strokeStyle = this.colors[row.color];
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Gradient fill below line
        const gradient = ctx.createLinearGradient(0, drawYTop, 0, drawYTop + drawHeight);
        gradient.addColorStop(0, this.colors[row.color] + '40');
        gradient.addColorStop(1, this.colors[row.color] + '00');
        ctx.lineTo(this.width, drawYTop + drawHeight);
        ctx.lineTo(0, drawYTop + drawHeight);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // Speed threshold lines (1x, 2x)
        ctx.strokeStyle = this.colors.grid;
        ctx.lineWidth = 1;
        [1.0, 2.0].forEach(threshold => {
            if (threshold >= row.minSpeed && threshold <= row.maxSpeed) {
                const y = drawYTop + drawHeight * (1 - (threshold - row.minSpeed) / speedRange);
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(this.width, y);
                ctx.stroke();
            }
        });

        ctx.restore();
    }

    adjustColorOpacity(hex, opacity) {
        // Simple hex to rgba
        let c = hex.substring(1).split('');
        if(c.length==3) c= [c[0], c[0], c[1], c[1], c[2], c[2]];
        c= '0x'+c.join('');
        return 'rgba('+[(c>>16)&255, (c>>8)&255, c&255].join(',')+','+opacity+')';
    }
}
