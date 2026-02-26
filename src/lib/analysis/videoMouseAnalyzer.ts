/**
 * Video-based mouse cursor analyzer.
 *
 * Detects cursor position from recorded video frames using frame differencing
 * when no native cursor tracking data is available (e.g., Wayland).
 *
 * Algorithm:
 * 1. Extract frames at ~8 FPS via offscreen <video> + <canvas>
 * 2. Compare consecutive frames pixel-by-pixel to build a diff mask
 * 3. Find connected clusters of changed pixels via flood-fill
 * 4. Identify the cursor as a small cluster (4-64 px), preferring nearest to previous position
 * 5. Detect click events when cursor pauses for >300 ms
 * 6. Build a CursorTrack with normalized 0-1 positions
 */

import type { CursorTrack, CursorSample, CursorTrackEvent } from '@/lib/cursor';

interface VideoMouseAnalyzerConfig {
  /** Analysis sample rate in FPS (default: 8) */
  sampleFps?: number;
  /** Maximum cursor size in analysis pixels (default: 64) */
  maxCursorSizePx?: number;
  /** Minimum cursor size in analysis pixels (default: 4) */
  minCursorSizePx?: number;
  /** Analysis canvas width — source is scaled to this (default: 640) */
  analysisWidth?: number;
  /** RGB diff threshold sum per pixel (default: 30) */
  diffThreshold?: number;
}

