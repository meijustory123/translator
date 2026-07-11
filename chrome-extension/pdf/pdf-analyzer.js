const DEFAULT_MAX_CHARS = 20_000;
const MAX_BATCH_BLOCKS = 1;
const MIN_VALID_TEXT_CHARS = 12;
const MIN_SPARSE_TEXT_COVERAGE = 0.00025;

export const PDF_TEXT_LIMITS = Object.freeze({
  targetChars: DEFAULT_MAX_CHARS,
  maxChars: DEFAULT_MAX_CHARS,
  maxBlocksPerBatch: MAX_BATCH_BLOCKS,
  minValidTextChars: MIN_VALID_TEXT_CHARS,
});

const LIST_PREFIX_RE = /^\s*(?:[-*\u2022\u2023\u25e6\u2043\u2219]|(?:\d+|[A-Za-z]|[ivxlcdm]+)[.)])\s+/iu;
const LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;
const CJK_END_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const CJK_START_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const NO_SPACE_BEFORE_RE = /^[,.;:!?%\])}\u3001\u3002\uff0c\uff0e\uff1a\uff1b\uff01\uff1f\u3009\u300b\u300d\u300f\u3011]/u;
const NO_SPACE_AFTER_RE = /[\[({\u3008\u300a\u300c\u300e\u3010]$/u;
const TERMINAL_PUNCTUATION_RE = /[.!?\u3002\uff01\uff1f]["'\u201d\u2019\])]?$/u;
const HEADING_TEXT_RE = /^\s*(?:abstract|keywords?|references|bibliography|acknowledg(?:e)?ments?|appendix|\d+(?:\.\d+)*\s+[\p{L}\p{N}])/iu;
const CAPTION_TEXT_RE = /^\s*(?:fig(?:ure)?|table)\s*[.\dIVXLC:-]+/iu;
const METADATA_TEXT_RE = /^(?:\S+@\S+|(?:https?:\/\/|doi\s*:|arxiv\s*:).+)$/iu;
const EQUATION_NUMBER_RE = /^(?:\(?\d+(?:[a-z]|\.\d+)?\)?|\[\d+(?:[a-z]|\.\d+)?\])$/iu;
const REFERENCE_ENTRY_RE = /^\s*\[\s*\d+(?:\s*[-,]\s*\d+)*\s*\]/u;
const CITATION_END_RE = /\[\s*\d+(?:\s*[-,]\s*\d+)*\s*\][.)]?$/u;
const BOLD_FONT_RE = /(?:bold|semibold|demi|black|heavy|cmbx|cmssbx|timesbd|helvetica-bold)/iu;
const ITALIC_FONT_RE = /(?:italic|oblique|slanted|cmti|cmsl|timesi)/iu;

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function median(values, fallback = 0) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return fallback;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 0
    ? (finite[middle - 1] + finite[middle]) / 2
    : finite[middle];
}

export function countTextCharacters(text) {
  return Array.from(String(text ?? "")).length;
}

function countValidCharacters(text) {
  let count = 0;
  for (const character of String(text ?? "")) {
    if (LETTER_OR_NUMBER_RE.test(character)) count += 1;
  }
  return count;
}

export function multiplyTransforms(left, right) {
  if (!left || !right || left.length < 6 || right.length < 6) {
    throw new TypeError("PDF 变换矩阵必须包含 6 个数值");
  }

  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function applyTransform(transform, point) {
  return {
    x: transform[0] * point.x + transform[2] * point.y + transform[4],
    y: transform[1] * point.x + transform[3] * point.y + transform[5],
  };
}

function normalizeRotation(rotation) {
  const normalized = Math.round(Number(rotation) || 0) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function createFallbackViewportTransform(viewport, width, height) {
  const rotation = normalizeRotation(viewport?.rotation);
  const viewBox = Array.isArray(viewport?.viewBox) && viewport.viewBox.length >= 4
    ? viewport.viewBox.map(Number)
    : [0, 0, rotation === 90 || rotation === 270 ? height : width,
      rotation === 90 || rotation === 270 ? width : height];
  const [x0, y0, x1, y1] = viewBox;
  const sourceWidth = Math.max(1, Math.abs(x1 - x0));
  const sourceHeight = Math.max(1, Math.abs(y1 - y0));

  if (rotation === 90) {
    const xScale = width / sourceHeight;
    const yScale = height / sourceWidth;
    return [0, yScale, xScale, 0, -y0 * xScale, -x0 * yScale];
  }
  if (rotation === 180) {
    const xScale = width / sourceWidth;
    const yScale = height / sourceHeight;
    return [-xScale, 0, 0, yScale, width + x0 * xScale, -y0 * yScale];
  }
  if (rotation === 270) {
    const xScale = width / sourceHeight;
    const yScale = height / sourceWidth;
    return [0, -yScale, -xScale, 0, width + y0 * xScale, height + x0 * yScale];
  }

  const xScale = width / sourceWidth;
  const yScale = height / sourceHeight;
  return [xScale, 0, 0, -yScale, -x0 * xScale, height + y0 * yScale];
}

function getViewportInfo(viewport) {
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  if (!(width > 0) || !(height > 0)) {
    throw new TypeError("PDF 页面视口尺寸无效");
  }

  const suppliedTransform = viewport?.transform;
  const transform = suppliedTransform && suppliedTransform.length >= 6
    ? Array.from(suppliedTransform, Number)
    : createFallbackViewportTransform(viewport, width, height);
  if (!transform.every(Number.isFinite)) {
    throw new TypeError("PDF 页面视口变换矩阵无效");
  }

  return {
    width,
    height,
    rotation: normalizeRotation(viewport?.rotation),
    transform,
  };
}

function bboxFromPoints(points, bounds = null) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  let left = Math.min(...xs);
  let top = Math.min(...ys);
  let right = Math.max(...xs);
  let bottom = Math.max(...ys);

  if (bounds) {
    left = clamp(left, 0, bounds.width);
    right = clamp(right, 0, bounds.width);
    top = clamp(top, 0, bounds.height);
    bottom = clamp(bottom, 0, bounds.height);
  }

  return {
    x: round(left),
    y: round(top),
    width: round(Math.max(0, right - left)),
    height: round(Math.max(0, bottom - top)),
  };
}

function bboxRight(bbox) {
  return bbox.x + bbox.width;
}

function bboxBottom(bbox) {
  return bbox.y + bbox.height;
}

function unionBboxes(boxes) {
  const present = boxes.filter(Boolean);
  if (present.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...present.map((bbox) => bbox.x));
  const top = Math.min(...present.map((bbox) => bbox.y));
  const right = Math.max(...present.map(bboxRight));
  const bottom = Math.max(...present.map(bboxBottom));
  return {
    x: round(left),
    y: round(top),
    width: round(right - left),
    height: round(bottom - top),
  };
}

export function normalizeViewportBbox(bbox, viewport) {
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  if (!(width > 0) || !(height > 0) || !bbox) return null;
  const values = [bbox.x, bbox.y, bbox.width, bbox.height].map(Number);
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) return null;
  const left = clamp(values[0], 0, width);
  const top = clamp(values[1], 0, height);
  const right = clamp(values[0] + values[2], left, width);
  const bottom = clamp(values[1] + values[3], top, height);
  return {
    x: round(left / width * 1_000),
    y: round(top / height * 1_000),
    width: round((right - left) / width * 1_000),
    height: round((bottom - top) / height * 1_000),
  };
}

function sanitizeItemText(value) {
  return String(value ?? "")
    .replace(/\u0000/gu, "")
    .replace(/[\t\r\n\f\v ]+/gu, " ")
    .trim();
}

export function getTextItemGeometry(item, viewport, style = {}) {
  if (!item || typeof item.str !== "string" || !item.transform || item.transform.length < 6) {
    return null;
  }
  const viewportInfo = getViewportInfo(viewport);
  const itemTransform = Array.from(item.transform, Number);
  if (!itemTransform.every(Number.isFinite)) return null;

  const transform = multiplyTransforms(viewportInfo.transform, itemTransform);
  const rawXAxisLength = Math.hypot(itemTransform[0], itemTransform[1]);
  const xAxisLength = Math.hypot(transform[0], transform[1]);
  const yAxisLength = Math.hypot(transform[2], transform[3]);
  const viewportScale = rawXAxisLength > 0
    ? xAxisLength / rawXAxisLength
    : Math.max(
      Math.hypot(viewportInfo.transform[0], viewportInfo.transform[1]),
      Math.hypot(viewportInfo.transform[2], viewportInfo.transform[3]),
      1,
    );
  const fontSize = Math.max(
    yAxisLength,
    Math.abs(Number(item.height) || 0) * viewportScale,
    1,
  );
  let advance = Math.abs(Number(item.width) || 0) * viewportScale;
  if (!(advance > 0)) {
    advance = Math.max(fontSize * 0.45, countTextCharacters(item.str) * fontSize * 0.5);
  }

  const xUnit = xAxisLength > 0
    ? { x: transform[0] / xAxisLength, y: transform[1] / xAxisLength }
    : { x: 1, y: 0 };
  const yUnit = yAxisLength > 0
    ? { x: transform[2] / yAxisLength, y: transform[3] / yAxisLength }
    : { x: -xUnit.y, y: xUnit.x };
  const ascent = isFiniteNumber(style?.ascent) ? clamp(Number(style.ascent), 0, 1.5) : 0.8;
  const descent = isFiniteNumber(style?.descent) ? clamp(Number(style.descent), -0.75, 0.5) : -0.2;
  const topDistance = fontSize * Math.max(0.2, ascent);
  const bottomDistance = fontSize * Math.max(0.05, -descent);
  const origin = { x: transform[4], y: transform[5] };
  const topLeft = {
    x: origin.x + yUnit.x * topDistance,
    y: origin.y + yUnit.y * topDistance,
  };
  const bottomLeft = {
    x: origin.x - yUnit.x * bottomDistance,
    y: origin.y - yUnit.y * bottomDistance,
  };
  const advanceVector = { x: xUnit.x * advance, y: xUnit.y * advance };
  const corners = [
    topLeft,
    { x: topLeft.x + advanceVector.x, y: topLeft.y + advanceVector.y },
    { x: bottomLeft.x + advanceVector.x, y: bottomLeft.y + advanceVector.y },
    bottomLeft,
  ];

  return {
    bbox: bboxFromPoints(corners, viewportInfo),
    corners,
    origin,
    transform: transform.map(round),
    fontSize: round(fontSize),
    angle: Math.atan2(xUnit.y, xUnit.x),
  };
}

function orientationQuarter(angle) {
  return ((Math.round(angle / (Math.PI / 2)) % 4) + 4) % 4;
}

function isMarginalOrientationArtifact(item, viewportInfo) {
  const bbox = item?.bbox;
  if (!bbox || !(viewportInfo?.width > 0) || !(viewportInfo?.height > 0)) return false;
  const quarter = orientationQuarter(item.angle);
  const expectedQuarter = normalizeRotation(viewportInfo.rotation) / 90;
  if (quarter === expectedQuarter) return false;
  const centerX = bbox.x + bbox.width / 2;
  const centerY = bbox.y + bbox.height / 2;
  const inSideMargin = centerX <= viewportInfo.width * 0.12
    || centerX >= viewportInfo.width * 0.88;
  const inTopBottomMargin = centerY <= viewportInfo.height * 0.08
    || centerY >= viewportInfo.height * 0.92;
  const verticalOrientation = quarter === 1 || quarter === 3;
  const horizontalOrientation = quarter === 0 || quarter === 2;
  return (inSideMargin && verticalOrientation)
    || (inTopBottomMargin && horizontalOrientation);
}

function dominantOrientation(items, viewportInfo) {
  const weights = [0, 0, 0, 0];
  const marginalWeights = [0, 0, 0, 0];
  for (const item of items) {
    const quarter = orientationQuarter(item.angle);
    const characters = Math.min(80, Math.max(1, countValidCharacters(item.text)));
    const evidence = 48 + characters;
    // Count distinct runs as strong evidence so a single long watermark cannot
    // outweigh several shorter body lines. Marginal runs share a capped budget,
    // because some PDFs expose one vertical sidebar as one item per glyph.
    if (isMarginalOrientationArtifact(item, viewportInfo)) {
      marginalWeights[quarter] = Math.min(32, marginalWeights[quarter] + evidence * 0.12);
    } else {
      weights[quarter] += evidence;
    }
  }
  for (let index = 0; index < weights.length; index += 1) {
    weights[index] += marginalWeights[index];
  }
  let result = 0;
  for (let index = 1; index < weights.length; index += 1) {
    if (weights[index] > weights[result]) result = index;
  }
  return result;
}

function projectPointForOrientation(point, quarter) {
  if (quarter === 1) return { x: point.y, y: -point.x };
  if (quarter === 2) return { x: -point.x, y: -point.y };
  if (quarter === 3) return { x: -point.y, y: point.x };
  return { x: point.x, y: point.y };
}

function addLogicalGeometry(items, viewportInfo, quarter) {
  const pageCorners = [
    { x: 0, y: 0 },
    { x: viewportInfo.width, y: 0 },
    { x: viewportInfo.width, y: viewportInfo.height },
    { x: 0, y: viewportInfo.height },
  ].map((point) => projectPointForOrientation(point, quarter));
  const pageBox = bboxFromPoints(pageCorners);
  const offset = { x: -pageBox.x, y: -pageBox.y };

  return {
    logicalWidth: pageBox.width,
    logicalHeight: pageBox.height,
    items: items.map((item) => {
      const projected = item.corners.map((point) => {
        const logical = projectPointForOrientation(point, quarter);
        return { x: logical.x + offset.x, y: logical.y + offset.y };
      });
      return {
        ...item,
        layoutBBox: bboxFromPoints(projected, {
          width: pageBox.width,
          height: pageBox.height,
        }),
      };
    }),
  };
}

function projectViewportBboxForOrientation(bbox, viewportInfo, quarter) {
  const pageCorners = [
    { x: 0, y: 0 },
    { x: viewportInfo.width, y: 0 },
    { x: viewportInfo.width, y: viewportInfo.height },
    { x: 0, y: viewportInfo.height },
  ].map((point) => projectPointForOrientation(point, quarter));
  const pageBox = bboxFromPoints(pageCorners);
  const offset = { x: -pageBox.x, y: -pageBox.y };
  const corners = [
    { x: bbox.x, y: bbox.y },
    { x: bboxRight(bbox), y: bbox.y },
    { x: bboxRight(bbox), y: bboxBottom(bbox) },
    { x: bbox.x, y: bboxBottom(bbox) },
  ].map((point) => {
    const projected = projectPointForOrientation(point, quarter);
    return { x: projected.x + offset.x, y: projected.y + offset.y };
  });
  return bboxFromPoints(corners, {
    width: pageBox.width,
    height: pageBox.height,
  });
}

function verticalOverlapRatio(first, second) {
  const overlap = Math.max(
    0,
    Math.min(bboxBottom(first), bboxBottom(second)) - Math.max(first.y, second.y),
  );
  return overlap / Math.max(1, Math.min(first.height, second.height));
}

function createRowBands(items) {
  const sorted = [...items].sort((left, right) => {
    const yDifference = left.layoutBBox.y - right.layoutBBox.y;
    return Math.abs(yDifference) > 0.5 ? yDifference : left.layoutBBox.x - right.layoutBBox.x;
  });
  const bands = [];

  for (const item of sorted) {
    const center = item.layoutBBox.y + item.layoutBBox.height / 2;
    let bestBand = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = Math.max(0, bands.length - 6); index < bands.length; index += 1) {
      const band = bands[index];
      const bandCenter = band.layoutBBox.y + band.layoutBBox.height / 2;
      const distance = Math.abs(center - bandCenter);
      const tolerance = Math.max(2, Math.min(item.fontSize, band.fontSize) * 0.48);
      if (
        (distance <= tolerance || verticalOverlapRatio(item.layoutBBox, band.layoutBBox) >= 0.45)
        && distance < bestDistance
      ) {
        bestBand = band;
        bestDistance = distance;
      }
    }

    if (!bestBand) {
      bands.push({
        items: [item],
        layoutBBox: item.layoutBBox,
        fontSize: item.fontSize,
      });
    } else {
      bestBand.items.push(item);
      bestBand.layoutBBox = unionBboxes([bestBand.layoutBBox, item.layoutBBox]);
      bestBand.fontSize = median(bestBand.items.map((entry) => entry.fontSize), item.fontSize);
    }
  }

  return bands.sort((left, right) => left.layoutBBox.y - right.layoutBBox.y);
}

function shouldInsertSpace(left, right, gap, fontSize) {
  if (!left || !right || /\s$/u.test(left) || /^\s/u.test(right)) return false;
  if (CJK_END_RE.test(left) && CJK_START_RE.test(right)) return false;
  if (NO_SPACE_BEFORE_RE.test(right) || NO_SPACE_AFTER_RE.test(left)) return false;
  if (countTextCharacters(left) === 1 && countTextCharacters(right) === 1 && gap < fontSize * 0.18) {
    return false;
  }
  return gap > -fontSize * 0.08;
}

function textDirection(items) {
  const weights = new Map();
  for (const item of items) {
    const direction = item.dir || "ltr";
    weights.set(direction, (weights.get(direction) || 0) + Math.max(1, countTextCharacters(item.text)));
  }
  return [...weights.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "ltr";
}

function createLine(items, rowIndex, rowSegmentCount) {
  const direction = textDirection(items);
  const ordered = [...items].sort((left, right) => {
    const difference = left.layoutBBox.x - right.layoutBBox.x;
    return direction === "rtl" ? -difference : difference;
  });
  let text = "";
  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    if (index > 0) {
      const previous = ordered[index - 1];
      const gap = direction === "rtl"
        ? previous.layoutBBox.x - bboxRight(item.layoutBBox)
        : item.layoutBBox.x - bboxRight(previous.layoutBBox);
      if (shouldInsertSpace(text, item.text, gap, median([previous.fontSize, item.fontSize], item.fontSize))) {
        text += " ";
      }
    }
    text += item.text;
  }

  const fontNames = ordered.map((item) => item.fontName).filter(Boolean);
  const characterWeight = ordered.reduce(
    (total, item) => total + Math.max(1, countValidCharacters(item.text)),
    0,
  );
  const boldWeight = ordered.reduce(
    (total, item) => total + (item.isBold ? Math.max(1, countValidCharacters(item.text)) : 0),
    0,
  );
  const italicWeight = ordered.reduce(
    (total, item) => total + (item.isItalic ? Math.max(1, countValidCharacters(item.text)) : 0),
    0,
  );
  return {
    text: text.trim(),
    dir: direction,
    bbox: unionBboxes(ordered.map((item) => item.bbox)),
    layoutBBox: unionBboxes(ordered.map((item) => item.layoutBBox)),
    fontSize: round(median(ordered.map((item) => item.fontSize), 1)),
    fontName: fontNames[0] || "",
    isBold: boldWeight >= characterWeight * 0.5,
    isItalic: italicWeight >= characterWeight * 0.5,
    rowIndex,
    rowSegmentCount,
    sourceItemCount: ordered.length,
    items: ordered,
  };
}

function createLines(items, logicalWidth, forcedColumnRegion = null) {
  const bands = createRowBands(items);
  const persistentGutter = detectPersistentGutter(bands, logicalWidth);
  const lines = [];

  bands.forEach((band, rowIndex) => {
    const ordered = [...band.items].sort(
      (left, right) => left.layoutBBox.x - right.layoutBBox.x,
    );
    const segments = [];
    let current = [];
    for (const item of ordered) {
      const previous = current[current.length - 1];
      const gap = previous
        ? item.layoutBBox.x - bboxRight(previous.layoutBBox)
        : 0;
      const fontSize = median([previous?.fontSize, item.fontSize].filter(Boolean), item.fontSize);
      const wideGapThreshold = Math.max(logicalWidth * 0.08, fontSize * 5);
      const gutterGapThreshold = Math.max(logicalWidth * 0.008, fontSize * 1.05);
      const followsWithEquationNumber = EQUATION_NUMBER_RE.test(item.text)
        && item.layoutBBox.width <= logicalWidth * 0.08;
      const bandCenter = band.layoutBBox.y + band.layoutBBox.height / 2;
      const crossesForcedGutter = Boolean(
        previous
        && forcedColumnRegion
        && !forcedColumnRegion.preservedRowIndexes?.has(rowIndex)
        && bandCenter >= forcedColumnRegion.top
        && bandCenter <= forcedColumnRegion.bottom
        && previous.layoutBBox.x + previous.layoutBBox.width / 2 < forcedColumnRegion.x
        && item.layoutBBox.x + item.layoutBBox.width / 2 > forcedColumnRegion.x
        && gap >= Math.max(2, fontSize * 0.45)
      );
      const crossesPersistentGutter = Boolean(
        previous
        && persistentGutter
        && bboxRight(previous.layoutBBox) < persistentGutter.x
        && item.layoutBBox.x > persistentGutter.x
        && gap > gutterGapThreshold
      );
      if (
        previous
        && (
          (previous.hasEOL && !followsWithEquationNumber)
          || gap > wideGapThreshold
          || crossesPersistentGutter
          || crossesForcedGutter
        )
      ) {
        segments.push(current);
        current = [];
      }
      current.push(item);
    }
    if (current.length > 0) segments.push(current);

    for (const segment of segments) {
      const line = createLine(segment, rowIndex, segments.length);
      if (line.text) lines.push(line);
    }
  });

  return lines;
}

function detectPersistentGutter(bands, logicalWidth) {
  const gaps = [];
  for (let rowIndex = 0; rowIndex < bands.length; rowIndex += 1) {
    const ordered = [...bands[rowIndex].items].sort(
      (left, right) => left.layoutBBox.x - right.layoutBBox.x,
    );
    for (let index = 1; index < ordered.length; index += 1) {
      const left = ordered[index - 1];
      const right = ordered[index];
      const start = bboxRight(left.layoutBBox);
      const end = right.layoutBBox.x;
      const fontSize = median([left.fontSize, right.fontSize], right.fontSize);
      const narrowEquationNumber = EQUATION_NUMBER_RE.test(right.text)
        && right.layoutBBox.width <= logicalWidth * 0.08;
      if (
        !narrowEquationNumber
        &&
        end - start >= Math.max(logicalWidth * 0.008, fontSize * 1.05)
        && start < logicalWidth * 0.75
        && end > logicalWidth * 0.25
      ) {
        gaps.push({ start, end, rowIndex });
      }
    }
  }
  if (gaps.length < 2) return null;

  const candidates = gaps.flatMap((gap) => [
    (gap.start + gap.end) / 2,
    gap.start + (gap.end - gap.start) * 0.3,
    gap.start + (gap.end - gap.start) * 0.7,
  ]).filter((value) => value >= logicalWidth * 0.25 && value <= logicalWidth * 0.75);
  const minimumRows = bands.length >= 6
    ? Math.max(3, Math.ceil(bands.length * 0.06))
    : 2;
  let best = null;
  for (const x of candidates) {
    const matchingRows = new Set(
      gaps
        .filter((gap) => gap.start < x && gap.end > x)
        .map((gap) => gap.rowIndex),
    );
    const score = matchingRows.size;
    if (
      score >= minimumRows
      && (
        !best
        || score > best.score
        || (score === best.score && Math.abs(x - logicalWidth / 2) < Math.abs(best.x - logicalWidth / 2))
      )
    ) {
      best = { x: round(x), score };
    }
  }
  return best;
}

function markAndCollapseTableRows(lines) {
  const rows = new Map();
  for (const line of lines) {
    if (!rows.has(line.rowIndex)) rows.set(line.rowIndex, []);
    rows.get(line.rowIndex).push(line);
  }

  const orderedRows = [...rows.values()]
    .map((rowLines) => [...rowLines].sort(
      (left, right) => left.layoutBBox.x - right.layoutBBox.x,
    ))
    .sort((left, right) => left[0].layoutBBox.y - right[0].layoutBBox.y);
  const result = [];
  for (let rowIndex = 0; rowIndex < orderedRows.length; rowIndex += 1) {
    const ordered = orderedRows[rowIndex];
    const neighbouringRows = [orderedRows[rowIndex - 1], orderedRows[rowIndex + 1]]
      .filter(Boolean);
    // One row with several separated runs is common in author lists. Only
    // classify it as a table when another nearby row repeats the same columns.
    const explicitTable = ordered.length >= 3 && neighbouringRows.some(
      (neighbour) => rowsHaveAlignedCells(ordered, neighbour),
    );
    if (!explicitTable) {
      result.push(...ordered);
      continue;
    }

    result.push({
      ...ordered[0],
      text: ordered.map((line) => line.text).join("\t"),
      bbox: unionBboxes(ordered.map((line) => line.bbox)),
      layoutBBox: unionBboxes(ordered.map((line) => line.layoutBBox)),
      fontSize: round(median(ordered.map((line) => line.fontSize), ordered[0].fontSize)),
      rowSegmentCount: ordered.length,
      sourceItemCount: ordered.reduce((total, line) => total + line.sourceItemCount, 0),
      items: ordered.flatMap((line) => line.items),
      typeHint: "table",
    });
  }

  return result.sort((left, right) => {
    const yDifference = left.layoutBBox.y - right.layoutBBox.y;
    return Math.abs(yDifference) > 0.5 ? yDifference : left.layoutBBox.x - right.layoutBBox.x;
  });
}

function rowsHaveAlignedCells(first, second) {
  if (first.length < 3 || second.length < 3) return false;
  const typicalFontSize = median(
    [...first, ...second].map((line) => line.fontSize),
    12,
  );
  const rowDistance = Math.abs(first[0].layoutBBox.y - second[0].layoutBBox.y);
  if (rowDistance > typicalFontSize * 3) return false;
  const tolerance = Math.max(6, typicalFontSize * 1.1);
  let matches = 0;
  for (const line of first) {
    if (second.some((candidate) => (
      Math.abs(candidate.layoutBBox.x - line.layoutBBox.x) <= tolerance
    ))) {
      matches += 1;
    }
  }
  return matches >= Math.min(3, first.length, second.length);
}

function classifyLines(lines, logicalHeight) {
  const bodyFontSize = median(
    lines.filter((line) => line.typeHint !== "table").map((line) => line.fontSize),
    12,
  );
  const edgeSize = Math.max(24, logicalHeight * 0.065);

  return lines.map((line) => {
    let type = "paragraph";
    const characterCount = countTextCharacters(line.text);
    const headingLike = characterCount <= 240
      && (
        HEADING_TEXT_RE.test(line.text)
        || line.fontSize >= bodyFontSize * 1.22
      );
    if (line.typeHint === "table") {
      type = "table";
    } else if (bboxBottom(line.layoutBBox) >= logicalHeight - edgeSize) {
      type = "footer";
    } else if (
      line.layoutBBox.y >= logicalHeight * 0.68
      && line.fontSize <= bodyFontSize * 0.8
    ) {
      type = "footnote";
    } else if (CAPTION_TEXT_RE.test(line.text)) {
      type = "caption";
    } else if (headingLike) {
      type = "heading";
    } else if (line.layoutBBox.y <= edgeSize && characterCount <= 240) {
      type = "header";
    } else if (METADATA_TEXT_RE.test(line.text) && characterCount <= 240) {
      type = "metadata";
    } else if (LIST_PREFIX_RE.test(line.text)) {
      type = "list";
    } else if (line.isItalic && characterCount >= 20) {
      type = "quote";
    }
    return { ...line, type };
  });
}

export function detectColumns(lines, pageWidth) {
  const width = Number(pageWidth);
  if (!(width > 0) || !Array.isArray(lines)) return { count: 1 };
  const candidates = lines.filter((line) => (
    line?.layoutBBox
    && line.type !== "table"
    && line.type !== "header"
    && line.type !== "footer"
    && line.type !== "heading"
    && line.type !== "metadata"
    && line.layoutBBox.width <= width * 0.62
  ));
  if (candidates.length < 4) return { count: 1 };

  const sorted = [...candidates].sort(
    (left, right) => left.layoutBBox.x - right.layoutBBox.x,
  );
  const typicalFontSize = median(sorted.map((line) => line.fontSize), 12);
  const minimumStartGap = Math.max(width * 0.14, typicalFontSize * 4);
  let splitIndex = -1;
  let largestGap = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    if (index < 2 || sorted.length - index < 2) continue;
    const gap = sorted[index].layoutBBox.x - sorted[index - 1].layoutBBox.x;
    if (gap >= minimumStartGap && gap > largestGap) {
      splitIndex = index;
      largestGap = gap;
    }
  }
  if (splitIndex < 0) return { count: 1 };

  const tentativeLeft = sorted.slice(0, splitIndex);
  const right = sorted.slice(splitIndex);
  const rightStart = Math.min(...right.map((line) => line.layoutBBox.x));
  const minimumGutter = Math.max(8, width * 0.015);
  const left = tentativeLeft.filter(
    (line) => bboxRight(line.layoutBBox) <= rightStart - minimumGutter,
  );
  if (left.length < 2 || right.length < 2) return { count: 1 };
  if (!hasSubstantialColumn(left, width) || !hasSubstantialColumn(right, width)) {
    return { count: 1 };
  }

  const leftTop = Math.min(...left.map((line) => line.layoutBBox.y));
  const leftBottom = Math.max(...left.map((line) => bboxBottom(line.layoutBBox)));
  const rightTop = Math.min(...right.map((line) => line.layoutBBox.y));
  const rightBottom = Math.max(...right.map((line) => bboxBottom(line.layoutBBox)));
  const verticalOverlap = Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop);
  if (verticalOverlap < typicalFontSize * 0.5) return { count: 1 };

  const leftEnd = Math.max(...left.map((line) => bboxRight(line.layoutBBox)));
  if (rightStart - leftEnd < minimumGutter) return { count: 1 };

  return {
    count: 2,
    leftEnd: round(leftEnd),
    rightStart: round(rightStart),
    gutter: {
      x: round(leftEnd),
      width: round(rightStart - leftEnd),
    },
    verticalSpan: {
      top: round(Math.max(leftTop, rightTop)),
      bottom: round(Math.min(leftBottom, rightBottom)),
    },
  };
}

