import polygonClipping from './vendor/polygon-clipping.bundle.esm.js';

export const VECTOR_WHITE_REGION_ID = '__white__';
export const VECTOR_BLACK_REGION_ID = '__black__';

const DEFAULT_BOARD_CENTER = 50;
const DEFAULT_BOARD_RADIUS = 50;
const DEFAULT_BOARD_SIDES = 256;
const BOOLEAN_SNAP_SCALES = [1e6, 1e5, 1e4, 1e3];

let hasLoggedBooleanFallbackWarning = false;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyMultiPolygon(geometry) {
  return Array.isArray(geometry) && geometry.length > 0;
}

function isSamePoint(firstPoint, secondPoint) {
  return (
    Array.isArray(firstPoint) &&
    Array.isArray(secondPoint) &&
    firstPoint[0] === secondPoint[0] &&
    firstPoint[1] === secondPoint[1]
  );
}

function closeRing(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return [];
  }

  const nextPoints = points.map((point) => [point[0], point[1]]);
  const firstPoint = nextPoints[0];
  const lastPoint = nextPoints[nextPoints.length - 1];
  if (
    firstPoint[0] !== lastPoint[0] ||
    firstPoint[1] !== lastPoint[1]
  ) {
    nextPoints.push([firstPoint[0], firstPoint[1]]);
  }
  return nextPoints;
}

function snapCoordinate(value, scale) {
  return Math.round(value * scale) / scale;
}

function normalizeRingForBoolean(ring, scale) {
  if (!Array.isArray(ring) || ring.length < 3) {
    return null;
  }

  const snapped = [];
  for (const point of ring) {
    if (!Array.isArray(point) || point.length < 2) {
      continue;
    }
    const nextPoint = [
      snapCoordinate(point[0], scale),
      snapCoordinate(point[1], scale),
    ];
    const previousPoint = snapped[snapped.length - 1];
    if (!previousPoint || !isSamePoint(previousPoint, nextPoint)) {
      snapped.push(nextPoint);
    }
  }

  if (snapped.length < 3) {
    return null;
  }

  const closedRing = closeRing(snapped);
  if (closedRing.length < 4) {
    return null;
  }
  return closedRing;
}

function normalizeMultiPolygonForBoolean(multiPolygon, scale) {
  if (!isNonEmptyMultiPolygon(multiPolygon)) {
    return [];
  }

  const normalizedMultiPolygon = [];
  for (const polygon of multiPolygon) {
    if (!Array.isArray(polygon) || polygon.length === 0) {
      continue;
    }

    const normalizedPolygon = [];
    for (const ring of polygon) {
      const normalizedRing = normalizeRingForBoolean(ring, scale);
      if (normalizedRing) {
        normalizedPolygon.push(normalizedRing);
      }
    }

    if (normalizedPolygon.length > 0) {
      normalizedMultiPolygon.push(normalizedPolygon);
    }
  }

  return normalizedMultiPolygon;
}

function runBooleanOperation(operationName, firstGeometry, secondGeometry) {
  if (operationName === 'union') {
    return polygonClipping.union(firstGeometry, secondGeometry);
  }
  if (operationName === 'difference') {
    return polygonClipping.difference(firstGeometry, secondGeometry);
  }
  return polygonClipping.intersection(firstGeometry, secondGeometry);
}

function runSafeBooleanOperation(operationName, firstGeometry, secondGeometry, fallbackGeometry) {
  try {
    const result = runBooleanOperation(operationName, firstGeometry, secondGeometry);
    return isNonEmptyMultiPolygon(result) ? result : [];
  } catch (baseError) {
    for (const scale of BOOLEAN_SNAP_SCALES) {
      try {
        const normalizedFirst = normalizeMultiPolygonForBoolean(firstGeometry, scale);
        const normalizedSecond = normalizeMultiPolygonForBoolean(secondGeometry, scale);
        const result = runBooleanOperation(operationName, normalizedFirst, normalizedSecond);
        return isNonEmptyMultiPolygon(result) ? result : [];
      } catch {
        continue;
      }
    }

    if (!hasLoggedBooleanFallbackWarning) {
      hasLoggedBooleanFallbackWarning = true;
      console.warn(
        '[vectorColorRegions] boolean operation fallback activated after retries',
        operationName,
        baseError,
      );
    }
    return fallbackGeometry;
  }
}

function pointsStringToMultiPolygon(pointsString) {
  if (typeof pointsString !== 'string') {
    return [];
  }

  const rawPoints = pointsString
    .trim()
    .split(/\s+/)
    .map((entry) => entry.split(',').map((value) => Number.parseFloat(value)))
    .filter(
      (point) =>
        point.length >= 2 &&
        isFiniteNumber(point[0]) &&
        isFiniteNumber(point[1]),
    )
    .map((point) => [point[0], point[1]]);
  if (rawPoints.length < 3) {
    return [];
  }

  return [[closeRing(rawPoints)]];
}

function buildCircleBoardMultiPolygon(
  centerX = DEFAULT_BOARD_CENTER,
  centerY = DEFAULT_BOARD_CENTER,
  radius = DEFAULT_BOARD_RADIUS,
  sideCount = DEFAULT_BOARD_SIDES,
) {
  const sides = Math.max(24, Math.floor(sideCount));
  const ring = [];
  for (let sideIndex = 0; sideIndex < sides; sideIndex += 1) {
    const angle = (sideIndex / sides) * Math.PI * 2;
    ring.push([
      centerX + Math.cos(angle) * radius,
      centerY + Math.sin(angle) * radius,
    ]);
  }
  return [[closeRing(ring)]];
}

