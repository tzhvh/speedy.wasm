# Simple makefile to build the speedy library.
# Dependencies are expected in the deps/ directory.
#
# Prerequisites:
#   sudo apt-get install libfftw3-dev libgmock-dev libgtest-dev libglog-dev

SONIC_DIR=deps/sonic
KISS_DIR=deps/kissfft

CC=gcc
CPLUSPLUS=g++
CFLAGS=-g -DFFTW -fPIC -I$(SONIC_DIR) -L$(SONIC_DIR)

all: deps libspeedy.so speedy_wave wasm-all wasm-gh-pages

deps:
	$(MAKE) -C $(SONIC_DIR)

speedy_wave: speedy_wave.cc libspeedy.so $(SONIC_DIR)/libsonic_internal.so
	$(CPLUSPLUS) $(CFLAGS) speedy_wave.cc libspeedy.so $(SONIC_DIR)/libsonic_internal.so -lc -lfftw3 -o speedy_wave

libspeedy.so: soniclib.o speedy.o
	$(CC) -shared soniclib.o speedy.o -o libspeedy.so

soniclib.o: sonic2.h speedy.h

speedy.o: speedy.h

clean:
	rm -f *.o *.so speedy_wave soniclib.o libspeedy.so
	rm -f kiss_fft_test dynamic_time_warping_test sonic_classic_test sonic_test speedy_test

# For the tests that follow, you will probably need to set your LD_LIBRARY_PATH
# to point to the library locations.  For example:
#	export LD_LIBRARY_PATH=/usr/local/lib:deps/kissfft:deps/sonic

test: kiss_fft_test dynamic_time_warping_test sonic_classic_test sonic_test speedy_test

# === WebAssembly / Emscripten Targets ===
# These delegate to Makefile.emscripten for building WASM modules
WASM_TARGETS = es6 umd wasm-all wasm-clean wasm-public wasm-gh-pages wasm-gh-pages-deploy wasm-deps

.PHONY: $(WASM_TARGETS)

$(WASM_TARGETS):
	$(MAKE) -f Makefile.emscripten $(subst wasm-,,$@)

# Convenience aliases
wasm-all: es6 umd
wasm-clean: clean
wasm-deps: deps
gh-pages: wasm-gh-pages
gh-pages-deploy: wasm-gh-pages-deploy

kiss_fft_test: kiss_fft_test.cc
	g++ -DKISS_FFT -I$(KISS_DIR) kiss_fft_test.cc $(KISS_DIR)/libkissfft-float.so \
		-o kiss_fft_test -lgtest -DMATCH_MATLAB
	./kiss_fft_test

dynamic_time_warping_test: dynamic_time_warping_test.cc
	g++ dynamic_time_warping_test.cc dynamic_time_warping.cc -lgtest -lglog \
	  -o dynamic_time_warping_test -DMATCH_MATLAB
	./dynamic_time_warping_test

sonic_classic_test: sonic_classic_test.cc
	g++ sonic_classic_test.cc \
	  $(SONIC_DIR)/libsonic.so -lgtest -lglog -I$(SONIC_DIR) \
	  -DMATCH_MATLAB  \
	  -DKISS_FFT -I$(KISS_DIR) $(KISS_DIR)/libkissfft-float.so  \
	  -o sonic_classic_test
	./sonic_classic_test

sonic_test: sonic_test.cc
	g++ sonic_test.cc speedy.c soniclib.c dynamic_time_warping.cc \
	  $(SONIC_DIR)/libsonic_internal.so -lgtest -lglog -I$(SONIC_DIR) -DMATCH_MATLAB \
	  $(KISS_DIR)/libkissfft-float.so -DKISS_FFT -I$(KISS_DIR)  \
		-o sonic_test
	./sonic_test

speedy_test: speedy_test.cc
	 g++ speedy_test.cc speedy.c soniclib.c dynamic_time_warping.cc \
	   $(SONIC_DIR)/libsonic_internal.so -lgtest -lglog -I$(SONIC_DIR) -DMATCH_MATLAB \
	   -I$(KISS_DIR) $(KISS_DIR)/libkissfft-float.so -DKISS_FFT \
	   -o speedy_test
	 ./speedy_test

# Prerequisites (in deps/):
#   git clone https://github.com/mborgerding/kissfft.git deps/kissfft
#   git clone --recursive https://github.com/waywardgeek/sonic.git deps/sonic
#   sudo apt-get install libfftw3-dev libgmock-dev libgtest-dev libglog-dev
