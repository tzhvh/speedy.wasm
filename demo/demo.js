import SpeedyWasmWrapper from './speedy-wasm-wrapper.js';

const fileInput = document.getElementById('audioFile');
const speedSlider = document.getElementById('speed');
const speedValueSpan = document.getElementById('speedValue');
const nonlinearCheckbox = document.getElementById('nonlinear');
const feedbackSlider = document.getElementById('feedback');
const feedbackValueSpan = document.getElementById('feedbackValue');
const processButton = document.getElementById('processButton');
const playButton = document.getElementById('playButton');
const playProcessedButton = document.getElementById('playProcessedButton');
const statusDiv = document.getElementById('statusMessages');
const progressBar = document.getElementById('progressBar');
const downloadLink = document.getElementById('downloadLink');
const audioPlayer = document.getElementById('audioPlayer');


let audioContext = null;
let originalAudioBuffer = null;
let processedAudioBuffer = null;
let speedy = null;
let isProcessing = false;

// --- Initialization ---

async function initSpeedy() {
    updateStatus('Initializing WASM module...');
    try {
        speedy = new SpeedyWasmWrapper();
        await speedy.init();
        updateStatus('WASM Module Initialized. Ready for file.');
        fileInput.disabled = false;
    } catch (error) {
        updateStatus(`Error initializing WASM: ${error}`, true);
        console.error(error);
    }
}

// --- UI Updates ---

function updateStatus(message, isError = false) {
    console.log(message);
    statusDiv.textContent = message;
    statusDiv.style.color = isError ? 'red' : 'black';
}

function showProgress(show = true) {
     progressBar.style.display = show ? 'block' : 'none';
     if (!show) progressBar.value = 0;
}

function updateProgress(value, max) {
    progressBar.value = value;
    progressBar.max = max;
}

// --- Event Listeners ---

fileInput.addEventListener('change', handleFileSelect);
speedSlider.addEventListener('input', () => {
    speedValueSpan.textContent = parseFloat(speedSlider.value).toFixed(1);
});
feedbackSlider.addEventListener('input', () => {
    feedbackValueSpan.textContent = parseFloat(feedbackSlider.value).toFixed(2);
});
processButton.addEventListener('click', processAudio);
playButton.addEventListener('click', () => playAudio(originalAudioBuffer));
playProcessedButton.addEventListener('click', () => playAudio(processedAudioBuffer));


// --- Audio Handling ---

async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    updateStatus(`Loading file: ${file.name}...`);
    processButton.disabled = true;
    playButton.disabled = true;
    playProcessedButton.disabled = true;
    downloadLink.style.display = 'none';
    originalAudioBuffer = null;
    processedAudioBuffer = null;
    showProgress(false);

    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const arrayBuffer = e.target.result;
            updateStatus('Decoding audio data...');
            originalAudioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            updateStatus(`File loaded: ${originalAudioBuffer.numberOfChannels} channels, ${originalAudioBuffer.sampleRate} Hz, ${originalAudioBuffer.duration.toFixed(2)}s`);
            processButton.disabled = false;
            playButton.disabled = false;
        } catch (error) {
            updateStatus(`Error decoding audio file: ${error}`, true);
            console.error(error);
        }
    };
    reader.onerror = () => {
        updateStatus('Error reading file.', true);
    };
    reader.readAsArrayBuffer(file);
}

