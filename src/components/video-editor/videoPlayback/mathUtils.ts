export function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function smoothStep(t: number) {
  const clamped = clamp01(t);
  return clamped * clamped * (3 - 2 * clamped);
}

function sampleCubicBezier(a1: number, a2: number, t: number) {
  const oneMinusT = 1 - t;
  return 3 * a1 * oneMinusT * oneMinusT * t + 3 * a2 * oneMinusT * t * t + t * t * t;
}

function sampleCubicBezierDerivative(a1: number, a2: number, t: number) {
  const oneMinusT = 1 - t;
  return 3 * a1 * oneMinusT * oneMinusT + 6 * (a2 - a1) * oneMinusT * t + 3 * (1 - a2) * t * t;
}

/**
 * CSS-style cubic-bezier(x1, y1, x2, y2) evaluated at progress t (0-1): a few
 * Newton iterations to solve x(s) = t, then a bisection fallback, then y(s).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, t: number) {
  const targetX = clamp01(t);
  let solvedT = targetX;

  for (let i = 0; i < 8; i += 1) {
    const currentX = sampleCubicBezier(x1, x2, solvedT) - targetX;
    const currentDerivative = sampleCubicBezierDerivative(x1, x2, solvedT);

    if (Math.abs(currentX) < 1e-6 || Math.abs(currentDerivative) < 1e-6) {
      break;
    }

    solvedT -= currentX / currentDerivative;
  }

  let lower = 0;
  let upper = 1;
  solvedT = clamp01(solvedT);

  for (let i = 0; i < 10; i += 1) {
    const currentX = sampleCubicBezier(x1, x2, solvedT);
    if (Math.abs(currentX - targetX) < 1e-6) {
      break;
    }

    if (currentX < targetX) {
      lower = solvedT;
    } else {
      upper = solvedT;
    }

    solvedT = (lower + upper) / 2;
  }

  return sampleCubicBezier(y1, y2, solvedT);
}

/** Screen Studio-like camera ease: fast launch, long soft landing. */
export function easeOutScreenStudio(t: number) {
  return cubicBezier(0.16, 1, 0.3, 1, t);
}