function hasSubstantialColumn(lines, pageWidth) {
  const characterCount = lines.reduce(
    (total, line) => total + countValidCharacters(line.text),
    0,
  );
  const typicalWidth = median(lines.map((line) => line.layoutBBox.width), 0);
  return characterCount >= 12
    && (typicalWidth >= pageWidth * 0.1 || characterCount >= 80);
}

function findLineGutterCrossing(line, gutterX) {
  const ordered = [...(line?.items || [])].sort(
    (left, right) => left.layoutBBox.x - right.layoutBBox.x,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const left = ordered[index - 1];
    const right = ordered[index];
    const leftCenter = left.layoutBBox.x + left.layoutBBox.width / 2;
    const rightCenter = right.layoutBBox.x + right.layoutBBox.width / 2;
    if (leftCenter < gutterX && rightCenter > gutterX) {
      return {
        gap: right.layoutBBox.x - bboxRight(left.layoutBBox),
        fontSize: median([left.fontSize, right.fontSize], right.fontSize),
      };
    }
  }
  return null;
}

function createForcedColumnRegion(lines, columnLayout, logicalHeight) {
  const gutterX = columnLayout.gutter.x + columnLayout.gutter.width / 2;
  const preservedRowIndexes = new Set();
  const topBarrierTypes = new Set(["heading", "header", "metadata", "table"]);
  let top = 0;
  let bottom = logicalHeight;

  for (const line of lines) {
    const spansGutter = line.layoutBBox.x < gutterX && bboxRight(line.layoutBBox) > gutterX;
    if (!spansGutter) continue;
    const crossing = findLineGutterCrossing(line, gutterX);
    const continuousAcrossGutter = !crossing
      || crossing.gap <= Math.max(3, crossing.fontSize * 0.9);
    if (continuousAcrossGutter && Number.isInteger(line.rowIndex)) {
      preservedRowIndexes.add(line.rowIndex);
    }

    if (
      line.layoutBBox.y < columnLayout.verticalSpan.top
      && topBarrierTypes.has(line.type)
    ) {
      top = Math.max(top, bboxBottom(line.layoutBBox) + Math.min(3, line.fontSize * 0.25));
    }
    if (
      bboxBottom(line.layoutBBox) > columnLayout.verticalSpan.bottom
      && line.type === "footer"
    ) {
      bottom = Math.min(bottom, line.layoutBBox.y - Math.min(3, line.fontSize * 0.25));
    }
  }

  return {
    x: gutterX,
    top: clamp(top, 0, logicalHeight),
    bottom: clamp(Math.max(top, bottom), 0, logicalHeight),
    preservedRowIndexes,
  };
}

