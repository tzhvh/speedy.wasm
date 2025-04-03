# Simple makefile to build the speedy library (native and WASM).

# --- Native Build Configuration ---
SONIC_DIR_NATIVE=../sonic  # Original assumption for native test build if needed
KISS_DIR_NATIVE=../kissfft # Original assumption for native test build if needed
FFTW_DIR=../fftw           # Original assumption for native test build if needed

CC=gcc
CPLUSPLUS=g++
CFLAGS_NATIVE=-g -fPIC -I$(SONIC_DIR_NATIVE) -L$(SONIC_DIR_NATIVE)
CFLAGS_FFTW=$(CFLAGS_NATIVE) -DFFTW -I$(FFTW_DIR) -lfftw3
CFLAGS_KISSFFT=$(CFLAGS_NATIVE) -DKISS_FFT -I$(KISS_DIR_NATIVE) $(KISS_DIR_NATIVE)/libkissfft-float.so

# --- WASM Build Configuration ---
EMCC=emcc
EMPP=em++
SONIC_DIR_WASM=deps/sonic
KISS_DIR_WASM=deps/kissfft
WASM_BUILD_DIR=wasm_build
WASM_OUTPUT_DIR=dist
WASM_TARGET=$(WASM_OUTPUT_DIR)/speedy
JS_TARGET=$(WASM_TARGET).js
WASM_FILE=$(WASM_TARGET).wasm

# WASM Flags
EM_FLAGS = -O3 -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 -s ALLOW_MEMORY_GROWTH=1
EM_FLAGS += -s "EXPORTED_RUNTIME_METHODS=[\"cwrap\",\"FS\",\"HEAPF32\",\"_malloc\",\"_free\"]"
EM_FLAGS += -s "EXPORTED_FUNCTIONS=[\"_sonicIntCreateStream\",\"_sonicIntDestroyStream\",\"_sonicIntWriteFloatToStream\",\"_sonicIntReadFloatFromStream\",\"_sonicIntFlushStream\",\"_sonicIntSetSpeed\",\"_sonicEnableNonlinearSpeedup\",\"_sonicSetDurationFeedbackStrength\",\"_sonicIntSamplesAvailable\",\"_testFunctionReferences\",\"_malloc\",\"_free\"]"
EM_FLAGS += -DKISS_FFT -I$(SONIC_DIR_WASM) -I$(KISS_DIR_WASM) -fPIC
EM_FLAGS += -DNDEBUG -DCHECK\(x\)=\(\(void\)0\) -DCHECK_EQ\(a,b\)=\(\(void\)0\) -DCHECK_NE\(a,b\)=\(\(void\)0\) -DLOG\(x\)=std::cerr
EM_FLAGS += -sASSERTIONS#debug flag for now

# List of source files needed for the core library
SPEEDY_CORE_SOURCES = speedy.c dynamic_time_warping.cc wasm_exports.c
SPEEDY_CORE_OBJECTS_WASM = $(patsubst %.c,$(WASM_BUILD_DIR)/%.o,$(filter %.c,$(SPEEDY_CORE_SOURCES))) \
                           $(patsubst %.cc,$(WASM_BUILD_DIR)/%.o,$(filter %.cc,$(SPEEDY_CORE_SOURCES)))

# Add sonic library sources needed (from submodule)
SONIC_LIB_SOURCES = $(SONIC_DIR_WASM)/sonic.c
SONIC_LIB_OBJECTS_WASM = $(WASM_BUILD_DIR)/soniclib.o # Changed name to soniclib.o

# KissFFT sources needed (from submodule)
KISSFFT_SOURCES = $(KISS_DIR_WASM)/kiss_fft.c $(KISS_DIR_WASM)/kiss_fftr.c
KISSFFT_OBJECTS_WASM = $(WASM_BUILD_DIR)/kissfft_kiss_fft.o $(WASM_BUILD_DIR)/kissfft_kiss_fftr.o

# --- Targets ---

.PHONY: all clean test wasm wasm_deps

all: libspeedy.so speedy_wave test
	@echo "Native build complete. Run 'make wasm' for WebAssembly."

# --- WASM Target ---
wasm: wasm_deps $(JS_TARGET)

