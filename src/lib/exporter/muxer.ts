import type { ExportConfig } from './types';
import { EXPORT_AUDIO_BITRATE, type ExportAudioCodec } from './audioCodecSelection';
import { 
  Output, 
  Mp4OutputFormat, 
  BufferTarget, 
  EncodedVideoPacketSource, 
  EncodedAudioPacketSource,
  AudioBufferSource,
  EncodedPacket 
} from 'mediabunny';

export class VideoMuxer {
  private output: Output | null = null;
  private videoSource: EncodedVideoPacketSource | null = null;
  private audioSource: EncodedAudioPacketSource | AudioBufferSource | null = null;
  private hasAudio: boolean;
  private readonly audioCodec: ExportAudioCodec;
  private target: BufferTarget | null = null;
  private config: ExportConfig;

  /**
   * @param audioCodec MP4 audio codec for the PCM (`AudioBufferSource`) track.
   *   AAC by default; Opus when the AAC encoder is unavailable (see
   *   `selectExportAudioCodec`). mediabunny writes Opus-in-MP4 (`dOps`).
   */
  constructor(config: ExportConfig, hasAudio = false, audioCodec: ExportAudioCodec = 'aac') {
    this.config = config;
    this.hasAudio = hasAudio;
    this.audioCodec = audioCodec;
  }

  getAudioCodec(): ExportAudioCodec {
    return this.audioCodec;
  }

  async initialize(): Promise<void> {
    // Create the buffer target
    this.target = new BufferTarget();
    
    this.output = new Output({
      format: new Mp4OutputFormat({
        fastStart: 'in-memory',
      }),
      target: this.target,
    });

    // Create video source - codec will be deduced from metadata
    this.videoSource = new EncodedVideoPacketSource('avc');
    this.output.addVideoTrack(this.videoSource, {
      frameRate: this.config.frameRate,
    });

    // Create audio source if needed
    if (this.hasAudio) {
      this.audioSource = new AudioBufferSource({
        // MP4 container requires an ISO BMFF-compatible audio codec (AAC or Opus).
        codec: this.audioCodec,
        bitrate: EXPORT_AUDIO_BITRATE,
      });
      this.output.addAudioTrack(this.audioSource);
    }

    // Start the output to begin accepting media data
    await this.output.start();
  }

  async addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): Promise<void> {
    if (!this.videoSource) {
      throw new Error('Muxer not initialized');
    }
    
    // Convert WebCodecs chunk to Mediabunny packet
    const packet = EncodedPacket.fromEncodedChunk(chunk);
    
    // Add metadata with the first chunk
    await this.videoSource.add(packet, meta);
  }

  async addAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): Promise<void> {
    if (!(this.audioSource instanceof EncodedAudioPacketSource)) {
      throw new Error('Audio not configured for this muxer');
    }
    
    // Convert WebCodecs chunk to Mediabunny packet
    const packet = EncodedPacket.fromEncodedChunk(chunk);
    
    // Add metadata with the first chunk
    await this.audioSource.add(packet, meta);
  }

  async addAudioBuffer(buffer: AudioBuffer): Promise<void> {
    if (!(this.audioSource instanceof AudioBufferSource)) {
      throw new Error('PCM audio input is not configured for this muxer');
    }

    await this.audioSource.add(buffer);
  }

  async finalize(): Promise<Blob> {
    if (!this.output || !this.target) {
      throw new Error('Muxer not initialized');
    }
    
    await this.output.finalize();
    const buffer = this.target.buffer;
    
    if (!buffer) {
      throw new Error('Failed to finalize output');
    }
    
    return new Blob([buffer], { type: 'video/mp4' });
  }
}
