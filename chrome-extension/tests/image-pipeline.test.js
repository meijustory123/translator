import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateImageOutputSize,
  IMAGE_JPEG_QUALITIES,
  IMAGE_LIMITS,
} from "../shared/image-pipeline.js";

test("普通截图尺寸保持不变", () => {
  assert.deepEqual(calculateImageOutputSize(1_920, 1_080), {
    width: 1_920,
    height: 1_080,
  });
});

test("高分辨率图片同时满足最长边与总像素限制", () => {
  const output = calculateImageOutputSize(7_680, 4_320);

  assert.ok(Math.max(output.width, output.height) <= IMAGE_LIMITS.maxSide);
  assert.ok(output.width * output.height <= IMAGE_LIMITS.maxPixels);
  assert.ok(Math.abs(output.width / output.height - 16 / 9) < 0.01);
});

test("图片上传具有编码字节硬上限与逐级压缩质量", () => {
  assert.equal(IMAGE_LIMITS.maxEncodedBytes, 3 * 1_024 * 1_024);
  assert.deepEqual([...IMAGE_JPEG_QUALITIES], [0.9, 0.82, 0.74, 0.66]);
});

test("无效图片尺寸会被拒绝", () => {
  assert.throws(() => calculateImageOutputSize(0, 100), /图片尺寸无效/u);
  assert.throws(() => calculateImageOutputSize(Number.NaN, 100), /图片尺寸无效/u);
});