async function processAudio() {
    if (!speedy || !originalAudioBuffer || isProcessing) return;

    isProcessing = true;
    processButton.disabled = true;
    playButton.disabled = true;
    playProcessedButton.disabled = true;
    downloadLink.style.display = 'none';
    showProgress(true);
    updateStatus('Processing audio...');

    const sampleRate = originalAudioBuffer.sampleRate;
    const numChannels = originalAudioBuffer.numberOfChannels;
    const speed = parseFloat(speedSlider.value);
    const useNonlinear = nonlinearCheckbox.checked;
    const feedbackStrength = parseFloat(feedbackSlider.value);

    // Get raw PCM data (interleaved)
    const inputLength = originalAudioBuffer.length;
    const inputPCM = new Float32Array(inputLength * numChannels);
    const channelData = [];
    for (let i = 0; i < numChannels; i++) {
        channelData.push(originalAudioBuffer.getChannelData(i));
    }

    // Interleave channels
    for (let i = 0; i < inputLength; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            inputPCM[i * numChannels + ch] = channelData[ch][i];
        }
    }

    // Process in chunks to simulate streaming and show progress
    const chunkSize = 8192 * numChannels; // Process ~8k samples per channel at a time
    let processedChunks = [];
    let totalProcessedSamples = 0;

    try {
        speedy.create(sampleRate, numChannels);
        speedy.setSpeed(speed);
        speedy.enableNonlinear(useNonlinear);
        speedy.setDurationFeedback(feedbackStrength);

        for (let offset = 0; offset < inputPCM.length; offset += chunkSize) {
            const chunk = inputPCM.subarray(offset, offset + chunkSize);
            const outputChunk = speedy.process(chunk);
            if (outputChunk && outputChunk.length > 0) {
                processedChunks.push(outputChunk);
                totalProcessedSamples += outputChunk.length;
            }
            updateProgress(offset + chunk.length, inputPCM.length);
            // Yield to the event loop occasionally for large files
            if (offset % (chunkSize * 10) === 0) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        const finalChunk = speedy.flush();
        if (finalChunk && finalChunk.length > 0) {
            processedChunks.push(finalChunk);
            totalProcessedSamples += finalChunk.length;
        }

        // Combine chunks
        const outputPCM = new Float32Array(totalProcessedSamples);
        let currentOffset = 0;
        for (const chunk of processedChunks) {
            outputPCM.set(chunk, currentOffset);
            currentOffset += chunk.length;
        }

        // Create AudioBuffer from processed PCM
        const outputLength = outputPCM.length / numChannels;
        processedAudioBuffer = audioContext.createBuffer(numChannels, outputLength, sampleRate);

        // De-interleave channels
        for (let ch = 0; ch < numChannels; ch++) {
            const channel = processedAudioBuffer.getChannelData(ch);
            for (let i = 0; i < outputLength; i++) {
                channel[i] = outputPCM[i * numChannels + ch];
            }
        }

        updateStatus(`Processing complete. Output duration: ${processedAudioBuffer.duration.toFixed(2)}s`);
        playProcessedButton.disabled = false;
        enableDownload(outputPCM, numChannels, sampleRate);

    } catch (error) {
        updateStatus(`Error during processing: ${error}`, true);
        console.error(error);
    } finally {
        if (speedy) speedy.destroy(); // Clean up WASM resources
        isProcessing = false;
        processButton.disabled = false;
        playButton.disabled = false; // Re-enable original play
        showProgress(false);
    }
}

function playAudio(audioBuffer) {
    if (!audioBuffer || !audioContext) return;

    try {
         // Stop any previous playback
        if (audioPlayer.sourceNode) {
            audioPlayer.sourceNode.stop();
        }

        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);
        source.start();
        audioPlayer.sourceNode = source; // Keep track to stop later
        audioPlayer.style.display = 'block'; // Show player controls if hidden
        updateStatus(`Playing ${audioBuffer === originalAudioBuffer ? 'original' : 'processed'} audio...`);
        source.onended = () => {
             updateStatus('Playback finished.');
             audioPlayer.sourceNode = null;
        };
    } catch (error) {
        updateStatus(`Error playing audio: ${error}`, true);
        console.error(error);
    }
}


// --- WAV Export ---

function enableDownload(pcmData, numChannels, sampleRate) {
    const wavBlob = createWavBlob(pcmData, numChannels, sampleRate);
    const url = URL.createObjectURL(wavBlob);
    downloadLink.href = url;
    downloadLink.style.display = 'inline-block';
}

function createWavBlob(pcmData, numChannels, sampleRate) {
    const SIZEOF_FLOAT = 4;
    const totalSamples = pcmData.length;
    const dataSize = totalSamples * SIZEOF_FLOAT;
    const blockAlign = numChannels * SIZEOF_FLOAT;
    const byteRate = sampleRate * blockAlign;

    const buffer = new ArrayBuffer(44 + dataSize); // 44 bytes for header
    const view = new DataView(buffer);

    // RIFF header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true); // ChunkSize
    writeString(view, 8, 'WAVE');

    // fmt chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 3, true);  // AudioFormat (3 for IEEE float)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 32, true); // BitsPerSample (32 for float)

    // data chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Write PCM data
    let offset = 44;
    for (let i = 0; i < totalSamples; i++) {
        view.setFloat32(offset, pcmData[i], true);
        offset += SIZEOF_FLOAT;
    }

    return new Blob([view], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// --- Start ---
fileInput.disabled = true; // Disable until WASM loads
initSpeedy();