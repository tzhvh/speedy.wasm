//  Copyright 2024 Speedy WASM Contributors.
//
//  Licensed under the Apache License, Version 2.0 (the "License");
//  you may not use this file except in compliance with the License.
//  You may obtain a copy of the License at
//
//       https://www.apache.org/licenses/LICENSE-2.0
//
//  Unless required by applicable law or agreed to in writing, software
//  distributed under the License is distributed on an "AS IS" BASIS,
//  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//  See the License for the specific language governing permissions and
//  limitations under the License.

/*
 * WebAssembly bindings for Speedy audio library using embind.
 *
 * This file provides JavaScript wrappers for the Speedy and Sonic C APIs,
 * enabling nonlinear speech speedup in web applications.
 */

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <cstdint>
#include <cstring>
#include <vector>
#include <memory>
#include <stdexcept>
#include <map>
#include <mutex>

// Forward declarations for C APIs
extern "C" {
    #include "speedy.h"
    #include "sonic2.h"
}

struct SonicStreamWrapper;

// Static map to route callbacks
static std::map<sonicStream, SonicStreamWrapper*> streamMap;
static std::mutex streamMapMutex;

// ============================================================================
// Memory Management Helpers
// ============================================================================

namespace {
    // Helper to convert JavaScript TypedArray to std::vector<float>
    std::vector<float> jsArrayToFloatVector(const emscripten::val& js_array) {
        if (js_array.isUndefined() || js_array.isNull()) {
            return std::vector<float>();
        }

        const auto length = js_array["length"].as<unsigned>();
        std::vector<float> result;
        result.reserve(length);

        // Use typed_memory_view for zero-copy access when possible
        // For embind, we need to iterate through the array
        for (unsigned i = 0; i < length; ++i) {
            result.push_back(js_array[i].as<float>());
        }

        return result;
    }

    // Helper to convert JavaScript TypedArray to std::vector<int16_t>
    std::vector<int16_t> jsArrayToInt16Vector(const emscripten::val& js_array) {
        if (js_array.isUndefined() || js_array.isNull()) {
            return std::vector<int16_t>();
        }

        const auto length = js_array["length"].as<unsigned>();
        std::vector<int16_t> result;
        result.reserve(length);

        for (unsigned i = 0; i < length; ++i) {
            result.push_back(js_array[i].as<int16_t>());
        }

        return result;
    }

    // Helper to convert std::vector<float> to JavaScript Float32Array
    emscripten::val floatVectorToJsArray(const std::vector<float>& vec) {
        if (vec.empty()) {
            return emscripten::val::undefined();
        }

        // Create a Float32Array of the correct size
        emscripten::val result = emscripten::val::global("Float32Array").new_(vec.size());

        // Copy each element from the vector to the JavaScript array
        for (size_t i = 0; i < vec.size(); ++i) {
            result.set(i, vec[i]);
        }

        return result;
    }

    // Helper to convert std::vector<int16_t> to JavaScript Int16Array
    emscripten::val int16VectorToJsArray(const std::vector<int16_t>& vec) {
        if (vec.empty()) {
            return emscripten::val::undefined();
        }

        // Create an Int16Array of the correct size
        emscripten::val result = emscripten::val::global("Int16Array").new_(vec.size());

        // Copy each element from the vector to the JavaScript array
        for (size_t i = 0; i < vec.size(); ++i) {
            result.set(i, vec[i]);
        }

        return result;
    }
}

// ============================================================================
// SpeedyStreamWrapper
// ============================================================================

/**
 * Wrapper class for speedyStream opaque pointer.
 *
 * Provides JavaScript API for the Speedy nonlinear speech speedup algorithm.
 * Speedy computes tension values that can be used to drive audio time-scale modification.
 */
struct SpeedyStreamWrapper {
    speedyStream stream;

    /**
     * Create a new Speedy stream.
     * @param sample_rate Audio sample rate in Hz (e.g., 22050, 44100, 48000)
     * @throws std::runtime_error if stream creation fails
     */
    SpeedyStreamWrapper(int sample_rate) : stream(nullptr) {
        stream = speedyCreateStream(sample_rate);
        if (!stream) {
            throw std::runtime_error("Failed to create Speedy stream: out of memory");
        }
    }

