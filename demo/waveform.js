export class WaveformViewer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        
        // Dimensions (Logical)
        this.width = 0;
        this.height = 0;

        this.originalBuffer = null;
        this.processedBuffer = null;
        
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

        this.inspectMode = false; // If true, only show active buffer full height

        this.onSeek = null; // Callback
        this.onZoom = null; // Callback when zoom changes (for UI sync)
        this.onModeChange = null; // Callback when mode changes
        
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
            playhead: style.getPropertyValue('--wave-playhead').trim() || '#0f0',
            selection: style.getPropertyValue('--wave-selection').trim() || 'rgba(255, 255, 255, 0.1)',
            selectionBorder: style.getPropertyValue('--wave-selection-border').trim() || '#fff'
        };
    }

    bindEvents() {
        // Resize Observer
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.canvas);

        // Mouse/Touch interaction
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

    setData(original, processed) {
        this.originalBuffer = original;
        this.processedBuffer = processed;
        this.draw();
    }

    setPlaybackState(isPlaying, currentTime, activeBuffer) {
        this.playbackState.isPlaying = isPlaying;
        // If dragging playhead, don't update from playback loop to avoid fighting
        if (!this.isDraggingPlayhead) {
             this.playbackState.currentTime = currentTime;
        }
        this.playbackState.activeBuffer = activeBuffer;
        
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
        
        this.draw();
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

    getMaxDuration() {
        let max = 0;
        if (this.originalBuffer) max = Math.max(max, this.originalBuffer.duration);
        if (this.processedBuffer) max = Math.max(max, this.processedBuffer.duration);
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
            this.selection = null;
        }
    }

    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;

        if (this.isDraggingPlayhead) {
            // Update local current time (visual scrubbing)
            const t = this.xToTime(x);
            const maxDur = this.getMaxDuration();
            this.playbackState.currentTime = Math.max(0, Math.min(t, maxDur));
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
            // Selection created
        } else {
            // Click = Seek
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const time = this.xToTime(x);
            if (this.onSeek) this.onSeek(time);
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
        
        this.selection = null;
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
             if (this.originalBuffer) {
                const isActive = this.playbackState.activeBuffer === 'original';
                this.drawBuffer(this.originalBuffer, this.colors.origin, this.height / 4, 0.8, isActive);
             }
             if (this.processedBuffer) {
                const isActive = this.playbackState.activeBuffer === 'processed';
                this.drawBuffer(this.processedBuffer, this.colors.proc, this.height * 0.75, 0.8, isActive);
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

    drawBuffer(buffer, color, yCenter, heightScale, isActive) {
        const ctx = this.ctx;
        const data = buffer.getChannelData(0);
        const duration = buffer.duration;
        const amp = (this.height * (this.inspectMode ? 1.0 : 0.5)) / 2 * heightScale;
        
        if (this.inspectMode) {
             yCenter = this.height / 2;
        }

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
    }
    
    adjustColorOpacity(hex, opacity) {
        // Simple hex to rgba
        let c = hex.substring(1).split('');
        if(c.length==3) c= [c[0], c[0], c[1], c[1], c[2], c[2]];
        c= '0x'+c.join('');
        return 'rgba('+[(c>>16)&255, (c>>8)&255, c&255].join(',')+','+opacity+')';
    }
}