function assignAndOrderColumns(lines, columnLayout) {
  if (columnLayout.count !== 2) {
    return [...lines]
      .sort((left, right) => {
        const yDifference = left.layoutBBox.y - right.layoutBBox.y;
        return Math.abs(yDifference) > 0.5 ? yDifference : left.layoutBBox.x - right.layoutBBox.x;
      })
      .map((line) => ({ ...line, column: 0 }));
  }

  const tolerance = Math.max(2, columnLayout.gutter.width * 0.15);
  const assigned = lines.map((line) => {
    if (bboxRight(line.layoutBBox) <= columnLayout.rightStart - tolerance) {
      return { ...line, column: 0 };
    }
    if (line.layoutBBox.x >= columnLayout.rightStart - tolerance) {
      return { ...line, column: 1 };
    }
    return { ...line, column: null };
  });
  const spanning = assigned
    .filter((line) => line.column === null)
    .sort((left, right) => left.layoutBBox.y - right.layoutBBox.y);
  const columnLines = assigned.filter((line) => line.column !== null);
  const consumed = new Set();
  const result = [];

  const appendBefore = (limit) => {
    for (const column of [0, 1]) {
      const entries = columnLines
        .filter((line) => (
          line.column === column
          && !consumed.has(line)
          && line.layoutBBox.y < limit
        ))
        .sort((left, right) => {
          const yDifference = left.layoutBBox.y - right.layoutBBox.y;
          return Math.abs(yDifference) > 0.5 ? yDifference : left.layoutBBox.x - right.layoutBBox.x;
        });
      for (const entry of entries) {
        consumed.add(entry);
        result.push(entry);
      }
    }
  };

  for (const span of spanning) {
    appendBefore(span.layoutBBox.y + Math.min(2, span.fontSize * 0.15));
    result.push(span);
  }
  appendBefore(Number.POSITIVE_INFINITY);
  return result;
}

