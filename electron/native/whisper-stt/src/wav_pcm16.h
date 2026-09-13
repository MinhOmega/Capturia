#pragma once

// Minimal WAV reader: PCM16, any channel count, any sample rate. Fixtures
// (and the renderer's writeSamplesAsWav) are guaranteed PCM16 mono 16 kHz.
// ponytail: v1.9.1 of whisper.cpp dropped `examples/dr_wav.h` in favour of
// miniaudio, but pulling in the full miniaudio.h (4 MB header) just to read
// a 16 kHz mono PCM16 stream would be silly. The format is dead simple; this
// parser is the same one the POC harness shipped.
//
// It lives in its own header so it can be compiled without whisper.h, httplib
// and ggml — the header the /inference handler needs, and the reason there was
// no test for the one piece of this server that parses untrusted bytes:
//
//   g++ -std=c++20 -O2 -Wall -Wextra -o /tmp/wav_pcm16_test
//     electron/native/whisper-stt/src/wav_pcm16_test.cpp && /tmp/wav_pcm16_test

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

inline void log(const std::string& msg) {
	std::cerr << "[whisper-stt] " << msg << std::endl;
	std::cerr.flush();
}

// Every field below is attacker-shaped: the WAV comes in over the wire as a
// multipart upload, so the header says whatever the sender wants. `channels`
// reaching the divisor unchecked was a SIGFPE that killed the server for the
// rest of its life (every later caption call then failed until the Node side
// noticed and respawned it), and `chunk_size` reaching `resize()` unchecked was
// a 2 GB allocation a 44-byte file could ask for.
inline bool read_wav_pcm16(const std::string& path, std::vector<float>& pcm,
                           int& sample_rate_out, int& channels_out) {
	std::ifstream f(path, std::ios::binary);
	if (!f) { log("cannot open " + path); return false; }

	f.seekg(0, std::ios::end);
	const std::streamoff file_size = f.tellg();
	f.seekg(0, std::ios::beg);

	auto read_u32 = [&]()-> uint32_t {
		uint32_t v = 0; f.read(reinterpret_cast<char*>(&v), 4); return v;
	};
	auto read_u16 = [&]()-> uint16_t {
		uint16_t v = 0; f.read(reinterpret_cast<char*>(&v), 2); return v;
	};
	auto read_i16 = [&]()-> int16_t {
		int16_t v = 0; f.read(reinterpret_cast<char*>(&v), 2); return v;
	};

	char tag[4];
	f.read(tag, 4);
	if (f.gcount() != 4 || std::memcmp(tag, "RIFF", 4) != 0) { log("not RIFF"); return false; }
	(void)read_u32();
	f.read(tag, 4);
	if (std::memcmp(tag, "WAVE", 4) != 0) { log("not WAVE"); return false; }

	uint16_t fmt_format = 0, fmt_channels = 0, fmt_bits = 0;
	uint32_t fmt_sample_rate = 0;
	bool got_fmt = false;

	while (f) {
		char chunk_tag[4];
		f.read(chunk_tag, 4);
		if (f.gcount() != 4) break;
		const uint32_t chunk_size = read_u32();
		if (std::memcmp(chunk_tag, "fmt ", 4) == 0) {
			// Shorter than the PCM fmt body it is about to be read as, so
			// `chunk_size - 16` would wrap and seek the file to nowhere.
			if (chunk_size < 16) { log("fmt chunk too short"); return false; }
			fmt_format      = read_u16();
			fmt_channels    = read_u16();
			fmt_sample_rate = read_u32();
			(void)read_u32();
			(void)read_u16();
			fmt_bits        = read_u16();
			const uint32_t fmt_extra = chunk_size - 16;
			if (fmt_extra) f.seekg(fmt_extra, std::ios::cur);
			got_fmt = true;
		} else if (std::memcmp(chunk_tag, "data", 4) == 0) {
			// 8 is arbitrary but generous: the contract is mono, and no capture
			// device this helper is fed from is beyond 7.1.
			if (!got_fmt || fmt_format != 1 || fmt_bits != 16 ||
			    fmt_channels == 0 || fmt_channels > 8 || fmt_sample_rate == 0) {
				log("expected PCM16, got format=" + std::to_string(fmt_format) +
				    " bits=" + std::to_string(fmt_bits) +
				    " channels=" + std::to_string(fmt_channels) +
				    " rate=" + std::to_string(fmt_sample_rate));
				return false;
			}
			sample_rate_out = static_cast<int>(fmt_sample_rate);
			channels_out    = fmt_channels;
			// The header's claim is a maximum, not a size: a `data` chunk may
			// say 2 GB in a 44-byte file, and `resize()` would believe it.
			const std::streamoff here = f.tellg();
			const uint64_t available =
				here < 0 || here >= file_size ? 0 : static_cast<uint64_t>(file_size - here);
			const uint64_t usable = std::min<uint64_t>(chunk_size, available);
			const size_t frames = static_cast<size_t>(usable / 2 / fmt_channels);
			pcm.assign(frames, 0.0f);
			if (fmt_channels == 1) {
				for (size_t i = 0; i < frames; ++i) pcm[i] = static_cast<float>(read_i16()) / 32768.0f;
			} else {
				// PCM is interleaved: every channel of frame 0, then every
				// channel of frame 1. Reading channel-major instead walked the
				// file once per channel from where the last pass stopped, so a
				// stereo file summed its first half onto its second — the frame
				// loop has to be the outer one.
				for (size_t i = 0; i < frames; ++i) {
					for (size_t ch = 0; ch < fmt_channels; ++ch) {
						pcm[i] += static_cast<float>(read_i16()) / 32768.0f;
					}
					pcm[i] /= static_cast<float>(fmt_channels);
				}
			}
			return true;
		} else {
			f.seekg(chunk_size + (chunk_size & 1), std::ios::cur);
		}
	}
	log("data chunk not found in " + path);
	return false;
}
