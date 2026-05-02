import { getCircularNailDistance, getNormalizedLineKey } from '../stringArtMath.js';
import {
  geometryDifference,
  geometryIntersection,
  geometryUnion,
  getMultiPolygonArea,
} from '../vectorColorRegions.js';

const FOREGROUND_DELAY_MS = 16;
const HIDDEN_DELAY_MS = 0;
const FOREGROUND_BATCH_BUDGET_MS = 0;
const HIDDEN_BATCH_BUDGET_MS = 250;
const GEOMETRY_AREA_EPSILON = 1e-9;
const ACCEPTED_STRIP_GRID_SIZE = 32;
const BITSET_DEFAULT_GRID_SIZE = 1024;
const BITSET_WORD_BITS = 32;
const BITSET_WORD_MASK = BITSET_WORD_BITS - 1;

let isRunning = false;
let isHidden = false;
let tickTimerId = null;
let awaitingMainThreadAck = false;
let state = null;

function clearTickTimer() {
  if (tickTimerId !== null) {
    clearTimeout(tickTimerId);
    tickTimerId = null;
  }
}

function getBatchBudgetMs() {
  return isHidden ? HIDDEN_BATCH_BUDGET_MS : FOREGROUND_BATCH_BUDGET_MS;
}

function scheduleTick(delayMs = isHidden ? HIDDEN_DELAY_MS : FOREGROUND_DELAY_MS) {
  clearTickTimer();
  if (!isRunning || !state || awaitingMainThreadAck) {
    return;
  }

  tickTimerId = setTimeout(() => {
    tickTimerId = null;
    runBatch();
  }, delayMs);
}

function getOpenRingPoints(ring) {
  if (!Array.isArray(ring)) {
    return [];
  }

  const points = ring
    .filter((point) =>
      Array.isArray(point) &&
      point.length >= 2 &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1]),
    )
    .map((point) => [point[0], point[1]]);
  if (points.length > 1) {
    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];
    if (firstPoint[0] === lastPoint[0] && firstPoint[1] === lastPoint[1]) {
      points.pop();
    }
  }
  return points.length >= 3 ? points : [];
}

function getSignedPolygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) {
    return 0;
  }

  let doubleArea = 0;
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const nextPointIndex = (pointIndex + 1) % points.length;
    const [x1, y1] = points[pointIndex];
    const [x2, y2] = points[nextPointIndex];
    doubleArea += (x1 * y2) - (x2 * y1);
  }
  return doubleArea / 2;
}

function getPolygonArea(points) {
  return Math.abs(getSignedPolygonArea(points));
}