    /**
     * Destroy the Speedy stream and release resources.
     */
    ~SpeedyStreamWrapper() {
        if (stream) {
            speedyDestroyStream(stream);
            stream = nullptr;
        }
    }

    /**
     * Get the required input frame size in samples.
     * Audio data sent to addData must have this many samples.
     * @return Frame size in samples
     */
    int inputFrameSize() {
        return speedyInputFrameSize(stream);
    }

    /**
     * Get the input frame step in samples.
     * Frames should be sent at this interval for proper tension computation.
     * @return Frame step in samples
     */
    int inputFrameStep() {
        return speedyInputFrameStep(stream);
    }

    /**
     * Add audio data to the Speedy stream.
     * The input array must have inputFrameSize() samples.
     * @param input_array Float32Array containing audio samples (-1.0 to 1.0)
     * @param at_time Frame timestamp (starting from 0, incrementing by 1)
     */
    void addData(const emscripten::val& input_array, int64_t at_time) {
        auto data = jsArrayToFloatVector(input_array);
        if (data.empty()) {
            throw std::runtime_error("Input array is empty");
        }
        speedyAddData(stream, data.data(), at_time);
    }

    /**
     * Zero-copy version of addData.
     * @param input_ptr Pointer to float array in WASM memory
     * @param size Number of samples
     * @param at_time Frame timestamp
     */
    void addDataPtr(uintptr_t input_ptr, int size, int64_t at_time) {
        float* data = reinterpret_cast<float*>(input_ptr);
        speedyAddData(stream, data, at_time);
    }

    /**
     * Add audio data to the Speedy stream (int16 version).
     * The input array must have inputFrameSize() samples.
     * @param input_array Int16Array containing audio samples
     * @param at_time Frame timestamp (starting from 0, incrementing by 1)
     */
    void addDataShort(const emscripten::val& input_array, int64_t at_time) {
        auto data = jsArrayToInt16Vector(input_array);
        if (data.empty()) {
            throw std::runtime_error("Input array is empty");
        }
        speedyAddDataShort(stream, data.data(), at_time);
    }

    /**
     * Compute the tension for a given frame time.
     * Tension is a value that represents how much the audio should be sped up
     * at a given point based on spectral analysis.
     * @param at_time Frame timestamp
     * @return Tension value (typically 0.0 to 1.0, but can vary)
     * @throws std::runtime_error if insufficient data to compute tension
     */
    float computeTension(int64_t at_time) {
        float tension;
        int result = speedyComputeTension(stream, at_time, &tension);
        if (!result) {
            throw std::runtime_error("Insufficient data to compute tension at time " +
                                     std::to_string(at_time));
        }
        return tension;
    }

    /**
     * Convert tension to playback speed.
     * @param tension Tension value from computeTension()
     * @param R_g Global speed ratio (target average speedup, e.g., 2.0)
     * @param duration_feedback_strength Feedback strength for duration correction (0.0 to 0.5)
     * @return Speed multiplier (e.g., 2.0 = double speed)
     */
    float computeSpeedFromTension(float tension, float R_g,
                                  float duration_feedback_strength) {
        return speedyComputeSpeedFromTension(tension, R_g, duration_feedback_strength, stream);
    }

    void setPreemphasisFactor(float factor) {
        speedySetPreemphasisFactor(stream, factor);
    }

    void setLowEnergyThresholdScale(float scale) {
        speedySetLowEnergyThresholdScale(stream, scale);
    }

    void setBinThresholdDivisor(float divisor) {
        speedySetBinThresholdDivisor(stream, divisor);
    }

    void setTensionWeights(float energy_weight, float speech_weight) {
        speedySetTensionWeights(stream, energy_weight, speech_weight);
    }

    void setTensionOffsets(float energy_offset, float speech_offset) {
        speedySetTensionOffsets(stream, energy_offset, speech_offset);
    }

    void setSpeechChangeCapMultiplier(float multiplier) {
        speedySetSpeechChangeCapMultiplier(stream, multiplier);
    }