wasm_deps:
	@echo "Ensuring WASM build directories exist..."
	@mkdir -p $(WASM_BUILD_DIR)
	@mkdir -p $(WASM_OUTPUT_DIR)
	@echo "Building KissFFT for WASM..."
	$(EMCC) $(EM_FLAGS) -c $(KISSFFT_SOURCES)
	@mv *.o $(WASM_BUILD_DIR)/
	@# Rename kissfft objects to avoid clashes if needed
	@cd $(WASM_BUILD_DIR) && for f in kiss_*.o; do mv "$$f" "kissfft_$$f"; done

$(JS_TARGET): $(SPEEDY_CORE_OBJECTS_WASM) $(SONIC_LIB_OBJECTS_WASM) $(KISSFFT_OBJECTS_WASM)
	@echo "Linking WASM module..."
	$(EMPP) $(EM_FLAGS) $^ -o $@
	@echo "WASM build complete: $(JS_TARGET) and $(WASM_FILE)"
	@cp $(JS_TARGET) demo/speedy.js
	@echo "Copied $(JS_TARGET) to demo/speedy.js"

# Compile WASM objects
# Disable optimizations for soniclib.c to ensure all symbols are included
$(WASM_BUILD_DIR)/soniclib.o: $(SONIC_DIR_WASM)/sonic.c speedy.h sonic2.h $(SONIC_DIR_WASM)/sonic.h
	$(EMCC) -O0 $(EM_FLAGS) -DSONIC_INTERNAL -c $< -o $@

$(WASM_BUILD_DIR)/%.o: %.c speedy.h sonic2.h $(SONIC_DIR_WASM)/sonic.h dynamic_time_warping.h
	$(EMCC) $(EM_FLAGS) -c $< -o $@

$(WASM_BUILD_DIR)/%.o: %.cc speedy.h sonic2.h $(SONIC_DIR_WASM)/sonic.h dynamic_time_warping.h dynamic_time_warping.cc
	$(EMPP) $(EM_FLAGS) -c $< -o $@

# --- Native Targets ---

# For native build, assume sonic and kissfft are compiled separately in parallel dirs
# Or adjust paths to use deps/sonic and deps/kissfft if preferred for native too
# The original makefile is kept below for reference/potential native building

speedy_wave: speedy_wave.cc libspeedy.so # $(SONIC_DIR_NATIVE)/libsonic_internal.so
	$(CPLUSPLUS) $(CFLAGS_FFTW) speedy_wave.cc libspeedy.so -lc -o speedy_wave # -lsonic # Assuming libsonic linked into libspeedy or available

libspeedy.so: soniclib.o speedy.o dynamic_time_warping.o
	$(CC) -shared soniclib.o speedy.o dynamic_time_warping.o -o libspeedy.so

# Object file compilation rules for native build
soniclib.o: soniclib.c sonic2.h speedy.h $(SONIC_DIR_NATIVE)/sonic.h
	$(CC) $(CFLAGS_NATIVE) -I$(SONIC_DIR_NATIVE) -c soniclib.c

speedy.o: speedy.c speedy.h $(KISS_DIR_NATIVE)/kiss_fft.h
	$(CC) $(CFLAGS_NATIVE) -DKISS_FFT -I$(KISS_DIR_NATIVE) -c speedy.c

dynamic_time_warping.o: dynamic_time_warping.cc dynamic_time_warping.h
	$(CPLUSPLUS) $(CFLAGS_NATIVE) -c dynamic_time_warping.cc -o dynamic_time_warping.o # Requires C++ compiler

# Native tests (require gtest/glog, not built here for simplicity)
test:
	@echo "Native tests require gtest/glog setup and libraries."
	@echo "Original test targets commented out for WASM focus."
# kiss_fft_test: kiss_fft_test.cc
#	g++ -DKISS_FFT -I../kissfft kiss_fft_test.cc ../kissfft/libkissfft-float.so \
#		-o kiss_fft_test -lgtest -DMATCH_MATLAB
#	./kiss_fft_test
# ... other native tests ...

clean:
	rm -f *.o *.so speedy_wave soniclib.o libspeedy.so
	rm -f kiss_fft_test dynamic_time_warping_test sonic_classic_test sonic_test speedy_test
	rm -rf $(WASM_BUILD_DIR) $(WASM_OUTPUT_DIR)
	@echo "Cleaned native and WASM build artifacts."

# Help target
help:
	@echo "Available targets:"
	@echo "  all           Build native library and executable (if possible)"
	@echo "  wasm          Build WebAssembly module (speedy.js, speedy.wasm)"
	@echo "  test          Placeholder for running native tests (requires setup)"
	@echo "  clean         Remove build artifacts"
	@echo "  help          Show this help message"