function getBoundsForPoints(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return null;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function doBoundsOverlap(firstBounds, secondBounds) {
  return (
    firstBounds &&
    secondBounds &&
    firstBounds.minX <= secondBounds.maxX &&
    firstBounds.maxX >= secondBounds.minX &&
    firstBounds.minY <= secondBounds.maxY &&
    firstBounds.maxY >= secondBounds.minY
  );
}

function expandBounds(firstBounds, secondBounds) {
  if (!firstBounds) {
    return secondBounds ? { ...secondBounds } : null;
  }
  if (!secondBounds) {
    return firstBounds;
  }
  return {
    minX: Math.min(firstBounds.minX, secondBounds.minX),
    minY: Math.min(firstBounds.minY, secondBounds.minY),
    maxX: Math.max(firstBounds.maxX, secondBounds.maxX),
    maxY: Math.max(firstBounds.maxY, secondBounds.maxY),
  };
}

function getBoundsForGeometry(geometry) {
  if (!Array.isArray(geometry) || geometry.length === 0) {
    return null;
  }

  let bounds = null;
  for (const polygon of geometry) {
    if (!Array.isArray(polygon)) {
      continue;
    }
    for (const ring of polygon) {
      bounds = expandBounds(bounds, getBoundsForPoints(getOpenRingPoints(ring)));
    }
  }
  return bounds;
}

function getClipLineIntersection(segmentStart, segmentEnd, clipStart, clipEnd) {
  const segmentX = segmentEnd[0] - segmentStart[0];
  const segmentY = segmentEnd[1] - segmentStart[1];
  const clipX = clipEnd[0] - clipStart[0];
  const clipY = clipEnd[1] - clipStart[1];
  const denominator = (segmentX * clipY) - (segmentY * clipX);
  if (Math.abs(denominator) <= GEOMETRY_AREA_EPSILON) {
    return [segmentEnd[0], segmentEnd[1]];
  }

  const startToClipX = clipStart[0] - segmentStart[0];
  const startToClipY = clipStart[1] - segmentStart[1];
  const t = ((startToClipX * clipY) - (startToClipY * clipX)) / denominator;
  return [
    segmentStart[0] + (t * segmentX),
    segmentStart[1] + (t * segmentY),
  ];
}

function clipPolygonToConvexPolygon(subjectPolygon, clipPolygon) {
  if (
    !Array.isArray(subjectPolygon) ||
    subjectPolygon.length < 3 ||
    !Array.isArray(clipPolygon) ||
    clipPolygon.length < 3
  ) {
    return [];
  }

  const clipOrientation = getSignedPolygonArea(clipPolygon) >= 0 ? 1 : -1;
  let outputPolygon = subjectPolygon;
  for (let clipIndex = 0; clipIndex < clipPolygon.length; clipIndex += 1) {
    const clipStart = clipPolygon[clipIndex];
    const clipEnd = clipPolygon[(clipIndex + 1) % clipPolygon.length];
    const inputPolygon = outputPolygon;
    outputPolygon = [];
    if (inputPolygon.length === 0) {
      break;
    }

    const isInside = (point) => {
      const cross =
        ((clipEnd[0] - clipStart[0]) * (point[1] - clipStart[1])) -
        ((clipEnd[1] - clipStart[1]) * (point[0] - clipStart[0]));
      return clipOrientation * cross >= -GEOMETRY_AREA_EPSILON;
    };

    let previousPoint = inputPolygon[inputPolygon.length - 1];
    let previousInside = isInside(previousPoint);
    for (const currentPoint of inputPolygon) {
      const currentInside = isInside(currentPoint);
      if (currentInside) {
        if (!previousInside) {
          outputPolygon.push(
            getClipLineIntersection(previousPoint, currentPoint, clipStart, clipEnd),
          );
        }
        outputPolygon.push(currentPoint);
      } else if (previousInside) {
        outputPolygon.push(
          getClipLineIntersection(previousPoint, currentPoint, clipStart, clipEnd),
        );
      }
      previousPoint = currentPoint;
      previousInside = currentInside;
    }
  }

  return outputPolygon.length >= 3 ? outputPolygon : [];
}

function getConvexClippedArea(subjectPolygon, clipPolygon) {
  const clippedPolygon = clipPolygonToConvexPolygon(subjectPolygon, clipPolygon);
  return clippedPolygon.length >= 3 ? getPolygonArea(clippedPolygon) : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createPackedBitset(cellCount) {
  return new Uint32Array(Math.ceil(cellCount / BITSET_WORD_BITS));
}

function getPackedBitIndexMask(bitIndex) {
  return 1 << (bitIndex & BITSET_WORD_MASK);
}

function setPackedBit(bits, bitIndex) {
  const wordIndex = bitIndex >>> 5;
  bits[wordIndex] |= getPackedBitIndexMask(bitIndex);
}

function popcount32(value) {
  let v = value >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function bitsetAndNotPopcount(lineBits, targetBits, paintedBits) {
  let gain = 0;
  for (let i = 0; i < lineBits.length; i += 1) {
    gain += popcount32((lineBits[i] & targetBits[i] & ~paintedBits[i]) >>> 0);
  }
  return gain;
}

function bitsetOrInto(targetBits, lineBits) {
  for (let i = 0; i < lineBits.length; i += 1) {
    targetBits[i] |= lineBits[i];
  }
}

function countPackedBits(bits) {
  let total = 0;
  for (let i = 0; i < bits.length; i += 1) {
    total += popcount32(bits[i]);
  }
  return total;
}

function buildBitsetPreviewSnapshot() {
  const bitsetState = state.bitsetState;
  if (!bitsetState) {
    return null;
  }

  const targetMask = createPackedBitset(bitsetState.cellCount);
  const paintedMask = createPackedBitset(bitsetState.cellCount);
  for (const mask of bitsetState.targetMaskByColorId.values()) {
    bitsetOrInto(targetMask, mask);
  }
  for (const mask of bitsetState.paintedMaskByColorId.values()) {
    bitsetOrInto(paintedMask, mask);
  }

  return {
    gridSize: bitsetState.gridSize,
    cellCount: bitsetState.cellCount,
    targetCellCount: countPackedBits(targetMask),
    paintedCellCount: countPackedBits(paintedMask),
    targetMask,
    paintedMask,
  };
}

function isPointInsidePolygon(pointX, pointY, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return false;
  }

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = ((yi > pointY) !== (yj > pointY))
      && (pointX < ((xj - xi) * (pointY - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function pointToSegmentDistanceSquared(pointX, pointY, startX, startY, endX, endY) {
  const dx = endX - startX;
  const dy = endY - startY;
  if (dx === 0 && dy === 0) {
    const offsetX = pointX - startX;
    const offsetY = pointY - startY;
    return (offsetX * offsetX) + (offsetY * offsetY);
  }

  const projection = (((pointX - startX) * dx) + ((pointY - startY) * dy)) / ((dx * dx) + (dy * dy));
  const clampedT = Math.max(0, Math.min(1, projection));
  const closestX = startX + (clampedT * dx);
  const closestY = startY + (clampedT * dy);
  const offsetX = pointX - closestX;
  const offsetY = pointY - closestY;
  return (offsetX * offsetX) + (offsetY * offsetY);
}

function getLineStripDescriptor(lineGeometry) {
  const ring = lineGeometry?.[0]?.[0];
  if (!Array.isArray(ring) || ring.length < 4) {
    return null;
  }

  const startOuter = ring[0];
  const endOuter = ring[1];
  const endInner = ring[2];
  const startInner = ring[3];
  if (
    !Array.isArray(startOuter) ||
    !Array.isArray(endOuter) ||
    !Array.isArray(endInner) ||
    !Array.isArray(startInner)
  ) {
    return null;
  }

  const startX = (startOuter[0] + startInner[0]) / 2;
  const startY = (startOuter[1] + startInner[1]) / 2;
  const endX = (endOuter[0] + endInner[0]) / 2;
  const endY = (endOuter[1] + endInner[1]) / 2;
  const halfWidth = Math.hypot(startOuter[0] - startInner[0], startOuter[1] - startInner[1]) / 2;
  return { startX, startY, endX, endY, halfWidth };
}

function rasterizePolygonToMask(polygon, bounds, bitsetState) {
  if (!bitsetState || !Array.isArray(polygon) || polygon.length < 3 || !bounds) {
    return null;
  }
  const mask = createPackedBitset(bitsetState.cellCount);
  const minCellX = clamp(
    Math.floor((bounds.minX - bitsetState.bounds.minX) / bitsetState.cellSizeX),
    0,
    bitsetState.gridSize - 1,
  );
  const maxCellX = clamp(
    Math.ceil((bounds.maxX - bitsetState.bounds.minX) / bitsetState.cellSizeX),
    0,
    bitsetState.gridSize - 1,
  );
  const minCellY = clamp(
    Math.floor((bounds.minY - bitsetState.bounds.minY) / bitsetState.cellSizeY),
    0,
    bitsetState.gridSize - 1,
  );
  const maxCellY = clamp(
    Math.ceil((bounds.maxY - bitsetState.bounds.minY) / bitsetState.cellSizeY),
    0,
    bitsetState.gridSize - 1,
  );

  let coverage = 0;
  for (let y = minCellY; y <= maxCellY; y += 1) {
    const worldY = bitsetState.bounds.minY + ((y + 0.5) * bitsetState.cellSizeY);
    for (let x = minCellX; x <= maxCellX; x += 1) {
      const worldX = bitsetState.bounds.minX + ((x + 0.5) * bitsetState.cellSizeX);
      if (!isPointInsidePolygon(worldX, worldY, polygon)) {
        continue;
      }
      const bitIndex = y * bitsetState.gridSize + x;
      const wordIndex = bitIndex >>> 5;
      const bitMask = getPackedBitIndexMask(bitIndex);
      if ((mask[wordIndex] & bitMask) === 0) {
        mask[wordIndex] |= bitMask;
        coverage += 1;
      }
    }
  }
  return coverage > 0 ? { mask, coverage } : null;
}

function rasterizeLineGeometryToMask(lineGeometry, bounds, bitsetState) {
  if (!bitsetState || !Array.isArray(lineGeometry) || lineGeometry.length === 0 || !bounds) {
    return null;
  }

  const descriptor = getLineStripDescriptor(lineGeometry);
  if (!descriptor) {
    return null;
  }

  const mask = createPackedBitset(bitsetState.cellCount);
  const minCellX = clamp(
    Math.floor((bounds.minX - bitsetState.bounds.minX) / bitsetState.cellSizeX),
    0,
    bitsetState.gridSize - 1,
  );
  const maxCellX = clamp(
    Math.ceil((bounds.maxX - bitsetState.bounds.minX) / bitsetState.cellSizeX),
    0,
    bitsetState.gridSize - 1,
  );
  const minCellY = clamp(
    Math.floor((bounds.minY - bitsetState.bounds.minY) / bitsetState.cellSizeY),
    0,
    bitsetState.gridSize - 1,
  );
  const maxCellY = clamp(
    Math.ceil((bounds.maxY - bitsetState.bounds.minY) / bitsetState.cellSizeY),
    0,
    bitsetState.gridSize - 1,
  );
  const maxDistanceSq = descriptor.halfWidth * descriptor.halfWidth;

  let coverage = 0;
  for (let y = minCellY; y <= maxCellY; y += 1) {
    const worldY = bitsetState.bounds.minY + ((y + 0.5) * bitsetState.cellSizeY);
    for (let x = minCellX; x <= maxCellX; x += 1) {
      const worldX = bitsetState.bounds.minX + ((x + 0.5) * bitsetState.cellSizeX);
      if (pointToSegmentDistanceSquared(worldX, worldY, descriptor.startX, descriptor.startY, descriptor.endX, descriptor.endY) > maxDistanceSq) {
        continue;
      }
      const bitIndex = y * bitsetState.gridSize + x;
      const wordIndex = bitIndex >>> 5;
      const bitMask = getPackedBitIndexMask(bitIndex);
      if ((mask[wordIndex] & bitMask) === 0) {
        mask[wordIndex] |= bitMask;
        coverage += 1;
      }
    }
  }
  return coverage > 0 ? { mask, coverage } : null;
}

function getOrBuildLineBitsetMetric(lineKey, lineGeometry, lineBounds) {
  if (!state.bitsetState || !lineKey || !Array.isArray(lineGeometry) || lineGeometry.length === 0) {
    return null;
  }
  const cached = state.lineBitsetMetricByLineKey.get(lineKey);
  if (cached) {
    return cached;
  }
  const metric = rasterizeLineGeometryToMask(lineGeometry, lineBounds, state.bitsetState);
  if (!metric) {
    return null;
  }
  state.lineBitsetMetricByLineKey.set(lineKey, metric);
  return metric;
}

function getBitsetTargetGain(colorId, lineBitsetMetric) {
  const bitsetState = state.bitsetState;
  const target = bitsetState?.targetMaskByColorId.get(colorId);
  const painted = bitsetState?.paintedMaskByColorId.get(colorId);
  if (!target || !painted || !lineBitsetMetric) {
    return 0;
  }
  return bitsetAndNotPopcount(lineBitsetMetric.mask, target, painted);
}

function applyLineToBitsetPaint(colorId, lineBitsetMetric) {
  const painted = state.bitsetState?.paintedMaskByColorId.get(colorId);
  if (!painted || !lineBitsetMetric) {
    return;
  }
  bitsetOrInto(painted, lineBitsetMetric.mask);
}

function buildGeometryAreaIndex(geometry) {
  if (!Array.isArray(geometry) || geometry.length === 0) {
    return [];
  }

  const indexedPolygons = [];
  for (const polygon of geometry) {
    if (!Array.isArray(polygon) || polygon.length === 0) {
      continue;
    }

    const outerRing = getOpenRingPoints(polygon[0]);
    const bounds = getBoundsForPoints(outerRing);
    if (!bounds || outerRing.length < 3) {
      continue;
    }

    const holeRings = [];
    for (let holeIndex = 1; holeIndex < polygon.length; holeIndex += 1) {
      const holeRing = getOpenRingPoints(polygon[holeIndex]);
      const holeBounds = getBoundsForPoints(holeRing);
      if (holeRing.length >= 3 && holeBounds) {
        holeRings.push({ ring: holeRing, bounds: holeBounds });
      }
    }

    indexedPolygons.push({ outerRing, holeRings, bounds });
  }
  return indexedPolygons;
}

function getLineOverlapAreaWithGeometryIndex(lineClipPolygon, lineBounds, geometryIndex) {
  if (
    !Array.isArray(lineClipPolygon) ||
    lineClipPolygon.length < 3 ||
    !lineBounds ||
    !Array.isArray(geometryIndex) ||
    geometryIndex.length === 0
  ) {
    return 0;
  }

  let totalArea = 0;
  for (const indexedPolygon of geometryIndex) {
    if (!doBoundsOverlap(lineBounds, indexedPolygon.bounds)) {
      continue;
    }

    let polygonArea = getConvexClippedArea(indexedPolygon.outerRing, lineClipPolygon);
    if (polygonArea <= GEOMETRY_AREA_EPSILON) {
      continue;
    }

    for (const hole of indexedPolygon.holeRings) {
      if (!doBoundsOverlap(lineBounds, hole.bounds)) {
        continue;
      }
      polygonArea -= getConvexClippedArea(hole.ring, lineClipPolygon);
    }
    totalArea += Math.max(0, polygonArea);
  }

  return totalArea;
}

function createAcceptedStripIndex(worldBounds) {
  const fallbackBounds = worldBounds ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return {
    worldBounds: fallbackBounds,
    cellWidth: Math.max(
      GEOMETRY_AREA_EPSILON,
      (fallbackBounds.maxX - fallbackBounds.minX) / ACCEPTED_STRIP_GRID_SIZE,
    ),
    cellHeight: Math.max(
      GEOMETRY_AREA_EPSILON,
      (fallbackBounds.maxY - fallbackBounds.minY) / ACCEPTED_STRIP_GRID_SIZE,
    ),
    entries: [],
    cells: new Map(),
  };
}

function getAcceptedStripCellRange(index, bounds) {
  const clampCell = (value) =>
    Math.max(0, Math.min(ACCEPTED_STRIP_GRID_SIZE - 1, Math.floor(value)));
  return {
    minCellX: clampCell((bounds.minX - index.worldBounds.minX) / index.cellWidth),
    maxCellX: clampCell((bounds.maxX - index.worldBounds.minX) / index.cellWidth),
    minCellY: clampCell((bounds.minY - index.worldBounds.minY) / index.cellHeight),
    maxCellY: clampCell((bounds.maxY - index.worldBounds.minY) / index.cellHeight),
  };
}

function getAcceptedStripCellKey(cellX, cellY) {
  return `${cellX}:${cellY}`;
}

function addAcceptedPaintedStripToIndex(colorId, geometry) {
  const index = state.acceptedStripIndexesByColorId.get(colorId);
  if (!index) {
    return;
  }

  for (const polygon of geometry ?? []) {
    const fragmentGeometry = [polygon];
    const bounds = getBoundsForGeometry(fragmentGeometry);
    if (!bounds) {
      continue;
    }

    const entryIndex = index.entries.length;
    index.entries.push({
      geometry: fragmentGeometry,
      geometryIndex: buildGeometryAreaIndex(fragmentGeometry),
      bounds,
    });
    const range = getAcceptedStripCellRange(index, bounds);
    for (let cellY = range.minCellY; cellY <= range.maxCellY; cellY += 1) {
      for (let cellX = range.minCellX; cellX <= range.maxCellX; cellX += 1) {
        const cellKey = getAcceptedStripCellKey(cellX, cellY);
        const cellEntries = index.cells.get(cellKey);
        if (cellEntries) {
          cellEntries.push(entryIndex);
        } else {
          index.cells.set(cellKey, [entryIndex]);
        }
      }
    }
  }
}

function queryAcceptedPaintedStrips(colorId, lineBounds, profile) {
  const index = state.acceptedStripIndexesByColorId.get(colorId);
  if (!index || index.entries.length === 0 || !lineBounds) {
    return [];
  }

  const range = getAcceptedStripCellRange(index, lineBounds);
  const seenEntryIndexes = new Set();
  const matchingEntries = [];
  for (let cellY = range.minCellY; cellY <= range.maxCellY; cellY += 1) {
    for (let cellX = range.minCellX; cellX <= range.maxCellX; cellX += 1) {
      const cellEntries = index.cells.get(getAcceptedStripCellKey(cellX, cellY));
      if (!cellEntries) {
        continue;
      }
      for (const entryIndex of cellEntries) {
        if (seenEntryIndexes.has(entryIndex)) {
          continue;
        }
        seenEntryIndexes.add(entryIndex);
        const entry = index.entries[entryIndex];
        if (!doBoundsOverlap(lineBounds, entry.bounds)) {
          continue;
        }
        matchingEntries.push(entry);
      }
    }
  }

  if (profile) {
    profile.acceptedStripQueryCandidateCount += seenEntryIndexes.size;
    profile.acceptedStripQueryHitCount += matchingEntries.length;
  }
  return matchingEntries;
}

function getLineOverlapAreaWithAcceptedPaintedStrips(lineGeometry, lineBounds, colorId, profile) {
  const matchingEntries = queryAcceptedPaintedStrips(colorId, lineBounds, profile);
  if (matchingEntries.length === 0) {
    return 0;
  }

  const intersections = [];
  for (const entry of matchingEntries) {
    const intersectionStartedAt = performance.now();
    const intersection = geometryIntersection(lineGeometry, entry.geometry);
    addProfileMs(profile, 'localCurrentIntersectionMs', intersectionStartedAt);
    if (intersection.length > 0) {
      intersections.push(intersection);
    }
  }
  if (intersections.length === 0) {
    return 0;
  }

  if (profile) {
    profile.localCurrentIntersectionHitCount += intersections.length;
  }

  const unionStartedAt = performance.now();
  let unionGeometry = intersections[0];
  for (let index = 1; index < intersections.length; index += 1) {
    unionGeometry = geometryUnion(unionGeometry, intersections[index]);
  }
  addProfileMs(profile, 'localCurrentUnionMs', unionStartedAt);

  const areaStartedAt = performance.now();
  const overlapArea = getMultiPolygonArea(unionGeometry);
  addProfileMs(profile, 'localCurrentAreaMs', areaStartedAt);
  return overlapArea;
}

function getLineOverlapAreaWithAcceptedFragmentIndex(lineClipPolygon, lineBounds, colorId, profile) {
  const matchingEntries = queryAcceptedPaintedStrips(colorId, lineBounds, profile);
  if (matchingEntries.length === 0) {
    return 0;
  }

  let totalArea = 0;
  const fragmentClipStartedAt = performance.now();
  for (const entry of matchingEntries) {
    totalArea += getLineOverlapAreaWithGeometryIndex(
      lineClipPolygon,
      lineBounds,
      entry.geometryIndex,
    );
  }
  addProfileMs(profile, 'fragmentCurrentClipMs', fragmentClipStartedAt);
  return totalArea;
}

function buildLineGeometryForIndexes(startNail, endNail) {
  if (!startNail || !endNail || !state?.imageCenter || state.previewSize <= 0) {
    return [];
  }

  const startPreviewX = (startNail.cx / 100) * state.previewSize;
  const startPreviewY = (startNail.cy / 100) * state.previewSize;
  const endPreviewX = (endNail.cx / 100) * state.previewSize;
  const endPreviewY = (endNail.cy / 100) * state.previewSize;
  const startImageX = state.imageCenter.x + (startPreviewX - state.previewSize / 2) / state.imageScale;
  const startImageY = state.imageCenter.y + (startPreviewY - state.previewSize / 2) / state.imageScale;
  const endImageX = state.imageCenter.x + (endPreviewX - state.previewSize / 2) / state.imageScale;
  const endImageY = state.imageCenter.y + (endPreviewY - state.previewSize / 2) / state.imageScale;
  const safeWidth = Math.max(0.001, state.lineWidthPx);
  const dx = endImageX - startImageX;
  const dy = endImageY - startImageY;
  const length = Math.hypot(dx, dy);
  const half = safeWidth / 2;
  if (length <= 1e-9) {
    return [[[
      [startImageX - half, startImageY - half],
      [startImageX + half, startImageY - half],
      [startImageX + half, startImageY + half],
      [startImageX - half, startImageY + half],
      [startImageX - half, startImageY - half],
    ]]];
  }

  const nx = -(dy / length);
  const ny = dx / length;
  return [[[
    [startImageX + nx * half, startImageY + ny * half],
    [endImageX + nx * half, endImageY + ny * half],
    [endImageX - nx * half, endImageY - ny * half],
    [startImageX - nx * half, startImageY - ny * half],
    [startImageX + nx * half, startImageY + ny * half],
  ]]];
}

function getLineClipPolygonFromGeometry(lineGeometry) {
  return getOpenRingPoints(lineGeometry?.[0]?.[0]);
}

function getBucketLineCount(bucket) {
  return bucket?.lineCount ?? bucket?.lines?.length ?? 0;
}

function getTotalLineCount() {
  return state.buckets.reduce((sum, bucket) => sum + getBucketLineCount(bucket), 0);
}

function getEligibleBuckets() {
  return state.buckets.filter((bucket) =>
    bucket.enabled &&
    Math.max(0, (state.plannedLinesByColorId.get(bucket.colorId) ?? 0) - getBucketLineCount(bucket)) > 0,
  );
}

function getStartNailNumberForBucket(bucket) {
  return bucket.lastNailNumber ?? state.fallbackStartNailNumber;
}

function getUsedLineKeysForBucket(bucket) {
  return state.usedLineExclusionMode === 'shared'
    ? state.sharedUsedLineKeys
    : state.usedLineKeysByColorId.get(bucket.colorId) ?? state.sharedUsedLineKeys;
}

function addAcceptedLineKeyToWorkerState(colorId, startNailNumber, endNailNumber) {
  const lineKey = getNormalizedLineKey(startNailNumber, endNailNumber);
  if (!lineKey) {
    return;
  }

  state.sharedUsedLineKeys.add(lineKey);
  const colorUsedLineKeys = state.usedLineKeysByColorId.get(colorId);
  if (colorUsedLineKeys) {
    colorUsedLineKeys.add(lineKey);
  }
}

function getUndirectedLineCacheKey(firstNailNumber, secondNailNumber) {
  return firstNailNumber < secondNailNumber
    ? `${firstNailNumber}-${secondNailNumber}`
    : `${secondNailNumber}-${firstNailNumber}`;
}

function getStaticLineGeometryMetric(originIndex, targetNail) {
  const cacheKey = getUndirectedLineCacheKey(originIndex, targetNail.number);
  const cachedMetric = state.staticLineGeometryByKey.get(cacheKey);
  if (cachedMetric) {
    return cachedMetric;
  }

  const firstNailNumber = Math.min(originIndex, targetNail.number);
  const secondNailNumber = Math.max(originIndex, targetNail.number);
  const lineGeometry = buildLineGeometryForIndexes(
    state.nails[firstNailNumber - 1],
    state.nails[secondNailNumber - 1],
  );
  const lineClipPolygon = getLineClipPolygonFromGeometry(lineGeometry);
  const lineBounds = getBoundsForPoints(lineClipPolygon);
  const totalCoverage = getPolygonArea(lineClipPolygon);
  const metric = {
    lineGeometry,
    lineClipPolygon,
    lineBounds,
    totalCoverage,
    hasDrawableGeometry:
      lineGeometry.length > 0 &&
      totalCoverage > GEOMETRY_AREA_EPSILON &&
      Boolean(lineBounds),
  };
  state.staticLineGeometryByKey.set(cacheKey, metric);
  return metric;
}

function getStaticLineMetricForColor(originIndex, targetNail, colorId) {
  const cacheKey = getUndirectedLineCacheKey(originIndex, targetNail.number);
  let colorCache = state.staticLineMetricsByColorId.get(colorId);
  if (!colorCache) {
    colorCache = new Map();
    state.staticLineMetricsByColorId.set(colorId, colorCache);
  }

  const cachedMetric = colorCache.get(cacheKey);
  if (cachedMetric) {
    return cachedMetric;
  }

  const lineGeometryMetric = getStaticLineGeometryMetric(originIndex, targetNail);
  const targetGeometryIndex = state.targetGeometryIndexesByColorId.get(colorId);
  const targetOverlapCoverage =
    !lineGeometryMetric.hasDrawableGeometry ||
    !targetGeometryIndex
      ? 0
      : getLineOverlapAreaWithGeometryIndex(
          lineGeometryMetric.lineClipPolygon,
          lineGeometryMetric.lineBounds,
          targetGeometryIndex,
        );

  const metric = {
    lineGeometry: lineGeometryMetric.lineGeometry,
    lineClipPolygon: lineGeometryMetric.lineClipPolygon,
    lineBounds: lineGeometryMetric.lineBounds,
    totalCoverage: lineGeometryMetric.totalCoverage,
    targetOverlapCoverage,
  };
  colorCache.set(cacheKey, metric);
  return metric;
}

function addProfileMs(profile, key, startedAt) {
  if (!profile || !startedAt) {
    return;
  }
  profile[key] = (profile[key] ?? 0) + (performance.now() - startedAt);
}

function getBestLineForColor(originIndex, colorId, usedLineKeys, minimumAllowedDistance, profile) {
  const acceptedStripIndex = state.acceptedStripIndexesByColorId.get(colorId);
  const usesLocalCurrentIndex =
    state.currentOverlapMode === 'candidate-local' ||
    state.currentOverlapMode === 'fragment-index';
  const currentGeometryIndex = state.currentGeometryIndexesByColorId.get(colorId);
  if (state.solverMode !== 'bitset-prototype' && (usesLocalCurrentIndex ? !acceptedStripIndex : !currentGeometryIndex)) {
    return null;
  }

  let bestLine = null;
  const bitsetState = state.bitsetState;
  const targetBits = bitsetState?.targetMaskByColorId.get(colorId);
  const paintedBits = bitsetState?.paintedMaskByColorId.get(colorId);
  for (const targetNail of state.nails) {
    profile.candidateCount += 1;
    const lineKey = getNormalizedLineKey(originIndex, targetNail.number);
    if (!lineKey || usedLineKeys.has(lineKey)) {
      profile.usedLineSkipCount += 1;
      continue;
    }

    if (
      minimumAllowedDistance > 0 &&
        getCircularNailDistance(targetNail.number, originIndex, state.nailsCount) <= minimumAllowedDistance
      ) {
      profile.distanceSkipCount += 1;
      continue;
    }

    if (state.solverMode === 'bitset-prototype') {
      const bitsetBuildStartedAt = performance.now();
      const lineGeometryMetric = getStaticLineGeometryMetric(originIndex, targetNail);
      addProfileMs(profile, 'staticMetricMs', bitsetBuildStartedAt);
      if (!lineGeometryMetric.hasDrawableGeometry) {
        profile.noTargetOverlapSkipCount += 1;
        continue;
      }

      const bitsetMetric = getOrBuildLineBitsetMetric(
        lineKey,
        lineGeometryMetric.lineGeometry,
        lineGeometryMetric.lineBounds,
      );
      if (!bitsetMetric || !targetBits || !paintedBits) {
        profile.noTargetOverlapSkipCount += 1;
        continue;
      }

      profile.currentOverlapCandidateCount += 1;
      const bitsetScoreStartedAt = performance.now();
      const targetGain = bitsetAndNotPopcount(bitsetMetric.mask, targetBits, paintedBits);
      addProfileMs(profile, 'currentOverlapMs', bitsetScoreStartedAt);
      if (targetGain <= GEOMETRY_AREA_EPSILON) {
        profile.fullyPaintedSkipCount += 1;
        continue;
      }

      const flippedCoverage = targetGain;
      const score = flippedCoverage / lineGeometryMetric.totalCoverage;
      if (
        !bestLine ||
        score > bestLine.score ||
        (score === bestLine.score && flippedCoverage > bestLine.flippedCoverage)
      ) {
        bestLine = {
          endNailNumber: targetNail.number,
          score,
          flippedPixelCount: Math.max(0, Math.round(flippedCoverage)),
          flippedCoverage,
          pixelCount: Math.max(0, Math.round(lineGeometryMetric.totalCoverage)),
          coverageTotal: lineGeometryMetric.totalCoverage,
          lineBitsetMetric: bitsetMetric,
        };
      }
      continue;
    }

    const staticMetricStartedAt = performance.now();
    const {
      lineClipPolygon,
      lineGeometry,
      lineBounds,
      totalCoverage,
      targetOverlapCoverage,
    } = getStaticLineMetricForColor(originIndex, targetNail, colorId);
    addProfileMs(profile, 'staticMetricMs', staticMetricStartedAt);
    if (targetOverlapCoverage <= GEOMETRY_AREA_EPSILON) {
      profile.noTargetOverlapSkipCount += 1;
      continue;
    }

    profile.currentOverlapCandidateCount += 1;
    const currentOverlapStartedAt = performance.now();
    const alreadyPaintedCoverage =
      state.solverMode === 'bitset-prototype'
        ? 0
        : state.currentOverlapMode === 'candidate-local'
        ? getLineOverlapAreaWithAcceptedPaintedStrips(
            lineGeometry,
            lineBounds,
            colorId,
            profile,
          )
        : state.currentOverlapMode === 'fragment-index'
          ? getLineOverlapAreaWithAcceptedFragmentIndex(
              lineClipPolygon,
              lineBounds,
              colorId,
              profile,
            )
        : getLineOverlapAreaWithGeometryIndex(
            lineClipPolygon,
            lineBounds,
            currentGeometryIndex,
          );
    addProfileMs(profile, 'currentOverlapMs', currentOverlapStartedAt);
    const bitsetMetric =
      state.solverMode === 'bitset-prototype'
        ? getOrBuildLineBitsetMetric(lineKey, lineClipPolygon, lineBounds)
        : null;
    const bitsetTargetGain =
      state.solverMode === 'bitset-prototype'
        ? getBitsetTargetGain(colorId, bitsetMetric)
        : 0;
    const flippedCoverage = state.solverMode === 'bitset-prototype'
      ? bitsetTargetGain
      : Math.max(0, targetOverlapCoverage - alreadyPaintedCoverage);
    if (flippedCoverage <= GEOMETRY_AREA_EPSILON) {
      profile.fullyPaintedSkipCount += 1;
      continue;
    }

    const score = flippedCoverage / totalCoverage;
    if (
      !bestLine ||
      score > bestLine.score ||
      (score === bestLine.score && flippedCoverage > bestLine.flippedCoverage)
    ) {
      bestLine = {
        endNailNumber: targetNail.number,
        score,
        flippedPixelCount: Math.max(0, Math.round(flippedCoverage)),
        flippedCoverage,
        pixelCount: Math.max(0, Math.round(totalCoverage)),
        coverageTotal: totalCoverage,
      };
    }
  }

  return bestLine;
}

function applyWorkerLineToGeometry(colorId, startNailNumber, endNailNumber, profile) {
  const buildLineStartedAt = performance.now();
  const lineGeometry = buildLineGeometryForIndexes(
    state.nails[startNailNumber - 1],
    state.nails[endNailNumber - 1],
  );
  addProfileMs(profile, 'stateBuildLineGeometryMs', buildLineStartedAt);
  if (lineGeometry.length === 0) {
    return;
  }

  if (state.solverMode === 'bitset-prototype') {
    const lineKey = getNormalizedLineKey(startNailNumber, endNailNumber);
    const lineBounds = getBoundsForPoints(getOpenRingPoints(lineGeometry?.[0]?.[0] ?? []));
    const bitsetMetric = getOrBuildLineBitsetMetric(lineKey, lineGeometry, lineBounds);
    applyLineToBitsetPaint(colorId, bitsetMetric);
    return;
  }

  const targetGeometry = state.targetGeometriesByColorId.get(colorId);
  const currentGeometry = state.currentGeometriesByColorId.get(colorId) ?? [];
  if (!targetGeometry) {
    return;
  }

  const intersectionStartedAt = performance.now();
  const paintedGeometry = geometryIntersection(lineGeometry, targetGeometry);
  addProfileMs(profile, 'stateIntersectionMs', intersectionStartedAt);
  if (paintedGeometry.length === 0) {
    return;
  }

  const indexStartedAt = performance.now();
  let indexedGeometry = paintedGeometry;
  if (state.currentOverlapMode === 'fragment-index') {
    const differenceStartedAt = performance.now();
    indexedGeometry = geometryDifference(paintedGeometry, currentGeometry);
    addProfileMs(profile, 'stateFragmentDifferenceMs', differenceStartedAt);
  }
  addAcceptedPaintedStripToIndex(colorId, indexedGeometry);
  addProfileMs(profile, 'stateAcceptedStripIndexMs', indexStartedAt);

  if (state.currentOverlapMode === 'candidate-local') {
    return;
  }

  if (state.currentOverlapMode === 'fragment-index') {
    if (indexedGeometry.length > 0) {
      state.currentGeometriesByColorId.set(colorId, currentGeometry.concat(indexedGeometry));
    }
    return;
  }

  const unionStartedAt = performance.now();
  const nextCurrentGeometry = geometryUnion(currentGeometry, paintedGeometry);
  addProfileMs(profile, 'stateUnionMs', unionStartedAt);
  state.currentGeometriesByColorId.set(colorId, nextCurrentGeometry);
  const reindexStartedAt = performance.now();
  state.currentGeometryIndexesByColorId.set(colorId, buildGeometryAreaIndex(nextCurrentGeometry));
  addProfileMs(profile, 'stateReindexMs', reindexStartedAt);
}

function findNextSharedBestLine() {
  const profile = {
    eligibleBucketCount: 0,
    candidateCount: 0,
    usedLineSkipCount: 0,
    distanceSkipCount: 0,
    noTargetOverlapSkipCount: 0,
    currentOverlapCandidateCount: 0,
    fullyPaintedSkipCount: 0,
    getEligibleBucketsMs: 0,
    bestLineSearchMs: 0,
    staticMetricMs: 0,
    currentOverlapMs: 0,
    stateBuildLineGeometryMs: 0,
    stateIntersectionMs: 0,
    stateUnionMs: 0,
    stateReindexMs: 0,
    stateAcceptedStripIndexMs: 0,
    stateFragmentDifferenceMs: 0,
    localCurrentIntersectionMs: 0,
    localCurrentUnionMs: 0,
    localCurrentAreaMs: 0,
    fragmentCurrentClipMs: 0,
    acceptedStripQueryCandidateCount: 0,
    acceptedStripQueryHitCount: 0,
    localCurrentIntersectionHitCount: 0,
  };
  const eligibleStartedAt = performance.now();
  const eligibleBuckets = getEligibleBuckets();
  profile.getEligibleBucketsMs = performance.now() - eligibleStartedAt;
  profile.eligibleBucketCount = eligibleBuckets.length;
  if (eligibleBuckets.length === 0) {
    return { ok: false, reason: 'No eligible color buckets remain.' };
  }

  let bestCandidate = null;
  const bestLineSearchStartedAt = performance.now();
  for (const bucket of eligibleBuckets) {
    const color = state.colorsById.get(bucket.colorId);
    if (!color?.rgb) {
      continue;
    }

    const startNailNumber = getStartNailNumberForBucket(bucket);
    const minimumAllowedDistance =
      state.minDistanceMode === 'shared'
        ? state.globalMinDistance
        : bucket.minDistance;
    const bestLine = getBestLineForColor(
      startNailNumber,
      bucket.colorId,
      getUsedLineKeysForBucket(bucket),
      minimumAllowedDistance,
      profile,
    );
    if (!bestLine) {
      continue;
    }

    if (
      !bestCandidate ||
      bestLine.score > bestCandidate.score ||
      (bestLine.score === bestCandidate.score && bestLine.flippedCoverage > bestCandidate.flippedCoverage)
    ) {
      bestCandidate = {
        bucket,
        color,
        startNailNumber,
        endNailNumber: bestLine.endNailNumber,
        score: bestLine.score,
        flippedPixelCount: bestLine.flippedPixelCount,
        flippedCoverage: bestLine.flippedCoverage,
        pixelCount: bestLine.pixelCount,
        coverageTotal: bestLine.coverageTotal,
        lineDarknessStep:
          state.lineStrengthMode === 'shared'
            ? state.globalLineStrength
            : bucket.lineStrength,
      };
    }
  }
  profile.bestLineSearchMs = performance.now() - bestLineSearchStartedAt;

  if (!bestCandidate) {
    return { ok: false, reason: 'No valid line candidate was found.' };
  }

  const nextStepOrder = state.nextStepOrder;
  state.nextStepOrder += 1;
  bestCandidate.bucket.lastNailNumber = bestCandidate.endNailNumber;
  bestCandidate.bucket.lines.push({
    startNailNumber: bestCandidate.startNailNumber,
    endNailNumber: bestCandidate.endNailNumber,
    stepOrder: nextStepOrder,
  });
  bestCandidate.bucket.lineCount = getBucketLineCount(bestCandidate.bucket) + 1;
  addAcceptedLineKeyToWorkerState(
    bestCandidate.bucket.colorId,
    bestCandidate.startNailNumber,
    bestCandidate.endNailNumber,
  );
  applyWorkerLineToGeometry(
    bestCandidate.bucket.colorId,
    bestCandidate.startNailNumber,
    bestCandidate.endNailNumber,
    profile,
  );

  return {
    ok: true,
    line: {
      colorId: bestCandidate.bucket.colorId,
      colorLabel: bestCandidate.bucket.label,
      colorRgb: bestCandidate.color.rgb,
      startNailNumber: bestCandidate.startNailNumber,
      endNailNumber: bestCandidate.endNailNumber,
      lineDarknessStep: bestCandidate.lineDarknessStep,
      score: bestCandidate.score,
      flippedPixelCount: bestCandidate.flippedPixelCount,
      flippedCoverage: bestCandidate.flippedCoverage,
      pixelCount: bestCandidate.pixelCount,
      coverageTotal: bestCandidate.coverageTotal,
      stepOrder: nextStepOrder,
      totalLineCount: getTotalLineCount(),
      workerProfile: profile,
    },
  };
}

function runBatch() {
  if (!isRunning || !state) {
    return;
  }

  const batchStartedAt = performance.now();
  const budgetMs = getBatchBudgetMs();
  const shouldRunSingleStep = budgetMs <= 0;
  const lines = [];
  let stopReason = null;

  do {
    const lineStartedAt = performance.now();
    const result = findNextSharedBestLine();
    const lineEndedAt = performance.now();
    if (!result.ok) {
      stopReason = `Stopped: ${result.reason}`;
      break;
    }
    result.line.workerSolveMs = lineEndedAt - lineStartedAt;
    result.line.workerBatchOffsetMs = lineEndedAt - batchStartedAt;
    lines.push(result.line);
  } while (
    !shouldRunSingleStep &&
    performance.now() - batchStartedAt < budgetMs
  );

  if (lines.length > 0) {
    awaitingMainThreadAck = true;
    self.postMessage({
      type: 'accepted-lines',
      lines,
      wasHidden: isHidden,
      workerTimestamp: Date.now(),
      workerPerformanceNow: performance.now(),
      workerBatchMs: performance.now() - batchStartedAt,
      bitsetPreview: state.solverMode === 'bitset-prototype' ? buildBitsetPreviewSnapshot() : null,
    });
  }

  if (stopReason) {
    isRunning = false;
    awaitingMainThreadAck = false;
    self.postMessage({
      type: 'stopped',
      reason: stopReason,
      workerTimestamp: Date.now(),
      workerPerformanceNow: performance.now(),
    });
    return;
  }

  scheduleTick();
}

function normalizeBucket(rawBucket) {
  return {
    colorId: rawBucket.colorId,
    label: rawBucket.label,
    hex: rawBucket.hex,
    enabled: Boolean(rawBucket.enabled),
    visible: Boolean(rawBucket.visible),
    lineStrength: rawBucket.lineStrength,
    minDistance: rawBucket.minDistance,
    lastNailNumber: rawBucket.lastNailNumber,
    lines: Array.isArray(rawBucket.lines) ? rawBucket.lines : [],
    lineCount: rawBucket.lineCount ?? rawBucket.lines?.length ?? 0,
  };
}

function buildUsedLineKeyState(buckets, monochromeUsedLineKeys) {
  const sharedUsedLineKeys = new Set(monochromeUsedLineKeys);
  const usedLineKeysByColorId = new Map(
    buckets.map((bucket) => [bucket.colorId, new Set(monochromeUsedLineKeys)]),
  );

  for (const bucket of buckets) {
    const colorUsedLineKeys = usedLineKeysByColorId.get(bucket.colorId);
    for (const line of bucket.lines) {
      const lineKey = getNormalizedLineKey(line.startNailNumber, line.endNailNumber);
      if (!lineKey) {
        continue;
      }
      sharedUsedLineKeys.add(lineKey);
      colorUsedLineKeys?.add(lineKey);
    }
  }

  return { sharedUsedLineKeys, usedLineKeysByColorId };
}

function initializeSolver(payload) {
  const targetGeometriesByColorId = new Map(payload.targetGeometriesByColorId ?? []);
  const currentGeometriesByColorId = new Map(
    (payload.colors ?? []).map((color) => [color.id, []]),
  );
  let targetWorldBounds = null;
  for (const geometry of targetGeometriesByColorId.values()) {
    targetWorldBounds = expandBounds(targetWorldBounds, getBoundsForGeometry(geometry));
  }
  const acceptedStripIndexesByColorId = new Map(
    (payload.colors ?? []).map((color) => [color.id, createAcceptedStripIndex(targetWorldBounds)]),
  );
  const buckets = (payload.buckets ?? []).map(normalizeBucket);
  const monochromeUsedLineKeys = payload.monochromeUsedLineKeys ?? [];
  const {
    sharedUsedLineKeys,
    usedLineKeysByColorId,
  } = buildUsedLineKeyState(buckets, monochromeUsedLineKeys);
  state = {
    nails: payload.nails ?? [],
    nailsCount: payload.nailsCount ?? 0,
    previewSize: payload.previewSize ?? 0,
    imageCenter: payload.imageCenter ?? { x: 0, y: 0 },
    imageScale: payload.imageScale ?? 1,
    lineWidthPx: payload.lineWidthPx ?? 0.65,
    fallbackStartNailNumber: payload.fallbackStartNailNumber ?? 1,
    colorsById: new Map((payload.colors ?? []).map((color) => [color.id, color])),
    targetGeometriesByColorId,
    targetGeometryIndexesByColorId: new Map(
      Array.from(targetGeometriesByColorId.entries()).map(([colorId, geometry]) => [
        colorId,
        buildGeometryAreaIndex(geometry),
      ]),
    ),
    currentGeometriesByColorId,
    currentGeometryIndexesByColorId: new Map(
      Array.from(currentGeometriesByColorId.entries()).map(([colorId, geometry]) => [
        colorId,
        buildGeometryAreaIndex(geometry),
      ]),
    ),
    acceptedStripIndexesByColorId,
    staticLineGeometryByKey: new Map(),
    staticLineMetricsByColorId: new Map(),
    buckets,
    plannedLinesByColorId: new Map(payload.plannedLinesByColorId ?? []),
    monochromeUsedLineKeys,
    sharedUsedLineKeys,
    usedLineKeysByColorId,
    usedLineExclusionMode: payload.usedLineExclusionMode ?? 'shared',
    lineStrengthMode: payload.lineStrengthMode ?? 'shared',
    minDistanceMode: payload.minDistanceMode ?? 'shared',
    globalLineStrength: payload.globalLineStrength ?? 30,
    globalMinDistance: payload.globalMinDistance ?? 15,
    currentOverlapMode: payload.currentOverlapMode ?? 'global-union',
    solverMode: payload.solverMode === 'bitset-prototype' ? 'bitset-prototype' : 'exact-global-union',
    lineBitsetMetricByLineKey: new Map(),
    bitsetState: null,
    nextStepOrder: payload.nextStepOrder ?? 1,
  };

  if (state.solverMode === 'bitset-prototype' && targetWorldBounds) {
    const gridSize = Number.isFinite(payload.bitsetGridSize) ? Math.max(64, Math.floor(payload.bitsetGridSize)) : BITSET_DEFAULT_GRID_SIZE;
    const cellCount = gridSize * gridSize;
    const wordCount = Math.ceil(cellCount / BITSET_WORD_BITS);
    const cellSizeX = Math.max((targetWorldBounds.maxX - targetWorldBounds.minX) / gridSize, Number.EPSILON);
    const cellSizeY = Math.max((targetWorldBounds.maxY - targetWorldBounds.minY) / gridSize, Number.EPSILON);
    const targetMaskByColorId = new Map();
    const paintedMaskByColorId = new Map();
    const bitsetState = {
      gridSize,
      cellCount,
      wordCount,
      cellSizeX,
      cellSizeY,
      bounds: targetWorldBounds,
      targetMaskByColorId,
      paintedMaskByColorId,
    };
    state.bitsetState = bitsetState;
    for (const [colorId, geometry] of targetGeometriesByColorId.entries()) {
      const targetMask = createPackedBitset(cellCount);
      for (const polygon of geometry ?? []) {
        const outer = getOpenRingPoints(polygon?.[0] ?? []);
        const bounds = getBoundsForPoints(outer);
        const metric = rasterizePolygonToMask(outer, bounds, bitsetState);
        if (!metric) continue;
        for (let i = 0; i < metric.mask.length; i += 1) {
          targetMask[i] |= metric.mask[i];
        }
      }
      targetMaskByColorId.set(colorId, targetMask);
      paintedMaskByColorId.set(colorId, createPackedBitset(cellCount));
    }
  }

  for (const bucket of state.buckets) {
    for (const line of bucket.lines) {
      applyWorkerLineToGeometry(bucket.colorId, line.startNailNumber, line.endNailNumber);
    }
  }

}

self.onmessage = (event) => {
  const message = event.data ?? {};

  if (message.type === 'init') {
    initializeSolver(message.payload ?? {});
    self.postMessage({
      type: 'initialized',
      bitsetPreview: state.solverMode === 'bitset-prototype' ? buildBitsetPreviewSnapshot() : null,
    });
    return;
  }

  if (message.type === 'start') {
    isRunning = true;
    isHidden = Boolean(message.isHidden);
    awaitingMainThreadAck = false;
    scheduleTick(0);
    return;
  }

  if (message.type === 'stop') {
    isRunning = false;
    awaitingMainThreadAck = false;
    clearTickTimer();
    return;
  }

  if (message.type === 'continue') {
    awaitingMainThreadAck = false;
    if (isRunning && state) {
      scheduleTick(0);
    }
    return;
  }

  if (message.type === 'visibility') {
    isHidden = Boolean(message.isHidden);
    if (isRunning) {
      scheduleTick(0);
    }
  }
};