    /**
     * Get the current frame time in the stream.
     * @return Current frame index
     */
    int64_t getCurrentTime() {
        return speedyGetCurrentTime(stream);
    }

    /**
     * Get the FFT size used for spectral analysis.
     * @return FFT size in samples
     */
    int fftSize() {
        return speedyFFTSize(stream);
    }

    /**
     * Get the frame rate used for analysis.
     * @return Frame rate in Hz
     */
    float frameRate() {
        return 100.0f;  // kFrameRateHz
    }

    /**
     * Get the preemphasis filter coefficient.
     * @return Preemphasis coefficient (0.97)
     */
    float preemphasisCoefficient() {
        return 0.97f;
    }

    /**
     * Get the temporal hysteresis future frame count.
     * @return Number of future frames for hysteresis
     */
    int temporalHysteresisFuture() {
#ifdef MATCH_MATLAB
        return 8;  // kTemporalHysteresisFuture
#else
        return 12;  // kTemporalHysteresisFuture
#endif
    }

    /**
     * Get the temporal hysteresis past frame count.
     * @return Number of past frames for hysteresis
     */
    int temporalHysteresisPast() {
#ifdef MATCH_MATLAB
        return 12;  // kTemporalHysteresisPast
#else
        return 8;  // kTemporalHysteresisPast
#endif
    }

    // Prevent copying
    SpeedyStreamWrapper(const SpeedyStreamWrapper&) = delete;
    SpeedyStreamWrapper& operator=(const SpeedyStreamWrapper&) = delete;
};

// ============================================================================
// SonicStreamWrapper
// ============================================================================

/**
 * Wrapper class for sonicStream opaque pointer.
 *
 * Provides JavaScript API for the Sonic audio speedup library.
 * Sonic performs the actual time-scale modification of audio data.
 */
struct SonicStreamWrapper {
    sonicStream stream;
    int numChannels;
    int sampleRate;
    
    // Buffer for speed profile
    std::vector<float> speedProfile;

    /**
     * Create a new Sonic stream.
     * @param sample_rate Audio sample rate in Hz
     * @param num_channels Number of audio channels (1 = mono, 2 = stereo)
     * @throws std::runtime_error if stream creation fails
     */
    SonicStreamWrapper(int sample_rate, int num_channels)
        : stream(nullptr), numChannels(num_channels), sampleRate(sample_rate) {
        stream = sonicCreateStream(sample_rate, num_channels);
        if (!stream) {
            throw std::runtime_error("Failed to create Sonic stream: out of memory");
        }
        
        std::lock_guard<std::mutex> lock(streamMapMutex);
        streamMap[stream] = this;
    }

    /**
     * Destroy the Sonic stream and release resources.
     */
    ~SonicStreamWrapper() {
        if (stream) {
            std::lock_guard<std::mutex> lock(streamMapMutex);
            streamMap.erase(stream);
            
            sonicDestroyStream(stream);
            stream = nullptr;
        }
    }

    /**
     * Write floating-point audio samples to the stream.
     * @param input_buffer Float32Array containing samples in range (-1.0, 1.0)
     * @param sample_count Number of samples to write (per channel)
     * @return Number of samples actually written
     */
    int writeFloatToStream(const emscripten::val& input_buffer, int sample_count) {
        auto data = jsArrayToFloatVector(input_buffer);
        if (data.empty()) {
            return 0;
        }
        return sonicWriteFloatToStream(stream, data.data(), sample_count);
    }

    /**
     * Zero-copy write floating-point audio samples to the stream.
     * @param input_ptr Pointer to float array in WASM memory
     * @param sample_count Number of samples to write (per channel)
     * @return Number of samples actually written
     */
    int writeFloatToStreamPtr(uintptr_t input_ptr, int sample_count) {
        const float* data = reinterpret_cast<const float*>(input_ptr);
        return sonicWriteFloatToStream(stream, data, sample_count);
    }

