// Tests for the WAV header parser the /inference handler feeds untrusted
// uploads to. Standalone on purpose: nothing here needs whisper.h, ggml or
// httplib, so it builds and runs in a second on any host, including the Linux
// and macOS boxes that cannot build the server itself.
//
//   g++ -std=c++20 -O2 -Wall -Wextra -o /tmp/wav_pcm16_test
//     electron/native/whisper-stt/src/wav_pcm16_test.cpp && /tmp/wav_pcm16_test
//
// Exit code is the number of failures.

#include "wav_pcm16.h"

#include <cstdio>
#include <filesystem>
#include <vector>

namespace {

int g_ran = 0;
int g_failed = 0;

void expect(const char* name, bool ok, const std::string& detail = "") {
	g_ran += 1;
	if (ok) {
		std::cout << "PASS " << name << "\n";
		return;
	}
	g_failed += 1;
	std::cout << "FAIL " << name << " " << detail << "\n";
}

void put_u32(std::vector<char>& out, uint32_t v) {
	for (int i = 0; i < 4; ++i) out.push_back(static_cast<char>((v >> (8 * i)) & 0xff));
}
void put_u16(std::vector<char>& out, uint16_t v) {
	for (int i = 0; i < 2; ++i) out.push_back(static_cast<char>((v >> (8 * i)) & 0xff));
}
void put_tag(std::vector<char>& out, const char* tag) {
	out.insert(out.end(), tag, tag + 4);
}

// A 44-byte canonical PCM16 header, with every field the caller's to lie about,
// followed by `samples` as-is. `data_size` is what the header CLAIMS, which is
// not necessarily what follows it.
std::vector<char> wav(uint16_t channels, uint32_t sample_rate, uint16_t bits,
                      uint32_t data_size, const std::vector<int16_t>& samples,
                      uint32_t fmt_size = 16) {
	std::vector<char> out;
	put_tag(out, "RIFF");
	put_u32(out, 0);
	put_tag(out, "WAVE");
	put_tag(out, "fmt ");
	put_u32(out, fmt_size);
	put_u16(out, 1);  // WAVE_FORMAT_PCM
	put_u16(out, channels);
	put_u32(out, sample_rate);
	put_u32(out, sample_rate * channels * (bits / 8));
	put_u16(out, static_cast<uint16_t>(channels * (bits / 8)));
	put_u16(out, bits);
	put_tag(out, "data");
	put_u32(out, data_size);
	for (const int16_t s : samples) put_u16(out, static_cast<uint16_t>(s));
	return out;
}

std::string write_temp(const std::vector<char>& bytes, const char* name) {
	const std::string path = (std::filesystem::temp_directory_path() / name).string();
	std::ofstream f(path, std::ios::binary | std::ios::trunc);
	f.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
	f.close();
	return path;
}

bool read(const std::vector<char>& bytes, const char* name, std::vector<float>& pcm,
          int& rate, int& channels) {
	const std::string path = write_temp(bytes, name);
	pcm.clear();
	rate = -1;
	channels = -1;
	const bool ok = read_wav_pcm16(path, pcm, rate, channels);
	std::filesystem::remove(path);
	return ok;
}

}  // namespace

int main() {
	std::vector<float> pcm;
	int rate = 0;
	int channels = 0;

	// The upload says zero channels. `chunk_size / 2 / channels` divides by it
	// — an integer division by zero, i.e. SIGFPE, and the server is a long-lived
	// singleton, so it does not come back until the Node side notices.
	expect(
		"channels-zero-is-rejected-not-divided-by",
		!read(wav(0, 16000, 16, 0, {}), "wav-pcm16-ch0.wav", pcm, rate, channels));

	// 7.1 is the most any capture device here produces; past that the header is
	// lying and `frames * channels` reads are not worth attempting.
	expect(
		"channels-above-eight-is-rejected",
		!read(wav(9, 16000, 16, 18, {1, 2, 3, 4, 5, 6, 7, 8, 9}), "wav-pcm16-ch9.wav",
		      pcm, rate, channels));

	expect(
		"sample-rate-zero-is-rejected",
		!read(wav(1, 0, 16, 4, {1, 2}), "wav-pcm16-rate0.wav", pcm, rate, channels));

	// `chunk_size - 16` on a fmt chunk shorter than 16 wraps to ~4 G and seeks
	// the stream off the end of the file.
	expect(
		"short-fmt-chunk-is-rejected",
		!read(wav(1, 16000, 16, 4, {1, 2}, /*fmt_size=*/8), "wav-pcm16-shortfmt.wav",
		      pcm, rate, channels));

	// A 44-byte file claiming a 2 GB data chunk. Unbounded, `resize(frames)`
	// takes the claim at face value: 1 Gi floats = 4 GB, and the server dies on
	// bad_alloc instead of rejecting an 8-byte lie.
	{
		const bool ok = read(
			wav(1, 16000, 16, 0x7fffffffu, {}), "wav-pcm16-overclaim.wav", pcm, rate, channels);
		expect(
			"frames-are-bounded-by-the-real-file-size", ok && pcm.empty(),
			"ok=" + std::to_string(ok) + " frames=" + std::to_string(pcm.size()));
	}
	{
		// Same lie, with four real frames behind it.
		const bool ok = read(
			wav(1, 16000, 16, 0x7fffffffu, {0, 16384, -16384, 32767}), "wav-pcm16-overclaim4.wav",
			pcm, rate, channels);
		expect(
			"frames-are-bounded-to-the-bytes-present", ok && pcm.size() == 4,
			"ok=" + std::to_string(ok) + " frames=" + std::to_string(pcm.size()));
	}

	// The shape the renderer actually uploads, so the guards above cannot pass
	// by rejecting everything.
	{
		const bool ok = read(
			wav(1, 16000, 16, 8, {0, 16384, -16384, 32767}), "wav-pcm16-mono.wav", pcm, rate,
			channels);
		const bool values = pcm.size() == 4 && pcm[0] == 0.0f && pcm[1] == 0.5f &&
		                    pcm[2] == -0.5f && pcm[3] > 0.99f;
		expect(
			"mono-16k-still-reads", ok && rate == 16000 && channels == 1 && values,
			"ok=" + std::to_string(ok) + " rate=" + std::to_string(rate) + " frames=" +
				std::to_string(pcm.size()));
	}

	std::cout << (g_failed == 0 ? "OK " : "FAILED ") << (g_ran - g_failed) << "/" << g_ran
	          << " checks\n";
	return g_failed;
}