export function geometryUnion(firstGeometry, secondGeometry) {
  if (!isNonEmptyMultiPolygon(firstGeometry)) {
    return isNonEmptyMultiPolygon(secondGeometry) ? secondGeometry : [];
  }
  if (!isNonEmptyMultiPolygon(secondGeometry)) {
    return firstGeometry;
  }
  return runSafeBooleanOperation('union', firstGeometry, secondGeometry, firstGeometry);
}

export function geometryDifference(subjectGeometry, clipGeometry) {
  if (!isNonEmptyMultiPolygon(subjectGeometry)) {
    return [];
  }
  if (!isNonEmptyMultiPolygon(clipGeometry)) {
    return subjectGeometry;
  }
  return runSafeBooleanOperation('difference', subjectGeometry, clipGeometry, subjectGeometry);
}

export function geometryIntersection(firstGeometry, secondGeometry) {
  if (!isNonEmptyMultiPolygon(firstGeometry) || !isNonEmptyMultiPolygon(secondGeometry)) {
    return [];
  }
  return runSafeBooleanOperation('intersection', firstGeometry, secondGeometry, []);
}

function getRingArea(ring) {
  if (!Array.isArray(ring) || ring.length < 3) {
    return 0;
  }

  let doubleArea = 0;
  for (let pointIndex = 0; pointIndex < ring.length - 1; pointIndex += 1) {
    const [x1, y1] = ring[pointIndex];
    const [x2, y2] = ring[pointIndex + 1];
    doubleArea += (x1 * y2) - (x2 * y1);
  }
  return Math.abs(doubleArea) / 2;
}

export function getMultiPolygonArea(multiPolygon) {
  if (!isNonEmptyMultiPolygon(multiPolygon)) {
    return 0;
  }

  let totalArea = 0;
  for (const polygon of multiPolygon) {
    if (!Array.isArray(polygon) || polygon.length === 0) {
      continue;
    }
    const outerArea = getRingArea(polygon[0]);
    let holeArea = 0;
    for (let holeIndex = 1; holeIndex < polygon.length; holeIndex += 1) {
      holeArea += getRingArea(polygon[holeIndex]);
    }
    totalArea += Math.max(0, outerArea - holeArea);
  }
  return totalArea;
}

export function computeExactColorRegions({
  artLineSegments,
  paletteColors,
  boardCenterX = DEFAULT_BOARD_CENTER,
  boardCenterY = DEFAULT_BOARD_CENTER,
  boardRadius = DEFAULT_BOARD_RADIUS,
  boardSides = DEFAULT_BOARD_SIDES,
} = {}) {
  const boardGeometry = buildCircleBoardMultiPolygon(
    boardCenterX,
    boardCenterY,
    boardRadius,
    boardSides,
  );
  const regionGeometryById = new Map();
  regionGeometryById.set(VECTOR_WHITE_REGION_ID, boardGeometry);
  regionGeometryById.set(VECTOR_BLACK_REGION_ID, []);
  for (const color of paletteColors ?? []) {
    if (!regionGeometryById.has(color.id)) {
      regionGeometryById.set(color.id, []);
    }
  }

  for (const lineSegment of artLineSegments ?? []) {
    const lineGeometry = pointsStringToMultiPolygon(lineSegment?.polygonPoints);
    if (!isNonEmptyMultiPolygon(lineGeometry)) {
      continue;
    }

    const clippedLineGeometry = geometryIntersection(lineGeometry, boardGeometry);
    if (!isNonEmptyMultiPolygon(clippedLineGeometry)) {
      continue;
    }

    for (const [regionId, currentGeometry] of regionGeometryById.entries()) {
      regionGeometryById.set(regionId, geometryDifference(currentGeometry, clippedLineGeometry));
    }

    const paintedRegionId = lineSegment?.colorId ?? VECTOR_BLACK_REGION_ID;
    const paintedGeometry = regionGeometryById.get(paintedRegionId) ?? [];
    regionGeometryById.set(
      paintedRegionId,
      geometryUnion(paintedGeometry, clippedLineGeometry),
    );
  }

  const totalArea = getMultiPolygonArea(boardGeometry);
  const areasById = new Map();
  for (const [regionId, regionGeometry] of regionGeometryById.entries()) {
    areasById.set(regionId, getMultiPolygonArea(regionGeometry));
  }

  return {
    totalArea,
    areasById,
    geometriesById: regionGeometryById,
  };
}

export function multiPolygonToSvgPathData(multiPolygon) {
  if (!isNonEmptyMultiPolygon(multiPolygon)) {
    return '';
  }

  const commands = [];
  for (const polygon of multiPolygon) {
    if (!Array.isArray(polygon) || polygon.length === 0) {
      continue;
    }
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 3) {
        continue;
      }
      const firstPoint = ring[0];
      commands.push(`M ${firstPoint[0]} ${firstPoint[1]}`);
      for (let pointIndex = 1; pointIndex < ring.length; pointIndex += 1) {
        const point = ring[pointIndex];
        commands.push(`L ${point[0]} ${point[1]}`);
      }
      commands.push('Z');
    }
  }
  return commands.join(' ');
}