    /**
     * Read floating-point audio samples from the stream.
     * @param buffer_size Maximum number of samples to read (per channel)
     * @return Float32Array with samples, or undefined if no data available
     */
    emscripten::val readFloatFromStream(int buffer_size) {
        // Allocate buffer for output (account for channels)
        std::vector<float> output(buffer_size * numChannels);

        int samples_read = sonicReadFloatFromStream(stream, output.data(), buffer_size);

        if (samples_read <= 0) {
            return emscripten::val::undefined();
        }

        // Resize to actual samples read
        output.resize(samples_read * numChannels);

        return floatVectorToJsArray(output);
    }

    /**
     * Zero-copy read floating-point audio samples from the stream.
     * @param output_ptr Pointer to float array in WASM memory
     * @param buffer_size Maximum number of samples to read (per channel)
     * @return Number of samples actually read
     */
    int readFloatFromStreamPtr(uintptr_t output_ptr, int buffer_size) {
        float* data = reinterpret_cast<float*>(output_ptr);
        return sonicReadFloatFromStream(stream, data, buffer_size);
    }

    /**
     * Write 16-bit integer audio samples to the stream.
     * @param input_buffer Int16Array containing samples
     * @param sample_count Number of samples to write (per channel)
     * @return Number of samples actually written
     */
    int writeShortToStream(const emscripten::val& input_buffer, int sample_count) {
        auto data = jsArrayToInt16Vector(input_buffer);
        if (data.empty()) {
            return 0;
        }
        return sonicWriteShortToStream(stream, data.data(), sample_count);
    }

    /**
     * Read 16-bit integer audio samples from the stream.
     * @param buffer_size Maximum number of samples to read (per channel)
     * @return Int16Array with samples, or undefined if no data available
     */
    emscripten::val readShortFromStream(int buffer_size) {
        std::vector<int16_t> output(buffer_size * numChannels);

        int samples_read = sonicReadShortFromStream(stream, output.data(), buffer_size);

        if (samples_read <= 0) {
            return emscripten::val::undefined();
        }

        output.resize(samples_read * numChannels);

        return int16VectorToJsArray(output);
    }

    /**
     * Flush any remaining samples from the stream.
     * Call this after all input has been written to get remaining output.
     * @return Number of samples flushed
     */
    int flushStream() {
        return sonicFlushStream(stream);
    }

    /**
     * Set the playback speed.
     * Values > 1.0 speed up, values < 1.0 slow down.
     * @param rate Speed multiplier (e.g., 2.0 = double speed)
     */
    void setSpeed(float rate) {
        sonicSetSpeed(stream, rate);
    }

    /**
     * Get the current playback speed.
     * @return Speed multiplier
     */
    float getSpeed() {
        return sonicGetSpeed(stream);
    }

    /**
     * Set the sample rate for pitch shifting.
     * This is independent of speed and affects pitch.
     * @param rate Sample rate multiplier
     */
    void setRate(float rate) {
        sonicSetRate(stream, rate);
    }

    /**
     * Enable nonlinear speedup (Speedy algorithm).
     * @param nonlinear_factor Nonlinear factor (0.0 = linear, 1.0 = full Speedy)
     */
    void enableNonlinearSpeedup(float nonlinear_factor) {
        sonicEnableNonlinearSpeedup(stream, nonlinear_factor);
    }

    /**
     * Set the duration feedback strength.
     * Controls how much the duration error affects the speed adjustment.
     * @param factor Feedback strength (0.0 to 0.5, recommended 0.1)
     */
    void setDurationFeedbackStrength(float factor) {
        sonicSetDurationFeedbackStrength(stream, factor);
    }

    void setSpeedyPreemphasisFactor(float factor) {
        sonicSetSpeedyPreemphasisFactor(stream, factor);
    }

    void setSpeedyLowEnergyThresholdScale(float scale) {
        sonicSetSpeedyLowEnergyThresholdScale(stream, scale);
    }

    void setSpeedyBinThresholdDivisor(float divisor) {
        sonicSetSpeedyBinThresholdDivisor(stream, divisor);
    }

    void setSpeedyTensionWeights(float energy_weight, float speech_weight) {
        sonicSetSpeedyTensionWeights(stream, energy_weight, speech_weight);
    }