function propagateColumnLineTypes(lines) {
  const grouped = new Map();
  for (const line of lines) {
    const key = Number.isInteger(line.column) ? `column-${line.column}` : `span-${line.rowIndex}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(line);
  }

  const replacements = new Map();
  for (const entries of grouped.values()) {
    const ordered = [...entries].sort((left, right) => left.layoutBBox.y - right.layoutBBox.y);
    for (let index = 0; index < ordered.length; index += 1) {
      const anchor = ordered[index];
      if (anchor.type !== "caption") continue;
      let previous = anchor;
      let continuationCount = 0;
      for (
        let continuationIndex = index + 1;
        continuationIndex < ordered.length && continuationCount < 8;
        continuationIndex += 1
      ) {
        const current = ordered[continuationIndex];
        if (current.type !== "paragraph" || replacements.has(current)) break;
        const fontSize = median([anchor.fontSize, current.fontSize], current.fontSize);
        const verticalGap = current.layoutBBox.y - bboxBottom(previous.layoutBBox);
        const fontRatio = Math.max(anchor.fontSize, current.fontSize)
          / Math.max(1, Math.min(anchor.fontSize, current.fontSize));
        const sameFont = !anchor.fontName
          || !current.fontName
          || anchor.fontName === current.fontName;
        if (
          verticalGap < -fontSize * 0.25
          || verticalGap > Math.max(2, anchor.fontSize * 0.55)
          || Math.abs(current.layoutBBox.x - anchor.layoutBBox.x) > Math.max(12, fontSize * 2)
          || fontRatio > 1.08
          || !sameFont
          || current.isBold !== anchor.isBold
          || current.isItalic !== anchor.isItalic
        ) {
          break;
        }
        replacements.set(current, { ...current, type: "caption" });
        previous = current;
        continuationCount += 1;
      }
    }
  }

  return lines.map((line) => replacements.get(line) || line);
}

function joinLineText(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (/\p{L}-$/u.test(left) && /^\p{Ll}/u.test(right)) {
    return `${left.slice(0, -1)}${right}`;
  }
  if (CJK_END_RE.test(left) && CJK_START_RE.test(right)) return `${left}${right}`;
  if (NO_SPACE_BEFORE_RE.test(right) || NO_SPACE_AFTER_RE.test(left)) return `${left}${right}`;
  return `${left} ${right}`;
}

function annotateParagraphSignals(lines) {
  const groups = new Map();
  for (const line of lines) {
    if (!Number.isInteger(line.column) || line.type !== "paragraph") continue;
    if (!groups.has(line.column)) groups.set(line.column, []);
    groups.get(line.column).push(line);
  }

  const signals = new Map();
  for (const entries of groups.values()) {
    const leftEdge = percentile(entries.map((line) => line.layoutBBox.x), 0.15);
    const typicalWidth = percentile(entries.map((line) => line.layoutBBox.width), 0.72);
    const indentation = entries.map((line) => {
      const threshold = Math.max(6, line.fontSize * 0.8);
      return line.layoutBBox.x - leftEdge >= threshold;
    });
    let referenceEntryActive = false;
    let hangingIndent = null;
    for (let index = 0; index < entries.length; index += 1) {
      const line = entries[index];
      const previous = entries[index - 1];
      const next = entries[index + 1];
      const indented = indentation[index];
      const explicitReferenceStart = REFERENCE_ENTRY_RE.test(line.text);
      let hangingContinuation = false;
      if (explicitReferenceStart) {
        referenceEntryActive = true;
        hangingIndent = null;
      } else if (!indented) {
        referenceEntryActive = false;
        hangingIndent = null;
      } else if (referenceEntryActive) {
        if (hangingIndent == null) hangingIndent = line.layoutBBox.x;
        if (
          Math.abs(line.layoutBBox.x - hangingIndent)
          <= Math.max(2, line.fontSize * 0.25)
        ) {
          hangingContinuation = true;
        } else {
          referenceEntryActive = false;
          hangingIndent = null;
        }
      }
      const previousGap = previous
        ? line.layoutBBox.y - bboxBottom(previous.layoutBBox)
        : Number.POSITIVE_INFINITY;
      const previousLooksClosed = !previous
        || previous.layoutBBox.width <= typicalWidth * 0.76
        || TERMINAL_PUNCTUATION_RE.test(previous.text)
        || CITATION_END_RE.test(previous.text)
        || previousGap > Math.max(3, line.fontSize * 0.45);
      // A real first-line indent is normally isolated: the following wrapped
      // line returns to the column edge. Treating every offset line as a new
      // paragraph fragments justified or imperfectly aligned PDF text.
      const isolatedFirstLineIndent = indented
        && !indentation[index - 1]
        && (!next || !indentation[index + 1])
        && previousLooksClosed;
      signals.set(line, {
        paragraphStart: (explicitReferenceStart || isolatedFirstLineIndent)
          && !hangingContinuation,
        shortLine: line.layoutBBox.width <= typicalWidth * 0.76,
      });
    }
  }

  return lines.map((line) => ({ ...line, ...(signals.get(line) || {}) }));
}

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * ratio)),
  );
  return sorted[index];
}

function canMergeLines(previous, next) {
  if (!previous || previous.column !== next.column || previous.type !== next.type) return false;
  const gap = next.layoutBBox.y - bboxBottom(previous.layoutBBox);
  const fontSize = median([previous.fontSize, next.fontSize], next.fontSize);
  const maximumGap = next.type === "paragraph"
    ? fontSize * 1.3
    : next.type === "quote"
      ? fontSize * 1.1
      : fontSize * 0.85;
  if (gap < -fontSize * 0.35 || gap > maximumGap) return false;
  if (Math.max(previous.fontSize, next.fontSize) / Math.max(1, Math.min(previous.fontSize, next.fontSize)) > 1.35) {
    return false;
  }

  if (next.type === "list") return false;
  if (next.type === "table") return gap <= fontSize * 0.55;
  if (next.type === "header" || next.type === "footer") return gap <= fontSize * 0.4;
  if (next.type === "footnote") return gap <= fontSize * 0.65;

  if (
    next.type === "paragraph"
    && next.paragraphStart
  ) {
    return false;
  }

  const indentDifference = Math.abs(next.layoutBBox.x - previous.layoutBBox.x);
  const previousCenter = previous.layoutBBox.x + previous.layoutBBox.width / 2;
  const nextCenter = next.layoutBBox.x + next.layoutBBox.width / 2;
  const centerAligned = Math.abs(previousCenter - nextCenter) <= Math.max(18, fontSize * 1.8);
  const expectedIndentTransition = next.type === "paragraph"
    && (previous.paragraphStart || REFERENCE_ENTRY_RE.test(previous.text))
    && indentDifference <= fontSize * 4;
  if (
    indentDifference > Math.max(18, fontSize * 1.5)
    && !centerAligned
    && !expectedIndentTransition
  ) return false;
  return true;
}

function canLooselyMergeBodyLines(previous, next) {
  if (!previous || previous.column !== next.column) return false;
  const types = new Set([previous.type, next.type]);
  const paragraphPair = types.size === 1 && types.has("paragraph");
  const softHeadingPair = types.size === 2
    && types.has("paragraph")
    && types.has("heading")
    && !HEADING_TEXT_RE.test(previous.type === "heading" ? previous.text : next.text);
  if (!paragraphPair && !softHeadingPair) return false;

  const fontSize = median([previous.fontSize, next.fontSize], next.fontSize);
  const fontRatio = Math.max(previous.fontSize, next.fontSize)
    / Math.max(1, Math.min(previous.fontSize, next.fontSize));
  const gap = next.layoutBBox.y - bboxBottom(previous.layoutBBox);
  const indentDifference = Math.abs(next.layoutBBox.x - previous.layoutBBox.x);
  return gap >= -fontSize * 0.4
    && gap <= fontSize * 1.8
    && indentDifference <= fontSize * 5
    && fontRatio <= 1.45;
}

function createBlocks(orderedLines, pageNumber) {
  const groups = [];
  for (const line of orderedLines) {
    const group = groups[groups.length - 1];
    const previous = group?.lines[group.lines.length - 1];
    if (
      !group
      || (!canMergeLines(previous, line) && !canLooselyMergeBodyLines(previous, line))
    ) {
      groups.push({ lines: [line] });
    } else {
      group.lines.push(line);
    }
  }

  return groups.map(({ lines }) => {
    const type = lines[0].type;
    const text = lines.reduce((combined, line, index) => {
      if (index === 0) return line.text;
      if (type === "table") return `${combined}\n${line.text}`;
      return joinLineText(combined, line.text);
    }, "");
    return {
      pageNumber,
      type,
      text,
      characterCount: countTextCharacters(text),
      bbox: unionBboxes(lines.map((line) => line.bbox)),
      layoutBBox: unionBboxes(lines.map((line) => line.layoutBBox)),
      column: lines[0].column,
      dir: textDirection(lines.flatMap((line) => line.items)),
      fontSize: round(median(lines.map((line) => line.fontSize), lines[0].fontSize)),
      lines,
    };
  });
}

function inferBlockColumn(layoutBBox, columnLayout) {
  if (columnLayout.count !== 2) return 0;
  const tolerance = Math.max(2, columnLayout.gutter.width * 0.15);
  if (bboxRight(layoutBBox) <= columnLayout.rightStart - tolerance) return 0;
  if (layoutBBox.x >= columnLayout.rightStart - tolerance) return 1;
  return null;
}

function compareBlocksByGeometry(left, right) {
  const yDifference = left.layoutBBox.y - right.layoutBBox.y;
  if (Math.abs(yDifference) > 0.5) return yDifference;
  const xDifference = left.layoutBBox.x - right.layoutBBox.x;
  if (Math.abs(xDifference) > 0.5) return xDifference;
  return String(left.text).localeCompare(String(right.text));
}

function createStandaloneRotatedBlocks(
  items,
  pageNumber,
  viewportInfo,
  mainOrientation,
  columnLayout,
) {
  const orientationGroups = new Map();
  for (const item of items) {
    const quarter = orientationQuarter(item.angle);
    if (!orientationGroups.has(quarter)) orientationGroups.set(quarter, []);
    orientationGroups.get(quarter).push(item);
  }

  const blocks = [];
  const groups = [...orientationGroups.entries()].sort((left, right) => left[0] - right[0]);
  for (const [quarter, entries] of groups) {
    const logical = addLogicalGeometry(entries, viewportInfo, quarter);
    const lines = createLines(logical.items, logical.logicalWidth)
      .sort((left, right) => {
        const yDifference = left.layoutBBox.y - right.layoutBBox.y;
        return Math.abs(yDifference) > 0.5
          ? yDifference
          : left.layoutBBox.x - right.layoutBBox.x;
      })
      .map((line) => ({ ...line, type: "rotated_text", column: null }));
    const groupedBlocks = createBlocks(lines, pageNumber);
    for (const block of groupedBlocks) {
      const layoutBBox = projectViewportBboxForOrientation(
        block.bbox,
        viewportInfo,
        mainOrientation,
      );
      blocks.push({
        ...block,
        type: "rotated_text",
        layoutBBox,
        column: inferBlockColumn(layoutBBox, columnLayout),
        readingOrientation: quarter * 90,
      });
    }
  }
  return blocks.sort(compareBlocksByGeometry);
}

function orderBlocksWithRotatedContent(mainBlocks, rotatedBlocks, columnLayout) {
  const combined = [...mainBlocks, ...rotatedBlocks];
  if (columnLayout.count !== 2) return combined.sort(compareBlocksByGeometry);

  const spanning = combined
    .filter((block) => block.column === null)
    .sort(compareBlocksByGeometry);
  const columnBlocks = combined.filter((block) => block.column !== null);
  const consumed = new Set();
  const result = [];
  const appendBefore = (limit) => {
    for (const column of [0, 1]) {
      const entries = columnBlocks
        .filter((block) => (
          block.column === column
          && !consumed.has(block)
          && block.layoutBBox.y < limit
        ))
        .sort(compareBlocksByGeometry);
      for (const entry of entries) {
        consumed.add(entry);
        result.push(entry);
      }
    }
  };

  for (const span of spanning) {
    appendBefore(span.layoutBBox.y + Math.min(2, span.fontSize * 0.15));
    result.push(span);
  }
  appendBefore(Number.POSITIVE_INFINITY);
  return result;
}

export function splitTextAtBoundaries(text, maxChars = DEFAULT_MAX_CHARS) {
  const limit = Math.floor(Number(maxChars));
  if (!(limit > 0)) throw new RangeError("文本块字符上限必须为正整数");
  let remaining = Array.from(String(text ?? ""));
  const chunks = [];

  while (remaining.length > limit) {
    const minimumBreak = Math.floor(limit * 0.55);
    let breakAt = limit;
    for (let index = limit; index >= minimumBreak; index -= 1) {
      const previous = remaining[index - 1];
      const current = remaining[index];
      if (/\s/u.test(previous) || /[.!?;:\u3002\uff01\uff1f\uff1b]/u.test(previous) && /\s/u.test(current || " ")) {
        breakAt = index;
        break;
      }
    }
    const chunk = remaining.slice(0, breakAt).join("").trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(breakAt);
    while (remaining.length > 0 && /\s/u.test(remaining[0])) remaining.shift();
  }
  const tail = remaining.join("").trim();
  if (tail) chunks.push(tail);
  return chunks;
}

export function splitOversizedBlocks(blocks, maxChars = DEFAULT_MAX_CHARS) {
  if (!Array.isArray(blocks)) throw new TypeError("文本块必须为数组");
  const result = [];
  for (const block of blocks) {
    const chunks = splitTextAtBoundaries(block?.text, maxChars);
    chunks.forEach((text, index) => {
      result.push({
        ...block,
        text,
        characterCount: countTextCharacters(text),
        continuationIndex: index,
        continuationCount: chunks.length,
      });
    });
  }
  return result;
}

export function detectPageType({ validCharacterCount, textCoverage, blockCount }) {
  const characters = Math.max(0, Number(validCharacterCount) || 0);
  const coverage = Math.max(0, Number(textCoverage) || 0);
  const blocks = Math.max(0, Number(blockCount) || 0);
  if (characters === 0 || blocks === 0) return "scanned";
  if (characters < MIN_VALID_TEXT_CHARS) return "scanned";
  if (coverage < MIN_SPARSE_TEXT_COVERAGE) return "scanned";
  return "text";
}

export function analyzeTextItems(items, { pageNumber, viewport, styles = {} } = {}) {
  const normalizedPageNumber = Math.floor(Number(pageNumber));
  if (!(normalizedPageNumber > 0)) throw new TypeError("PDF 页码必须为正整数");
  if (!Array.isArray(items)) throw new TypeError("PDF 文本项目必须为数组");
  const viewportInfo = getViewportInfo(viewport);
  const geometryItems = [];

  for (let sourceIndex = 0; sourceIndex < items.length; sourceIndex += 1) {
    const item = items[sourceIndex];
    const text = sanitizeItemText(item?.str);
    if (!text) continue;
    const style = styles?.[item.fontName] || {};
    const geometry = getTextItemGeometry(item, viewportInfo, style);
    if (!geometry || geometry.bbox.width <= 0 || geometry.bbox.height <= 0) continue;
    geometryItems.push({
      text,
      str: text,
      dir: item.dir || "ltr",
      fontName: item.fontName || "",
      hasEOL: Boolean(item.hasEOL),
      sourceIndex,
      bbox: geometry.bbox,
      corners: geometry.corners,
      transform: geometry.transform,
      fontSize: geometry.fontSize,
      angle: geometry.angle,
      isBold: BOLD_FONT_RE.test(
        `${item.fontName || ""} ${style.fontFamily || ""} ${style.fontWeight || ""}`,
      ),
      isItalic: ITALIC_FONT_RE.test(
        `${item.fontName || ""} ${style.fontFamily || ""} ${style.fontStyle || ""}`,
      ),
    });
  }

  const orientation = dominantOrientation(geometryItems, viewportInfo);
  const mainOrientationItems = geometryItems.filter(
    (item) => orientationQuarter(item.angle) === orientation,
  );
  const ignoredOrientationItems = geometryItems.filter((item) => (
    orientationQuarter(item.angle) !== orientation
    && isMarginalOrientationArtifact(item, viewportInfo)
  ));
  const retainedRotatedItems = geometryItems.filter((item) => (
    orientationQuarter(item.angle) !== orientation
    && !isMarginalOrientationArtifact(item, viewportInfo)
  ));
  const logical = addLogicalGeometry(mainOrientationItems, viewportInfo, orientation);
  let rawLines = createLines(logical.items, logical.logicalWidth);
  let classifiedLines = classifyLines(
    markAndCollapseTableRows(rawLines),
    logical.logicalHeight,
  );
  let columnLayout = detectColumns(classifiedLines, logical.logicalWidth);
  if (columnLayout.count === 2) {
    const initialRawLines = rawLines;
    const initialClassifiedLines = classifiedLines;
    const forcedColumnRegion = createForcedColumnRegion(
      classifiedLines,
      columnLayout,
      logical.logicalHeight,
    );
    rawLines = createLines(logical.items, logical.logicalWidth, forcedColumnRegion);
    classifiedLines = classifyLines(
      markAndCollapseTableRows(rawLines),
      logical.logicalHeight,
    );
    const refinedLayout = detectColumns(classifiedLines, logical.logicalWidth);
    if (refinedLayout.count === 2) {
      columnLayout = refinedLayout;
    } else {
      rawLines = initialRawLines;
      classifiedLines = initialClassifiedLines;
    }
  }
  const orderedLines = annotateParagraphSignals(
    propagateColumnLineTypes(assignAndOrderColumns(classifiedLines, columnLayout)),
  );
  const mainBlocks = createBlocks(orderedLines, normalizedPageNumber);
  const rotatedBlocks = createStandaloneRotatedBlocks(
    retainedRotatedItems,
    normalizedPageNumber,
    viewportInfo,
    orientation,
    columnLayout,
  );
  const unsplitBlocks = orderBlocksWithRotatedContent(
    mainBlocks,
    rotatedBlocks,
    columnLayout,
  );
  const splitBlocks = splitOversizedBlocks(unsplitBlocks, DEFAULT_MAX_CHARS);
  const validCharacterCount = [...mainOrientationItems, ...retainedRotatedItems].reduce(
    (total, item) => total + countValidCharacters(item.text),
    0,
  );
  const textArea = orderedLines.reduce(
    (total, line) => total + line.bbox.width * line.bbox.height,
    retainedRotatedItems.reduce(
      (total, item) => total + item.bbox.width * item.bbox.height,
      0,
    ),
  );
  const textCoverage = Math.min(1, textArea / (viewportInfo.width * viewportInfo.height));
  const type = detectPageType({
    validCharacterCount,
    textCoverage,
    blockCount: splitBlocks.length,
  });
  const blocks = type === "scanned"
    ? []
    : splitBlocks.map((block, index) => {
      const viewportBBox = block.bbox;
      return {
        ...block,
        id: `p${normalizedPageNumber}-b${String(index + 1).padStart(3, "0")}`,
        bbox: normalizeViewportBbox(viewportBBox, viewportInfo),
        viewportBBox,
      };
    });

  return {
    pageNumber: normalizedPageNumber,
    type,
    width: viewportInfo.width,
    height: viewportInfo.height,
    rotation: viewportInfo.rotation,
    readingOrientation: orientation * 90,
    columnCount: columnLayout.count,
    columnLayout,
    ignoredOrientationItemCount: ignoredOrientationItems.length,
    rotatedBlockCount: rotatedBlocks.length,
    validCharacterCount,
    textCoverage: round(textCoverage),
    lines: type === "scanned" ? [] : orderedLines,
    blocks,
    scanReason: type === "scanned"
      ? (validCharacterCount === 0 ? "no_text" : "sparse_text")
      : null,
  };
}

export async function analyzePdfDocument(pdfDocument, { onProgress } = {}) {
  const totalPages = Math.floor(Number(pdfDocument?.numPages));
  if (!(totalPages > 0) || typeof pdfDocument?.getPage !== "function") {
    throw new TypeError("PDF 文档对象无效");
  }
  if (onProgress != null && typeof onProgress !== "function") {
    throw new TypeError("PDF 分析进度回调必须为函数");
  }

  const pages = [];
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const pdfPage = await pdfDocument.getPage(pageNumber);
    if (!pdfPage || typeof pdfPage.getViewport !== "function" || typeof pdfPage.getTextContent !== "function") {
      throw new TypeError(`PDF 第 ${pageNumber} 页对象无效`);
    }
    const viewport = pdfPage.getViewport({ scale: 1 });
    const textContent = await pdfPage.getTextContent();
    const page = analyzeTextItems(textContent?.items || [], {
      pageNumber,
      viewport,
      styles: textContent?.styles || {},
    });
    pages.push(page);

    if (onProgress) {
      await onProgress({
        pageNumber,
        completedPages: pageNumber,
        totalPages,
        progress: pageNumber / totalPages,
        page,
      });
    }
  }
  return pages;
}

function normalizeBatchLimit(value, fallback, name) {
  const normalized = Math.floor(Number(value ?? fallback));
  if (!(normalized > 0)) throw new RangeError(`${name}必须为正整数`);
  return normalized;
}

export function buildTextBatches(pages, options = {}) {
  const pageList = Array.isArray(pages) ? pages : pages?.pages;
  if (!Array.isArray(pageList)) throw new TypeError("PDF 页面分析结果必须为数组");
  const maxChars = normalizeBatchLimit(options.maxChars, DEFAULT_MAX_CHARS, "单页字符上限");

  const batches = [];
  for (const page of pageList) {
    if (page?.type === "scanned") continue;
    const pageNumber = Math.floor(Number(page?.pageNumber));
    if (!(pageNumber > 0)) throw new TypeError("PDF 页面分析结果缺少有效页码");
    const blocks = Array.isArray(page?.blocks)
      ? page.blocks.filter((block) => String(block?.text ?? "").trim())
      : [];
    if (blocks.length === 0) continue;
    const pageText = blocks
      .map((block) => String(block.text).trim())
      .filter(Boolean)
      .join("\n\n");
    const characterCount = countTextCharacters(pageText);
    if (characterCount > maxChars) {
      throw new RangeError(
        `第 ${pageNumber} 页文字超过单页翻译上限 ${maxChars.toLocaleString("en-US")} 个字符。`,
      );
    }

    const batchId = `p${pageNumber}-page`;
    batches.push({
      id: batchId,
      batchId,
      pageNumber,
      blocks: [{ id: batchId, text: pageText }],
      characterCount,
    });
  }
  return batches;
}
