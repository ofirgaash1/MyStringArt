import { rasterizeLinePixels } from './stringArtMath';

const SUBPIXEL_SAMPLE_OFFSETS = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
];

function getLineEndpointsInImageSpace(
  startNail,
  endNail,
  previewSize,
  imageCenter,
  imageScale,
) {
  const startPreviewX = (startNail.cx / 100) * previewSize;
  const startPreviewY = (startNail.cy / 100) * previewSize;
  const endPreviewX = (endNail.cx / 100) * previewSize;
  const endPreviewY = (endNail.cy / 100) * previewSize;

  return {
    startImageX: imageCenter.x + (startPreviewX - previewSize / 2) / imageScale,
    startImageY: imageCenter.y + (startPreviewY - previewSize / 2) / imageScale,
    endImageX: imageCenter.x + (endPreviewX - previewSize / 2) / imageScale,
    endImageY: imageCenter.y + (endPreviewY - previewSize / 2) / imageScale,
  };
}

function isValidLineRequest(startIndex, endIndex, imageSize, previewSize, nailsCount, nails) {
  if (
    !imageSize ||
    previewSize <= 0 ||
    !Number.isInteger(startIndex) ||
    !Number.isInteger(endIndex) ||
    startIndex < 1 ||
    endIndex < 1 ||
    startIndex > nailsCount ||
    endIndex > nailsCount
  ) {
    return false;
  }

  const startNail = nails[startIndex - 1];
  const endNail = nails[endIndex - 1];
  return Boolean(startNail && endNail);
}

function getPointToSegmentDistanceSquared(px, py, x1, y1, x2, y2) {
  const segmentDx = x2 - x1;
  const segmentDy = y2 - y1;
  const segmentLengthSquared = segmentDx * segmentDx + segmentDy * segmentDy;
  if (segmentLengthSquared <= 0) {
    const dx = px - x1;
    const dy = py - y1;
    return dx * dx + dy * dy;
  }

  const projection =
    ((px - x1) * segmentDx + (py - y1) * segmentDy) / segmentLengthSquared;
  const clampedProjection = Math.max(0, Math.min(1, projection));
  const closestX = x1 + clampedProjection * segmentDx;
  const closestY = y1 + clampedProjection * segmentDy;
  const dx = px - closestX;
  const dy = py - closestY;
  return dx * dx + dy * dy;
}

function buildRasterCoverageEntries(startImageX, startImageY, endImageX, endImageY, width, height) {
  const linePixels = rasterizeLinePixels(
    startImageX,
    startImageY,
    endImageX,
    endImageY,
    width,
    height,
  );
  return linePixels.map((pixel) => ({
    ...pixel,
    pixelIndex: pixel.y * width + pixel.x,
    coverage: 1,
  }));
}

function buildAreaCoverageEntries(
  startImageX,
  startImageY,
  endImageX,
  endImageY,
  width,
  height,
  threadWidthPx,
) {
  const entries = [];
  const radius = Math.max(0.05, threadWidthPx / 2);
  const distanceThresholdSquared = radius * radius;
  const minX = Math.max(0, Math.floor(Math.min(startImageX, endImageX) - radius - 1));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(startImageX, endImageX) + radius + 1));
  const minY = Math.max(0, Math.floor(Math.min(startImageY, endImageY) - radius - 1));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(startImageY, endImageY) + radius + 1));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      let coveredSamples = 0;
      for (const [offsetX, offsetY] of SUBPIXEL_SAMPLE_OFFSETS) {
        const sampleX = x + offsetX;
        const sampleY = y + offsetY;
        const distanceSquared = getPointToSegmentDistanceSquared(
          sampleX,
          sampleY,
          startImageX,
          startImageY,
          endImageX,
          endImageY,
        );
        if (distanceSquared <= distanceThresholdSquared) {
          coveredSamples += 1;
        }
      }

      if (coveredSamples <= 0) {
        continue;
      }

      entries.push({
        key: `${x}-${y}`,
        x,
        y,
        pixelIndex: y * width + x,
        coverage: coveredSamples / SUBPIXEL_SAMPLE_OFFSETS.length,
      });
    }
  }

  return entries;
}

export function createLineCoverageEngine({
  backendId = 'raster',
  threadWidthPx = 1.15,
} = {}) {
  const linePixelsCache = new Map();
  const lineCoverageCache = new Map();

  const clearCache = () => {
    linePixelsCache.clear();
    lineCoverageCache.clear();
  };

  const getLineCoverageForIndexes = (
    startIndex,
    endIndex,
    {
      imageSize,
      previewSize,
      imageCenter,
      imageScale,
      nailsCount,
      nails,
    },
  ) => {
    if (!isValidLineRequest(startIndex, endIndex, imageSize, previewSize, nailsCount, nails)) {
      return [];
    }

    const startNail = nails[startIndex - 1];
    const endNail = nails[endIndex - 1];
    if (!startNail || !endNail) {
      return [];
    }

    const cacheStartIndex = Math.min(startIndex, endIndex);
    const cacheEndIndex = Math.max(startIndex, endIndex);
    const cacheKey = `${cacheStartIndex}-${cacheEndIndex}`;
    const cachedEntries = lineCoverageCache.get(cacheKey);
    if (cachedEntries) {
      return cachedEntries;
    }

    const { startImageX, startImageY, endImageX, endImageY } = getLineEndpointsInImageSpace(
      startNail,
      endNail,
      previewSize,
      imageCenter,
      imageScale,
    );
    const coverageEntries =
      backendId === 'area'
        ? buildAreaCoverageEntries(
            startImageX,
            startImageY,
            endImageX,
            endImageY,
            imageSize.width,
            imageSize.height,
            threadWidthPx,
          )
        : buildRasterCoverageEntries(
            startImageX,
            startImageY,
            endImageX,
            endImageY,
            imageSize.width,
            imageSize.height,
          );
    lineCoverageCache.set(cacheKey, coverageEntries);
    return coverageEntries;
  };

  const getLinePixelsForIndexes = (startIndex, endIndex, context) => {
    const cacheStartIndex = Math.min(startIndex, endIndex);
    const cacheEndIndex = Math.max(startIndex, endIndex);
    const cacheKey = `${cacheStartIndex}-${cacheEndIndex}`;
    const cachedPixels = linePixelsCache.get(cacheKey);
    if (cachedPixels) {
      return cachedPixels;
    }

    const pixels = getLineCoverageForIndexes(startIndex, endIndex, context).map((entry) => ({
      key: entry.key,
      x: entry.x,
      y: entry.y,
    }));
    linePixelsCache.set(cacheKey, pixels);
    return pixels;
  };

  return {
    backendId,
    threadWidthPx,
    clearCache,
    getLinePixelsForIndexes,
    getLineCoverageForIndexes,
  };
}