    void setSpeedyTensionOffsets(float energy_offset, float speech_offset) {
        sonicSetSpeedyTensionOffsets(stream, energy_offset, speech_offset);
    }

    void setSpeedySpeechChangeCapMultiplier(float multiplier) {
        sonicSetSpeedySpeechChangeCapMultiplier(stream, multiplier);
    }

    /**
     * Get the number of samples available to read.
     * @return Number of samples available (per channel)
     */
    int samplesAvailable() {
        return sonicSamplesAvailable(stream);
    }
    
    // --- Speed Profile Callback Support ---

    static void speedCallbackStatic(sonicStream stream, int time, float speed) {
        std::lock_guard<std::mutex> lock(streamMapMutex);
        auto it = streamMap.find(stream);
        if (it != streamMap.end()) {
            it->second->recordSpeed(time, speed);
        }
    }

    void recordSpeed(int time, float speed) {
        // time is frame index. We return (time, speed) pairs flat.
        speedProfile.push_back(static_cast<float>(time));
        speedProfile.push_back(speed);
    }

    void setupSpeedCallback() {
        sonicSpeedCallback(stream, speedCallbackStatic);
    }

    /**
     * Get the accumulated speed profile and clear the buffer.
     * Returns a Float32Array where [i] = time (frame index), [i+1] = speed.
     */
    emscripten::val getSpeedProfile() {
        if (speedProfile.empty()) {
            return emscripten::val::undefined();
        }

        emscripten::val result = floatVectorToJsArray(speedProfile);
        speedProfile.clear();
        return result;
    }

    /**
     * Get Speedy frame rate (100 Hz).
     * @return Frame rate in Hz
     */
    float getSpeedyFrameRate() {
        return 100.0f;  // kFrameRateHz
    }

    /**
     * Get Speedy preemphasis filter coefficient.
     * @return Preemphasis coefficient (0.97)
     */
    float getSpeedyPreemphasisCoefficient() {
        return 0.97f;
    }

    /**
     * Get Speedy temporal hysteresis future frame count.
     * @return Number of future frames for hysteresis
     */
    int getSpeedyTemporalHysteresisFuture() {
#ifdef MATCH_MATLAB
        return 8;  // kTemporalHysteresisFuture
#else
        return 12;  // kTemporalHysteresisFuture
#endif
    }

    // Prevent copying
    SonicStreamWrapper(const SonicStreamWrapper&) = delete;
    SonicStreamWrapper& operator=(const SonicStreamWrapper&) = delete;
};

// ============================================================================
// Emscripten Bindings
// ============================================================================

/**
 * Main binding block that exposes C++ classes to JavaScript.
 *
 * Usage in JavaScript (ES6 module):
 * ```javascript
 * import { SpeedyStream, SonicStream } from './speedy.js';
 *
 * const speedy = new SpeedyStream(22050);
 * const sonic = new SonicStream(22050, 1);
 * sonic.setSpeed(2.0);
 * sonic.enableNonlinearSpeedup(1.0);
 * ```
 *
 * Usage in JavaScript (UMD/global):
 * ```html
 * <script src="speedy.umd.js"></script>
 * <script>
 *     const { SpeedyStream, SonicStream } = SpeedyWasm;
 *     const speedy = new SpeedyStream(22050);
 * </script>
 * ```
 */
