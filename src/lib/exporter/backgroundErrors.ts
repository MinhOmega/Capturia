/**
 * Raised by the frame renderer when the export background (image or gradient)
 * cannot be prepared. Exporters must not retry on it: the input will not get
 * better on a second attempt. The message never leaks a full local path.
 */
export class BackgroundLoadError extends Error {
  readonly url: string;
  readonly cause?: unknown;

  constructor(url: string, cause?: unknown) {
    super(`Failed to load background image: ${displayBasename(url)}`);
    this.name = 'BackgroundLoadError';
    this.url = url;
    this.cause = cause;
  }

  get displayUrl(): string {
    return displayBasename(this.url);
  }
}

export function isBackgroundLoadError(error: unknown): error is BackgroundLoadError {
  return error instanceof BackgroundLoadError
    || (error instanceof Error && error.name === 'BackgroundLoadError');
}

function displayBasename(url: string): string {
  if (url.startsWith('data:')) {
    return 'data:…';
  }
  if (/^(linear|radial)-gradient\(/i.test(url)) {
    return 'gradient';
  }
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : '(unknown)';
  } catch {
    const last = url.split('/').filter(Boolean).pop();
    return last || '(unknown)';
  }
}