interface Cluster {
  cx: number;
  cy: number;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class VideoMouseAnalyzer {
  private config: Required<VideoMouseAnalyzerConfig>;
  private cancelled = false;

  constructor(config?: VideoMouseAnalyzerConfig) {
    this.config = {
      sampleFps: config?.sampleFps ?? 8,
      maxCursorSizePx: config?.maxCursorSizePx ?? 64,
      minCursorSizePx: config?.minCursorSizePx ?? 3,
      analysisWidth: config?.analysisWidth ?? 640,
      diffThreshold: config?.diffThreshold ?? 30,
    };
  }

  async analyze(
    videoUrl: string,
    duration: number,
    videoWidth: number,
    videoHeight: number,
    onProgress?: (pct: number) => void,
  ): Promise<CursorTrack | null> {
    this.cancelled = false;

    // Create offscreen video
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'auto';
    video.src = videoUrl;

    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('Failed to load video for analysis'));
      // Timeout after 15s
      setTimeout(() => reject(new Error('Video load timeout')), 15_000);
    });

    // Calculate analysis dimensions
    const scale = this.config.analysisWidth / videoWidth;
    const analysisHeight = Math.round(videoHeight * scale);
    const w = this.config.analysisWidth;
    const h = analysisHeight;

    // Create offscreen canvas
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    const timeStep = 1 / this.config.sampleFps;
    const totalFrames = Math.ceil(duration * this.config.sampleFps);

    const samples: CursorSample[] = [];
    let prevImageData: ImageData | null = null;
    let prevPos: { x: number; y: number } | null = null;

    for (let i = 0; i < totalFrames && !this.cancelled; i++) {
      const time = Math.min(i * timeStep, duration - 0.01);

      // Seek to frame
      await this.seekVideo(video, time);

      // Draw frame to canvas
      ctx.drawImage(video, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);

      if (prevImageData) {
        // Frame differencing
        const diffMask = this.computeDiffMask(prevImageData, imageData, w, h);

        // Find clusters
        const clusters = this.findClusters(diffMask, w, h);

        // Pick cursor cluster
        const cursor = this.pickCursorCluster(clusters, prevPos, w, h);

        if (cursor) {
          prevPos = { x: cursor.cx, y: cursor.cy };
          samples.push({
            timeMs: Math.round(time * 1000),
            x: cursor.cx / w,
            y: cursor.cy / h,
            visible: true,
          });
        } else if (prevPos) {
          // No cursor detected — keep last position
          samples.push({
            timeMs: Math.round(time * 1000),
            x: prevPos.x / w,
            y: prevPos.y / h,
            visible: true,
          });
        }
      }

      prevImageData = imageData;

      // Report progress
      if (onProgress && i % 4 === 0) {
        onProgress(Math.round(((i + 1) / totalFrames) * 100));
      }

      // Yield to main thread periodically
      if (i % 8 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    // Clean up
    video.pause();
    video.removeAttribute('src');
    video.load();

    if (this.cancelled || samples.length < 2) {
      return null;
    }

    // Detect click events
    const events = this.detectClicks(samples);

    onProgress?.(100);

    return {
      samples,
      events,
      source: 'synthetic',
      stats: {
        sampleCount: samples.length,
        clickCount: events.length,
      },
    };
  }

  cancel(): void {
    this.cancelled = true;
  }

  private async seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (Math.abs(video.currentTime - time) < 0.01) {
        resolve();
        return;
      }
      video.addEventListener('seeked', () => resolve(), { once: true });
      video.currentTime = time;
    });
  }

  private computeDiffMask(
    prev: ImageData,
    curr: ImageData,
    w: number,
    h: number,
  ): Uint8Array {
    const mask = new Uint8Array(w * h);
    const threshold = this.config.diffThreshold;
    const pd = prev.data;
    const cd = curr.data;

    for (let i = 0; i < w * h; i++) {
      const idx = i * 4;
      const dr = Math.abs(pd[idx] - cd[idx]);
      const dg = Math.abs(pd[idx + 1] - cd[idx + 1]);
      const db = Math.abs(pd[idx + 2] - cd[idx + 2]);
      if (dr + dg + db > threshold) {
        mask[i] = 1;
      }
    }

    return mask;
  }

  private findClusters(mask: Uint8Array, w: number, h: number): Cluster[] {
    const visited = new Uint8Array(w * h);
    const clusters: Cluster[] = [];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (mask[idx] === 0 || visited[idx] === 1) continue;

        // BFS flood fill
        const queue: number[] = [idx];
        visited[idx] = 1;
        let sumX = 0;
        let sumY = 0;
        let area = 0;
        let minX = x;
        let minY = y;
        let maxX = x;
        let maxY = y;

        while (queue.length > 0) {
          const ci = queue.pop()!;
          const cx = ci % w;
          const cy = (ci - cx) / w;
          sumX += cx;
          sumY += cy;
          area++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          // 4-connected neighbors
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
              const ni = ny * w + nx;
              if (mask[ni] === 1 && visited[ni] === 0) {
                visited[ni] = 1;
                queue.push(ni);
              }
            }
          }
        }

        clusters.push({
          cx: sumX / area,
          cy: sumY / area,
          area,
          minX,
          minY,
          maxX,
          maxY,
        });
      }
    }

    return clusters;
  }

  private pickCursorCluster(
    clusters: Cluster[],
    prevPos: { x: number; y: number } | null,
    frameW: number,
    frameH: number,
  ): Cluster | null {
    const { minCursorSizePx, maxCursorSizePx } = this.config;

    // Filter clusters by size
    const candidates = clusters.filter((c) => {
      const bboxW = c.maxX - c.minX + 1;
      const bboxH = c.maxY - c.minY + 1;
      return (
        c.area >= minCursorSizePx &&
        c.area <= maxCursorSizePx * maxCursorSizePx &&
        bboxW <= maxCursorSizePx &&
        bboxH <= maxCursorSizePx
      );
    });

    if (candidates.length === 0) return null;

    if (prevPos) {
      // Prefer nearest to previous position, within 30% of frame diagonal
      const maxDist = Math.sqrt(frameW * frameW + frameH * frameH) * 0.3;
      let best: Cluster | null = null;
      let bestDist = Infinity;

      for (const c of candidates) {
        const dist = Math.sqrt((c.cx - prevPos.x) ** 2 + (c.cy - prevPos.y) ** 2);
        if (dist < maxDist && dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }

      if (best) return best;
    }

    // No previous position — pick the smallest cluster
    candidates.sort((a, b) => a.area - b.area);
    return candidates[0];
  }

  private detectClicks(samples: CursorSample[]): CursorTrackEvent[] {
    const events: CursorTrackEvent[] = [];
    const PAUSE_THRESHOLD = 0.01; // 1% of normalized space
    const PAUSE_DURATION_MS = 300;

    let pauseStartIdx = 0;

    for (let i = 1; i < samples.length; i++) {
      const dx = Math.abs(samples[i].x - samples[pauseStartIdx].x);
      const dy = Math.abs(samples[i].y - samples[pauseStartIdx].y);
      const moved = Math.sqrt(dx * dx + dy * dy) > PAUSE_THRESHOLD;

      if (moved) {
        // Check if the pause was long enough for a click
        const pauseDuration = samples[i - 1].timeMs - samples[pauseStartIdx].timeMs;
        if (pauseDuration >= PAUSE_DURATION_MS) {
          const midIdx = Math.floor((pauseStartIdx + i - 1) / 2);
          events.push({
            type: 'click',
            startMs: samples[pauseStartIdx].timeMs,
            endMs: samples[i - 1].timeMs,
            point: {
              x: samples[midIdx].x,
              y: samples[midIdx].y,
            },
          });
        }
        pauseStartIdx = i;
      }
    }

    // Check final pause
    if (samples.length > 1) {
      const last = samples.length - 1;
      const pauseDuration = samples[last].timeMs - samples[pauseStartIdx].timeMs;
      if (pauseDuration >= PAUSE_DURATION_MS) {
        const midIdx = Math.floor((pauseStartIdx + last) / 2);
        events.push({
          type: 'click',
          startMs: samples[pauseStartIdx].timeMs,
          endMs: samples[last].timeMs,
          point: {
            x: samples[midIdx].x,
            y: samples[midIdx].y,
          },
        });
      }
    }

    return events;
  }
}
