/** A canvas whose size can be set, and that may or may not have a style (an offscreen one has none). */
interface SizableCanvas {
  width: number;
  height: number;
  style?: { width: string; height: string };
}

/**
 * Gives `canvas` one pixel per device pixel for a box of `width` × `height` CSS pixels, and shows it at exactly that size, so the browser never
 * resamples what is drawn on it: a thin line drawn at a whole pixel of the canvas is a whole pixel of the screen, the same in every frame.
 */
export function sizeToDevicePixels(canvas: SizableCanvas, width: number, height: number, ratio: number): void {
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  if (canvas.style) {
    canvas.style.width = `${canvas.width / ratio}px`;
    canvas.style.height = `${canvas.height / ratio}px`;
  }
}
