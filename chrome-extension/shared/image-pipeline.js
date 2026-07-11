export const IMAGE_LIMITS = Object.freeze({
  maxSide: 2_048,
  maxPixels: 3_200_000,
  maxEncodedBytes: 3 * 1_024 * 1_024,
});

export const IMAGE_JPEG_QUALITIES = Object.freeze([0.9, 0.82, 0.74, 0.66]);

export function calculateImageOutputSize(sourceWidth, sourceHeight) {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    throw new TypeError("图片尺寸无效。");
  }

  const sideScale = Math.min(1, IMAGE_LIMITS.maxSide / Math.max(sourceWidth, sourceHeight));
  const pixelScale = Math.min(
    1,
    Math.sqrt(IMAGE_LIMITS.maxPixels / (sourceWidth * sourceHeight)),
  );
  const outputScale = Math.min(sideScale, pixelScale);

  return {
    width: Math.max(1, Math.round(sourceWidth * outputScale)),
    height: Math.max(1, Math.round(sourceHeight * outputScale)),
  };
}