EMSCRIPTEN_BINDINGS(speedy_module) {
    // Bind SpeedyStreamWrapper as SpeedyStream
    emscripten::class_<SpeedyStreamWrapper>("SpeedyStream")
        .constructor<int>()
        .function("inputFrameSize", &SpeedyStreamWrapper::inputFrameSize)
        .function("inputFrameStep", &SpeedyStreamWrapper::inputFrameStep)
        .function("addData", &SpeedyStreamWrapper::addData)
        .function("addDataPtr", &SpeedyStreamWrapper::addDataPtr, emscripten::allow_raw_pointers())
        .function("addDataShort", &SpeedyStreamWrapper::addDataShort)
        .function("computeTension", &SpeedyStreamWrapper::computeTension)
        .function("computeSpeedFromTension", &SpeedyStreamWrapper::computeSpeedFromTension)
        .function("getCurrentTime", &SpeedyStreamWrapper::getCurrentTime)
        .function("fftSize", &SpeedyStreamWrapper::fftSize)
        .function("frameRate", &SpeedyStreamWrapper::frameRate)
        .function("preemphasisCoefficient", &SpeedyStreamWrapper::preemphasisCoefficient)
        .function("temporalHysteresisFuture", &SpeedyStreamWrapper::temporalHysteresisFuture)
        .function("temporalHysteresisPast", &SpeedyStreamWrapper::temporalHysteresisPast)
        .function("setPreemphasisFactor", &SpeedyStreamWrapper::setPreemphasisFactor)
        .function("setLowEnergyThresholdScale", &SpeedyStreamWrapper::setLowEnergyThresholdScale)
        .function("setBinThresholdDivisor", &SpeedyStreamWrapper::setBinThresholdDivisor)
        .function("setTensionWeights", &SpeedyStreamWrapper::setTensionWeights)
        .function("setTensionOffsets", &SpeedyStreamWrapper::setTensionOffsets)
        .function("setSpeechChangeCapMultiplier", &SpeedyStreamWrapper::setSpeechChangeCapMultiplier)
        ;

    // Bind SonicStreamWrapper as SonicStream
    emscripten::class_<SonicStreamWrapper>("SonicStream")
        .constructor<int, int>()
        .function("writeFloatToStream", &SonicStreamWrapper::writeFloatToStream)
        .function("writeFloatToStreamPtr", &SonicStreamWrapper::writeFloatToStreamPtr, emscripten::allow_raw_pointers())
        .function("readFloatFromStream", &SonicStreamWrapper::readFloatFromStream)
        .function("readFloatFromStreamPtr", &SonicStreamWrapper::readFloatFromStreamPtr, emscripten::allow_raw_pointers())
        .function("writeShortToStream", &SonicStreamWrapper::writeShortToStream)
        .function("readShortFromStream", &SonicStreamWrapper::readShortFromStream)
        .function("flushStream", &SonicStreamWrapper::flushStream)
        .function("setSpeed", &SonicStreamWrapper::setSpeed)
        .function("getSpeed", &SonicStreamWrapper::getSpeed)
        .function("setRate", &SonicStreamWrapper::setRate)
        .function("enableNonlinearSpeedup", &SonicStreamWrapper::enableNonlinearSpeedup)
        .function("setDurationFeedbackStrength", &SonicStreamWrapper::setDurationFeedbackStrength)
        .function("setSpeedyPreemphasisFactor", &SonicStreamWrapper::setSpeedyPreemphasisFactor)
        .function("setSpeedyLowEnergyThresholdScale", &SonicStreamWrapper::setSpeedyLowEnergyThresholdScale)
        .function("setSpeedyBinThresholdDivisor", &SonicStreamWrapper::setSpeedyBinThresholdDivisor)
        .function("setSpeedyTensionWeights", &SonicStreamWrapper::setSpeedyTensionWeights)
        .function("setSpeedyTensionOffsets", &SonicStreamWrapper::setSpeedyTensionOffsets)
        .function("setSpeedySpeechChangeCapMultiplier", &SonicStreamWrapper::setSpeedySpeechChangeCapMultiplier)
        .function("samplesAvailable", &SonicStreamWrapper::samplesAvailable)
        .function("setupSpeedCallback", &SonicStreamWrapper::setupSpeedCallback)
        .function("getSpeedProfile", &SonicStreamWrapper::getSpeedProfile)
        .function("getSpeedyFrameRate", &SonicStreamWrapper::getSpeedyFrameRate)
        .function("getSpeedyPreemphasisCoefficient", &SonicStreamWrapper::getSpeedyPreemphasisCoefficient)
        .function("getSpeedyTemporalHysteresisFuture", &SonicStreamWrapper::getSpeedyTemporalHysteresisFuture)
        ;

    // Register std::vector types for return values
    emscripten::register_vector<float>("VectorFloat");
    emscripten::register_vector<int16_t>("VectorInt16");
}
