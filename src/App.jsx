import { Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import BrushPanel from './components/BrushPanel';
import HoveredPixelOverlay from './components/HoveredPixelOverlay';
import MulticolorLab from './components/MulticolorLab';
import PreviewWorkspace from './components/PreviewWorkspace';
import {
  buildArtLineSegments,
  buildLinePolygonSegments,
  buildManualArtLineSegments,
  buildNails,
  getDraggedImageCenter,
  getDraggedPreviewOffset,
  getImagePointFromPreviewPoint,
  getPreviewCoordinatesForPixel as getPreviewCoordinatesForPixelFromState,
  getPreviewFramePoint as getPreviewFramePointForElement,
  getZoomFactor,
  getZoomedImageState,
  getZoomedPreviewState,
  isPreviewPointInsideCircle,
} from './previewMath';
import {
  clamp,
  createPixelGroup,
  getCircularNailDistance,
  getLinearPixelIndex,
  getNormalizedLineKey,
  getPixelDarkness,
  writeProcessedImageData,
} from './stringArtMath';
import { createLineCoverageEngine } from './lineCoverageEngine';
import {
  allocateWholeUnitsByWeight,
  allocateWholeUnitsByWeightWithLock,
  blurMaskImageData,
  clonePalettePreset,
  countPixelsByCurrentPaletteSource,
  countPixelsByNearestPaletteColor,
  createPaletteMaskImageCollection,
  createPalettePreviewImageData,
  createPaletteRegionGeometries,
  drawImageDataToCanvas,
  findBestFitPaletteColors,
  hexToRgb,
  isImagePixelInsidePreviewCircle,
  getNearestPaletteMatch,
  MULTICOLOR_PALETTE_PRESETS,
  rgbToOklab,
} from './multicolor';
import {
  computeExactColorRegions,
  geometryIntersection,
  geometryUnion,
  multiPolygonToSvgPathData,
  VECTOR_BLACK_REGION_ID,
  VECTOR_WHITE_REGION_ID,
} from './vectorColorRegions';

const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
const MIN_PREVIEW_SCALE = 50;
const MAX_PREVIEW_SCALE = 1000;
const INITIAL_PREVIEW_SCALE = 150;
const INITIAL_IMAGE_SCALE_MULTIPLIER = 1;
const DEFAULT_LINE_STRENGTH = 30;
const DEFAULT_HIGHLIGHT_DISTANCE = 15;
const MIN_HIGHLIGHT_DISTANCE = 0;
const MAX_HIGHLIGHT_DISTANCE = 50;
const MIN_LINE_STRENGTH = 1;
const MAX_LINE_STRENGTH = 50;
const DEFAULT_THREAD_WIDTH_PX = 0.65;
const MIN_THREAD_WIDTH_PX = 0.15;
const MAX_THREAD_WIDTH_PX = 3;
const MIN_CONTRAST = 0;
const MAX_CONTRAST = 100;
const SHARED_LOOP_ART_BUCKET_FLUSH_INTERVAL_MS = 1000;

function getMulticolorBucketLineCount(bucket) {
  return bucket?.lineCount ?? getPackedLineCount(bucket?.linesPacked);
}

function getMulticolorBucketTotalLineCount(buckets) {
  return buckets.reduce(
    (sum, bucket) => sum + getMulticolorBucketLineCount(bucket),
    0,
  );
}

function buildLineGeometryForIndexes(startNail, endNail, previewSize, imageCenter, imageScale, lineWidthPx) {
  if (!startNail || !endNail || !imageCenter || !Number.isFinite(previewSize) || previewSize <= 0) {
    return [];
  }

  const startPreviewX = (startNail.cx / 100) * previewSize;
  const startPreviewY = (startNail.cy / 100) * previewSize;
  const endPreviewX = (endNail.cx / 100) * previewSize;
  const endPreviewY = (endNail.cy / 100) * previewSize;
  const startImageX = imageCenter.x + (startPreviewX - previewSize / 2) / imageScale;
  const startImageY = imageCenter.y + (startPreviewY - previewSize / 2) / imageScale;
  const endImageX = imageCenter.x + (endPreviewX - previewSize / 2) / imageScale;
  const endImageY = imageCenter.y + (endPreviewY - previewSize / 2) / imageScale;
  const safeWidth = Math.max(0.001, Number.isFinite(lineWidthPx) ? lineWidthPx : 0.5);
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

  const ux = dx / length;
  const uy = dy / length;
  const nx = -uy;
  const ny = ux;
  return [[[
    [startImageX + nx * half, startImageY + ny * half],
    [endImageX + nx * half, endImageY + ny * half],
    [endImageX - nx * half, endImageY - ny * half],
    [startImageX - nx * half, startImageY - ny * half],
    [startImageX + nx * half, startImageY + ny * half],
  ]]];
}

const GEOMETRY_AREA_EPSILON = 1e-9;

function isFiniteGeometryPoint(point) {
  return (
    Array.isArray(point) &&
    point.length >= 2 &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1])
  );
}

function getOpenRingPoints(ring) {
  if (!Array.isArray(ring)) {
    return [];
  }

  const points = ring
    .filter(isFiniteGeometryPoint)
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

function getLineClipPolygonFromGeometry(lineGeometry) {
  const ring = lineGeometry?.[0]?.[0];
  return getOpenRingPoints(ring);
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

function getLineOverlapAreaWithGeometryIndex(lineClipPolygon, lineBounds, geometryIndex, metrics = null) {
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
    if (metrics) {
      metrics.scannedPolygons += 1;
    }
    if (!doBoundsOverlap(lineBounds, indexedPolygon.bounds)) {
      continue;
    }

    if (metrics) {
      metrics.boundsHits += 1;
      metrics.clippedRings += 1;
    }
    let polygonArea = getConvexClippedArea(indexedPolygon.outerRing, lineClipPolygon);
    if (polygonArea <= GEOMETRY_AREA_EPSILON) {
      continue;
    }

    for (const hole of indexedPolygon.holeRings) {
      if (!doBoundsOverlap(lineBounds, hole.bounds)) {
        continue;
      }
      if (metrics) {
        metrics.clippedRings += 1;
      }
      polygonArea -= getConvexClippedArea(hole.ring, lineClipPolygon);
    }
    totalArea += Math.max(0, polygonArea);
  }

  return totalArea;
}
const DEFAULT_CONTRAST = 100;
const DEFAULT_MULTICOLOR_TARGET_TOTAL_LINES = 20000;
const DEFAULT_PALETTE_FINDER_COLOR_COUNT = 4;
const MIN_PALETTE_FINDER_COLOR_COUNT = 2;
const MAX_PALETTE_FINDER_COLOR_COUNT = 12;
const MIN_BRUSH_RADIUS = 1;
const MAX_BRUSH_RADIUS = 40;
const MIN_GROUP_VALUE = 0;
const MAX_GROUP_VALUE = 10;
const GROUP_VALUE_STEP = 0.05;
const CURRENT_WHITE_COLOR_INDEX = 254;
const TARGET_NONE_COLOR_INDEX = 255;
const DEFAULT_LINE_COVERAGE_BACKEND = 'area';
const LINE_COVERAGE_BACKENDS = [
  { id: 'raster', label: 'raster' },
  { id: 'area', label: 'area' },
];
const HOVER_DOT_SAMPLE_OFFSETS = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
];
const GROUP_COLORS = [
  '#0ea5e9',
  '#f97316',
  '#22c55e',
  '#e11d48',
  '#8b5cf6',
  '#facc15',
];
const EMPTY_EXACT_COLOR_AREA_STATS = Object.freeze({
  totalArea: 0,
  stats: [],
  geometriesById: new Map(),
});

function parseThreadWidthPxValue(threadWidthValue) {
  const parsedThreadWidth = Number.parseFloat(threadWidthValue);
  return Number.isFinite(parsedThreadWidth)
    ? clamp(parsedThreadWidth, MIN_THREAD_WIDTH_PX, MAX_THREAD_WIDTH_PX)
    : DEFAULT_THREAD_WIDTH_PX;
}

function createMulticolorLineBuckets(
  paletteColors,
  defaultLineStrength = DEFAULT_LINE_STRENGTH,
  defaultMinDistance = DEFAULT_HIGHLIGHT_DISTANCE,
) {
  return paletteColors.map((color) => ({
    colorId: color.id,
    label: color.label,
    hex: color.hex,
    enabled: color.enabled,
    visible: true,
    lineStrength: defaultLineStrength,
    minDistance: defaultMinDistance,
    lastNailNumber: null,
    linesPacked: new Uint16Array(0),
    lineCount: 0,
  }));
}

function isPackedLineBuffer(linesPacked) {
  return Array.isArray(linesPacked) || ArrayBuffer.isView(linesPacked);
}

function getPackedLineCount(linesPacked) {
  return Math.floor((linesPacked?.length ?? 0) / 3);
}

function appendPackedLine(linesPacked, startNailNumber, endNailNumber, stepOrder) {
  const source = isPackedLineBuffer(linesPacked)
    ? linesPacked
    : new Uint16Array(0);
  const nextPacked = new Uint16Array(source.length + 3);
  nextPacked.set(source, 0);
  nextPacked[source.length] = clamp(startNailNumber, 0, 65535);
  nextPacked[source.length + 1] = clamp(endNailNumber, 0, 65535);
  nextPacked[source.length + 2] = clamp(stepOrder, 0, 65535);
  return nextPacked;
}

function forEachPackedLine(linesPacked, callback) {
  if (!isPackedLineBuffer(linesPacked) || linesPacked.length === 0) {
    return;
  }
  for (let index = 0; index + 2 < linesPacked.length; index += 3) {
    callback({
      startNailNumber: linesPacked[index],
      endNailNumber: linesPacked[index + 1],
      stepOrder: linesPacked[index + 2],
      packedIndex: index / 3,
    }, index / 3);
  }
}

function slicePackedLines(linesPacked, startLineIndex, lineCount) {
  if (!isPackedLineBuffer(linesPacked) || lineCount <= 0) {
    return new Uint16Array(0);
  }
  const start = Math.max(0, startLineIndex) * 3;
  const end = start + Math.max(0, lineCount) * 3;
  return linesPacked.slice(start, end);
}

function splitWholeUnits(totalUnits, groupCount) {
  if (groupCount <= 0) {
    return [];
  }

  const baseUnits = Math.floor(totalUnits / groupCount);
  let remainder = totalUnits % groupCount;

  return Array.from({ length: groupCount }, () => {
    const nextUnits = baseUnits + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return nextUnits;
  });
}

function moveArrayItem(items, fromIndex, toIndex) {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

function getNormalizedInterleaveEntryIds(currentEntryIds, availableEntryIds) {
  const availableEntryIdSet = new Set(availableEntryIds);
  const retainedEntryIds = currentEntryIds.filter((entryId) => availableEntryIdSet.has(entryId));
  const retainedEntryIdSet = new Set(retainedEntryIds);

  for (const entryId of availableEntryIds) {
    if (!retainedEntryIdSet.has(entryId)) {
      retainedEntryIds.push(entryId);
    }
  }

  return retainedEntryIds;
}

function areStringArraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function pickDominantIndexByWeight(weightByIndexMap) {
  let bestIndex = null;
  let bestWeight = -1;
  for (const [index, weight] of weightByIndexMap.entries()) {
    if (weight > bestWeight) {
      bestWeight = weight;
      bestIndex = index;
    }
  }
  return bestIndex;
}


function App() {
  const [imageName, setImageName] = useState('');
  const [imageSize, setImageSize] = useState(null);
  const [cropToCircle, setCropToCircle] = useState(true);
  const [isBlackAndWhite, setIsBlackAndWhite] = useState(true);
  const [showNailNumbers, setShowNailNumbers] = useState(true);
  const [nailsCount, setNailsCount] = useState(300);
  const [lineFrom, setLineFrom] = useState('1');
  const [lineTo, setLineTo] = useState('1');
  const [highlightRange, setHighlightRange] = useState(String(DEFAULT_HIGHLIGHT_DISTANCE));
  const [lineStrength, setLineStrength] = useState(String(DEFAULT_LINE_STRENGTH));
  const [threadWidth, setThreadWidth] = useState(String(DEFAULT_THREAD_WIDTH_PX));
  const [contrast, setContrast] = useState(String(DEFAULT_CONTRAST));
  const [savedNailSequence, setSavedNailSequence] = useState([]);
  const [isArtMode, setIsArtMode] = useState(false);
  const [isPerformingSteps, setIsPerformingSteps] = useState(false);
  const [isStepLoopPaused, setIsStepLoopPaused] = useState(false);
  const [hiddenPreviewLineKey, setHiddenPreviewLineKey] = useState(null);
  const [isMinimumDarknessExpanded, setIsMinimumDarknessExpanded] = useState(false);
  const [imageScale, setImageScale] = useState(INITIAL_IMAGE_SCALE_MULTIPLIER);
  const [previewScale, setPreviewScale] = useState(INITIAL_PREVIEW_SCALE);
  const [imageCenter, setImageCenter] = useState({ x: 0, y: 0 });
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 });
  const [dragState, setDragState] = useState(null);
  const [hoveredPixel, setHoveredPixel] = useState(null);
  const [isBrushMode, setIsBrushMode] = useState(false);
  const [brushRadius, setBrushRadius] = useState(6);
  const [pixelGroups, setPixelGroups] = useState([createPixelGroup(1, GROUP_COLORS)]);
  const [activeGroupId, setActiveGroupId] = useState('group-1');
  const [nextGroupNumber, setNextGroupNumber] = useState(2);
  const [isMulticolorLabEnabled, setIsMulticolorLabEnabled] = useState(true);
  const [multicolorDebugView, setMulticolorDebugView] = useState('original');
  const [multicolorPalettePresetId, setMulticolorPalettePresetId] = useState(
    MULTICOLOR_PALETTE_PRESETS[0].id,
  );
  const [multicolorPaletteColors, setMulticolorPaletteColors] = useState(() =>
    clonePalettePreset(MULTICOLOR_PALETTE_PRESETS[0]).colors,
  );
  const [isPalettePreviewEnabled, setIsPalettePreviewEnabled] = useState(true);
  const [isPaletteDitheringEnabled, setIsPaletteDitheringEnabled] = useState(true);
  const [multicolorPalettePixelCounts, setMulticolorPalettePixelCounts] = useState([]);
  const [multicolorPaletteCoverage, setMulticolorPaletteCoverage] = useState([]);
  const [multicolorLockedLineOverride, setMulticolorLockedLineOverride] = useState(null);
  const [multicolorPaletteFinderColorCount, setMulticolorPaletteFinderColorCount] = useState(
    DEFAULT_PALETTE_FINDER_COLOR_COUNT,
  );
  const [multicolorTargetTotalLines, setMulticolorTargetTotalLines] = useState(
    DEFAULT_MULTICOLOR_TARGET_TOTAL_LINES,
  );
  const [activePaletteColorId, setActivePaletteColorId] = useState(
    MULTICOLOR_PALETTE_PRESETS[0].colors[0].id,
  );
  const [isActivePaletteColorOnlyEnabled, setIsActivePaletteColorOnlyEnabled] = useState(false);
  const [maskBlurRadius, setMaskBlurRadius] = useState(0);
  const [multicolorLineBuckets, setMulticolorLineBuckets] = useState(() =>
    createMulticolorLineBuckets(
      MULTICOLOR_PALETTE_PRESETS[0].colors,
      DEFAULT_LINE_STRENGTH,
      DEFAULT_HIGHLIGHT_DISTANCE,
    ),
  );
  const [isExperimentalColorLinesOnlyPreviewEnabled, setIsExperimentalColorLinesOnlyPreviewEnabled] = useState(false);
  const [multicolorExperimentalSteppingMode, setMulticolorExperimentalSteppingMode] = useState('shared-best');
  const [multicolorRoundRobinNextColorId, setMulticolorRoundRobinNextColorId] = useState(null);
  const [multicolorMaskImages, setMulticolorMaskImages] = useState([]);
  const [activeMulticolorTargetImage, setActiveMulticolorTargetImage] = useState(null);
  const [multicolorUsedLineExclusionMode, setMulticolorUsedLineExclusionMode] = useState('shared');
  const [multicolorLineStrengthMode, setMulticolorLineStrengthMode] = useState('shared');
  const [multicolorMinDistanceMode, setMulticolorMinDistanceMode] = useState('shared');
  const [isMulticolorStepProfilingEnabled, setIsMulticolorStepProfilingEnabled] = useState(false);
  const [isMulticolorFastSteppingEnabled, setIsMulticolorFastSteppingEnabled] = useState(false);
  const [lineCoverageBackendId, setLineCoverageBackendId] = useState(DEFAULT_LINE_COVERAGE_BACKEND);
  const [multicolorInterleaveEntryIds, setMulticolorInterleaveEntryIds] = useState([]);
  const [sharedStateNextColorLabel, setSharedStateNextColorLabel] = useState(null);
  const [isSharedStateLoopRunning, setIsSharedStateLoopRunning] = useState(false);
  const [sharedStateLoopStatus, setSharedStateLoopStatus] = useState('');
  const [sharedLoopVisibleLineCount, setSharedLoopVisibleLineCount] = useState(null);
  const SHOW_BRUSH_PANEL = false;
  const [isWhiteTestOverlayEnabled, setIsWhiteTestOverlayEnabled] = useState(false);

  const previewRef = useRef(null);
  const imageRef = useRef(null);
  const selectionOverlayRef = useRef(null);
  const imageCanvasRef = useRef(null);
  const imageScaleRef = useRef(INITIAL_IMAGE_SCALE_MULTIPLIER);
  const previewScaleRef = useRef(INITIAL_PREVIEW_SCALE);
  const imageCenterRef = useRef({ x: 0, y: 0 });
  const previewOffsetRef = useRef({ x: 0, y: 0 });
  const originalComparisonCanvasRef = useRef(null);
  const paletteComparisonCanvasRef = useRef(null);
  const ditheredComparisonCanvasRef = useRef(null);
  const nailsRef = useRef([]);
  const multicolorLineBucketsRef = useRef(multicolorLineBuckets);
  const committedMulticolorLineBucketsRef = useRef(multicolorLineBuckets);
  const multicolorInterleaveEntryIdsRef = useRef(multicolorInterleaveEntryIds);
  const originalImageDataRef = useRef(null);
  const activeColorMaskScoringImageDataRef = useRef(null);
  const sourceUrlRef = useRef(null);
  const animationFrameRef = useRef(null);
  const isMountedRef = useRef(true);
  const pauseRequestedRef = useRef(false);
  const pixelWeightMapRef = useRef(null);
  const lineCoverageEngineRef = useRef(
    createLineCoverageEngine({
      backendId: DEFAULT_LINE_COVERAGE_BACKEND,
      threadWidthPx: DEFAULT_THREAD_WIDTH_PX,
    }),
  );
  const sharedStateLineCoverageEngineRef = useRef(
    createLineCoverageEngine({ backendId: 'raster' }),
  );
  const lineBoostMapRef = useRef(null);
  const usedLineKeysRef = useRef(new Set());
  const currentCanvasRevisionRef = useRef(0);
  const currentCanvasMaskCollectionCacheRef = useRef({ key: '', masks: [] });
  const pendingMulticolorStepProfileRef = useRef(null);
  const skipNextActiveTargetImageEffectRef = useRef(false);
  const pixelOwnerMapRef = useRef(null);
  const groupPixelsRef = useRef(new Map([[1, new Set()]]));
  const multicolorLineStepOrderRef = useRef(1);
  const sharedTargetColorIndexMapRef = useRef(null);
  const sharedCurrentColorIndexMapRef = useRef(null);
  const sharedColorIdToIndexRef = useRef(new Map());
  const sharedTargetMapCacheKeyRef = useRef('');
  const sharedTargetRegionGeometriesRef = useRef(new Map());
  const sharedCurrentRegionGeometriesRef = useRef(new Map());
  const sharedTargetRegionGeometryIndexesRef = useRef(new Map());
  const sharedCurrentRegionGeometryIndexesRef = useRef(new Map());
  const sharedLoopVisibleLineCountRef = useRef(null);
  const sharedLoopLastBucketFlushAtRef = useRef(0);
  const sharedLoopBucketStateFlushPendingRef = useRef(false);
  const sharedStateLoopStopRequestedRef = useRef(false);
  const sharedStateLoopRunningRef = useRef(false);
  const sharedLoopWorkerRef = useRef(null);
  const sharedLoopWorkerMessageHandlerRef = useRef(null);
  const isArtModeRef = useRef(false);
  const multicolorExperimentalSteppingModeRef = useRef(multicolorExperimentalSteppingMode);
  const applyExperimentalStepRef = useRef(() => ({
    ok: false,
    reason: 'Step handler is not ready.',
  }));
  const hasAutoLoadedDefaultImageRef = useRef(false);
  const previewSize = previewRef.current?.clientWidth ?? 0;
  const hasLoadedImage = Boolean(imageCanvasRef.current && imageSize);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      if (sourceUrlRef.current) {
        URL.revokeObjectURL(sourceUrlRef.current);
      }
      sharedStateLoopStopRequestedRef.current = true;
      sharedStateLoopRunningRef.current = false;
      sharedLoopWorkerRef.current?.postMessage({ type: 'stop' });
      sharedLoopWorkerRef.current?.terminate();
      sharedLoopWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    multicolorExperimentalSteppingModeRef.current = multicolorExperimentalSteppingMode;
  }, [multicolorExperimentalSteppingMode]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const recordVisibility = (eventType) => {
      window.__sharedLoopVisibilityEvents = window.__sharedLoopVisibilityEvents ?? [];
      window.__sharedLoopVisibilityEvents.push({
        eventType,
        hidden: document.hidden,
        timestamp: Date.now(),
        performanceNow: performance.now(),
        lineCount: sharedLoopVisibleLineCountRef.current,
      });
    };

    const handleVisibilityChange = () => {
      recordVisibility('visibilitychange');
      sharedLoopWorkerRef.current?.postMessage({
        type: 'visibility',
        isHidden: document.hidden,
      });
    };

    recordVisibility('mount');
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    lineCoverageEngineRef.current = createLineCoverageEngine({
      backendId: lineCoverageBackendId,
      threadWidthPx: parseThreadWidthPxValue(threadWidth),
    });
  }, [lineCoverageBackendId, threadWidth]);

  useEffect(() => {
    setHiddenPreviewLineKey(null);
  }, [lineFrom, lineTo]);

  useEffect(() => {
    imageScaleRef.current = imageScale;
  }, [imageScale]);

  useEffect(() => {
    previewScaleRef.current = previewScale;
  }, [previewScale]);

  useEffect(() => {
    imageCenterRef.current = imageCenter;
  }, [imageCenter]);

  useEffect(() => {
    previewOffsetRef.current = previewOffset;
  }, [previewOffset]);

  useEffect(() => {
    lineCoverageEngineRef.current.clearCache();
    sharedStateLineCoverageEngineRef.current.clearCache();
  }, [
    imageSize,
    nailsCount,
    previewSize,
    imageScale,
    imageCenter.x,
    imageCenter.y,
    threadWidth,
  ]);

  const multicolorPalettePreset = MULTICOLOR_PALETTE_PRESETS.find(
    (preset) => preset.id === multicolorPalettePresetId,
  ) ?? {
    id: multicolorPalettePresetId,
    name: 'Custom palette',
    colors: multicolorPaletteColors,
  };
  const enabledPaletteColors = useMemo(
    () => multicolorPaletteColors.filter((color) => color.enabled),
    [multicolorPaletteColors],
  );
  const enabledPalettePreviewColors = useMemo(
    () =>
      enabledPaletteColors
        .map((color) => ({
          ...color,
          rgb: hexToRgb(color.hex),
        }))
        .filter((color) => color.rgb)
        .map((color) => ({
          ...color,
          oklab: rgbToOklab(color.rgb.r, color.rgb.g, color.rgb.b),
        })),
    [enabledPaletteColors],
  );
  const activePaletteColor = multicolorPaletteColors.find((color) => color.id === activePaletteColorId) ?? null;
  const activePalettePreviewColor = enabledPalettePreviewColors.find(
    (color) => color.id === activePaletteColorId,
  ) ?? null;
  const canUseActiveColorMaskForLineScoring =
    isMulticolorLabEnabled &&
    isPalettePreviewEnabled &&
    Boolean(imageSize) &&
    Boolean(activePalettePreviewColor);
  const isActiveColorMaskScoringEnabled =
    multicolorDebugView === 'color-mask' &&
    canUseActiveColorMaskForLineScoring;
  const lineScoringModeLabel = isActiveColorMaskScoringEnabled
    ? `active color mask${activePaletteColor ? ` (${activePaletteColor.label})` : ''}`
    : 'grayscale';
  const multicolorPalettePixelCountMap = new Map(
    multicolorPalettePixelCounts.map((color) => [color.id, color.pixelCount]),
  );
  const totalPaletteCoverageTenths = multicolorPaletteCoverage.reduce(
    (sum, color) => sum + color.percentageTenths,
    0,
  );
  const multicolorPaletteCoverageWithSuggestions = allocateWholeUnitsByWeight(
    multicolorPaletteCoverage,
    multicolorTargetTotalLines,
    (color) => color.pixelCount,
  );
  const lockedColorSuggestion = multicolorPaletteCoverageWithSuggestions.find(
    (color) => color.id === multicolorLockedLineOverride?.colorId,
  );
  const normalizedLockedLineOverride =
    multicolorLockedLineOverride && lockedColorSuggestion
      ? {
          id: multicolorLockedLineOverride.colorId,
          allocatedUnits: clamp(
            multicolorLockedLineOverride.lineCount,
            0,
            multicolorTargetTotalLines,
          ),
        }
      : null;
  const multicolorPaletteCoverageWithLineAllocation = allocateWholeUnitsByWeightWithLock(
    multicolorPaletteCoverage,
    multicolorTargetTotalLines,
    (color) => color.pixelCount,
    normalizedLockedLineOverride,
  );
  const plannedMulticolorLinesByColorId = new Map(
    multicolorPaletteCoverageWithLineAllocation.map((color) => [color.id, color.allocatedUnits]),
  );
  const totalAllocatedSuggestedLines = multicolorPaletteCoverageWithLineAllocation.reduce(
    (sum, color) => sum + color.allocatedUnits,
    0,
  );
  const activeMulticolorLineBucket = multicolorLineBuckets.find(
    (bucket) => bucket.colorId === activePaletteColorId,
  ) ?? null;
  const enabledMulticolorLineBuckets = multicolorLineBuckets.filter((bucket) => bucket.enabled);
  const totalExperimentalMulticolorLines = getMulticolorBucketTotalLineCount(multicolorLineBuckets);
  const displayedTotalExperimentalMulticolorLines =
    sharedLoopVisibleLineCount ?? totalExperimentalMulticolorLines;
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.__totalLineCountCommitEvents = window.__totalLineCountCommitEvents ?? [];
    window.__totalLineCountCommitEvents.push({
      count: displayedTotalExperimentalMulticolorLines,
      timestamp: Date.now(),
      performanceNow: performance.now(),
      source: sharedLoopVisibleLineCount === null ? 'bucket-state' : 'shared-loop-counter',
    });
  }, [displayedTotalExperimentalMulticolorLines]);
  const getRemainingPlannedLinesForBucket = (bucket) =>
    Math.max(
      0,
      (plannedMulticolorLinesByColorId.get(bucket.colorId) ?? 0) -
        (bucket.lineCount ?? getPackedLineCount(bucket.linesPacked)),
    );
  const eligibleMulticolorStepBuckets = enabledMulticolorLineBuckets.filter(
    (bucket) => getRemainingPlannedLinesForBucket(bucket) > 0,
  );
  const interleaveEligibleBuckets = multicolorLineBuckets.filter(
    (bucket) =>
      (plannedMulticolorLinesByColorId.get(bucket.colorId) ?? 0) > 0 ||
      (bucket.lineCount ?? getPackedLineCount(bucket.linesPacked)) > 0,
  );
  const readOnlyInterleavePassCount = 2;
  const defaultMulticolorInterleaveEntries = useMemo(() => {
    if (interleaveEligibleBuckets.length === 0) {
      return [];
    }

    const order = [];
    const plannedSlicesByColorId = new Map(
      interleaveEligibleBuckets.map((bucket) => [
        bucket.colorId,
        splitWholeUnits(
          plannedMulticolorLinesByColorId.get(bucket.colorId) ?? 0,
          readOnlyInterleavePassCount,
        ),
      ]),
    );

    for (let passIndex = 0; passIndex < readOnlyInterleavePassCount; passIndex += 1) {
      for (const bucket of interleaveEligibleBuckets) {
        const plannedSlices = plannedSlicesByColorId.get(bucket.colorId) ?? [];
        order.push({
          id: `${bucket.colorId}-pass-${passIndex + 1}`,
          colorId: bucket.colorId,
          label: bucket.label,
          hex: bucket.hex,
          passIndex: passIndex + 1,
          plannedLines: plannedSlices[passIndex] ?? 0,
        });
      }
    }

    return order;
  }, [
    interleaveEligibleBuckets,
    plannedMulticolorLinesByColorId,
    readOnlyInterleavePassCount,
  ]);
  const multicolorInterleaveEntryMap = useMemo(
    () => new Map(defaultMulticolorInterleaveEntries.map((entry) => [entry.id, entry])),
    [defaultMulticolorInterleaveEntries],
  );
  const multicolorInterleaveOrder = useMemo(() => {
    const defaultEntryIds = defaultMulticolorInterleaveEntries.map((entry) => entry.id);
    const normalizedEntryIds = getNormalizedInterleaveEntryIds(
      multicolorInterleaveEntryIds,
      defaultEntryIds,
    );

    return normalizedEntryIds
      .map((entryId) => multicolorInterleaveEntryMap.get(entryId))
      .filter(Boolean);
  }, [
    defaultMulticolorInterleaveEntries,
    multicolorInterleaveEntryIds,
    multicolorInterleaveEntryMap,
  ]);
  const activeMaskImage = multicolorMaskImages.find(
    (color) => color.id === activePaletteColorId,
  ) ?? null;
  const blurredActiveMaskImage = activeMaskImage?.imageData
    ? blurMaskImageData(activeMaskImage.imageData, maskBlurRadius)
    : null;
  const activeMulticolorPlannedLineCount =
    plannedMulticolorLinesByColorId.get(activePaletteColorId) ?? 0;
  const activeMulticolorRemainingLineCount = activeMulticolorLineBucket
    ? getRemainingPlannedLinesForBucket(activeMulticolorLineBucket)
    : activeMulticolorPlannedLineCount;
  const parseLineDarknessStep = useCallback((lineStrengthValue) => {
    const parsedLineStrength = Number.parseInt(lineStrengthValue, 10);
    return Number.isFinite(parsedLineStrength)
      ? clamp(parsedLineStrength, MIN_LINE_STRENGTH, MAX_LINE_STRENGTH)
      : DEFAULT_LINE_STRENGTH;
  }, []);
  const parseMinDistanceValue = useCallback((minDistanceValue) => {
    const parsedMinDistance = Number.parseInt(minDistanceValue, 10);
    return Number.isFinite(parsedMinDistance)
      ? clamp(parsedMinDistance, MIN_HIGHLIGHT_DISTANCE, MAX_HIGHLIGHT_DISTANCE)
      : DEFAULT_HIGHLIGHT_DISTANCE;
  }, []);
  const multicolorLineKeysByColorId = useMemo(
    () => new Map(
      multicolorLineBuckets.map((bucket) => [
        bucket.colorId,
        (() => {
          const nextLineKeys = new Set();
          forEachPackedLine(bucket.linesPacked, (line) => {
            const lineKey = getNormalizedLineKey(line.startNailNumber, line.endNailNumber);
            if (lineKey) {
              nextLineKeys.add(lineKey);
            }
          });
          return nextLineKeys;
        })(),
      ]),
    ),
    [multicolorLineBuckets],
  );
  const monochromeUsedLineKeys = useMemo(() => {
    const nextUsedLineKeys = new Set();
    let currentStartNailNumber = 1;

    for (const nextNailNumber of savedNailSequence) {
      const lineKey = getNormalizedLineKey(currentStartNailNumber, nextNailNumber);
      if (lineKey) {
        nextUsedLineKeys.add(lineKey);
      }
      currentStartNailNumber = nextNailNumber;
    }

    return nextUsedLineKeys;
  }, [savedNailSequence]);
  const sharedMulticolorUsedLineKeys = useMemo(() => {
    const nextUsedLineKeys = new Set(monochromeUsedLineKeys);
    for (const colorUsedLineKeys of multicolorLineKeysByColorId.values()) {
      for (const lineKey of colorUsedLineKeys) {
        nextUsedLineKeys.add(lineKey);
      }
    }
    return nextUsedLineKeys;
  }, [monochromeUsedLineKeys, multicolorLineKeysByColorId]);
  const isActiveColorOnlyControlVisible = multicolorDebugView === 'palette-preview';
  const shouldShowOriginalDebugView =
    isMulticolorLabEnabled && multicolorDebugView === 'original';
  const shouldShowCurrentGrayscaleDebugView =
    isMulticolorLabEnabled && multicolorDebugView === 'current-grayscale';
  const shouldShowSharedResidualDebugView =
    isMulticolorLabEnabled && multicolorDebugView === 'shared-residual';
  const isPalettePreviewVisible =
    isMulticolorLabEnabled &&
    isPalettePreviewEnabled &&
    multicolorDebugView === 'palette-preview' &&
    enabledPalettePreviewColors.length > 0;
  const isPaletteMaskVisible =
    isMulticolorLabEnabled &&
    isPalettePreviewEnabled &&
    multicolorDebugView === 'color-mask' &&
    enabledPalettePreviewColors.length > 0 &&
    Boolean(activePalettePreviewColor);
  const shouldShowPaletteComparison =
    isPalettePreviewVisible &&
    Boolean(originalImageDataRef.current);
  const shouldDeferMulticolorStepVisuals =
    isMulticolorFastSteppingEnabled &&
    isMulticolorLabEnabled &&
    isPalettePreviewEnabled &&
    multicolorDebugView === 'color-mask';

  function invalidateCurrentCanvasMaskCollectionCache() {
    currentCanvasRevisionRef.current += 1;
    currentCanvasMaskCollectionCacheRef.current = { key: '', masks: [] };
  }

  function getCurrentCanvasMaskCollection() {
    if (
      !imageSize ||
      enabledPalettePreviewColors.length === 0 ||
      !imageCanvasRef.current
    ) {
      return [];
    }

    const paletteKey = enabledPalettePreviewColors
      .map((color) => `${color.id}:${color.hex}`)
      .join('|');
    const cacheKey = [
      currentCanvasRevisionRef.current,
      isPaletteDitheringEnabled ? 'dithered' : 'nearest',
      paletteKey,
    ].join('|');
    if (currentCanvasMaskCollectionCacheRef.current.key === cacheKey) {
      return currentCanvasMaskCollectionCacheRef.current.masks;
    }

    const context = imageCanvasRef.current.getContext('2d', { willReadFrequently: true });
    const canvasImageData = context?.getImageData(0, 0, imageSize.width, imageSize.height);
    if (!canvasImageData) {
      return [];
    }

    const masks = createPaletteMaskImageCollection(
      canvasImageData,
      enabledPalettePreviewColors,
      isPaletteDitheringEnabled,
    );
    currentCanvasMaskCollectionCacheRef.current = {
      key: cacheKey,
      masks,
    };
    return masks;
  }

  function createMulticolorStepProfile(meta) {
    if (!isMulticolorStepProfilingEnabled) {
      return null;
    }

    return {
      startedAt: performance.now(),
      handlerEndAt: null,
      layoutCommitAt: null,
      rows: [],
      reactProfiles: [],
      meta,
      measure(bucket, callback) {
        const startTime = performance.now();
        const result = callback();
        this.rows.push({
          bucket,
          ms: performance.now() - startTime,
        });
        return result;
      },
    };
  }

  function measurePendingMulticolorRender(bucket, callback) {
    const pendingProfile = pendingMulticolorStepProfileRef.current;
    if (!pendingProfile) {
      return callback();
    }

    const startTime = performance.now();
    const result = callback();
    pendingProfile.rows.push({
      bucket: `render ${bucket}`,
      ms: performance.now() - startTime,
    });
    return result;
  }

  function measurePendingMulticolorEffect(bucket, callback) {
    const pendingProfile = pendingMulticolorStepProfileRef.current;
    if (!pendingProfile) {
      return callback();
    }

    const startTime = performance.now();
    const result = callback();
    pendingProfile.rows.push({
      bucket: `effect ${bucket}`,
      ms: performance.now() - startTime,
    });
    return result;
  }

  const buildColorMaskScoringImageData = useCallback((colorId, sourceImageData = null) => {
    if (!imageSize || enabledPalettePreviewColors.length === 0 || !colorId) {
      return null;
    }

    const targetColorIndexMap = sharedTargetColorIndexMapRef.current;
    const currentColorIndexMap = sharedCurrentColorIndexMapRef.current;
    const targetColorIndex = sharedColorIdToIndexRef.current.get(colorId);
    if (
      targetColorIndexMap &&
      currentColorIndexMap &&
      Number.isInteger(targetColorIndex)
    ) {
      const nextData = new Uint8ClampedArray(imageSize.width * imageSize.height * 4);
      for (let pixelIndex = 0, offset = 0; pixelIndex < targetColorIndexMap.length; pixelIndex += 1, offset += 4) {
        const isTargetColor = targetColorIndexMap[pixelIndex] === targetColorIndex;
        const isAlreadyCurrentColor = currentColorIndexMap[pixelIndex] === targetColorIndex;
        const value = isTargetColor && !isAlreadyCurrentColor ? 0 : 255;
        nextData[offset] = value;
        nextData[offset + 1] = value;
        nextData[offset + 2] = value;
        nextData[offset + 3] = 255;
      }
      return new ImageData(nextData, imageSize.width, imageSize.height);
    }

    if (!sourceImageData) {
      return null;
    }

    const fallbackPaletteMaskImage = createPalettePreviewImageData(
      sourceImageData,
      enabledPalettePreviewColors,
      isPaletteDitheringEnabled,
      colorId,
      false,
    );
    if (!fallbackPaletteMaskImage) {
      return null;
    }

    const nearestColor = enabledPalettePreviewColors.find((color) => color.id === colorId);
    if (!nearestColor?.rgb) {
      return null;
    }

    const nextData = new Uint8ClampedArray(fallbackPaletteMaskImage.data.length);
    for (let offset = 0; offset < fallbackPaletteMaskImage.data.length; offset += 4) {
      const isMatch =
        fallbackPaletteMaskImage.data[offset] === nearestColor.rgb.r &&
        fallbackPaletteMaskImage.data[offset + 1] === nearestColor.rgb.g &&
        fallbackPaletteMaskImage.data[offset + 2] === nearestColor.rgb.b &&
        fallbackPaletteMaskImage.data[offset + 3] > 0;
      const value = isMatch ? 0 : 255;
      nextData[offset] = value;
      nextData[offset + 1] = value;
      nextData[offset + 2] = value;
      nextData[offset + 3] = 255;
    }
    return new ImageData(nextData, fallbackPaletteMaskImage.width, fallbackPaletteMaskImage.height);
  }, [
    imageSize,
    enabledPalettePreviewColors,
    isPaletteDitheringEnabled,
  ]);

  const buildActiveColorMaskScoringImageData = useCallback((sourceImageData = null) => {
    if (!activePalettePreviewColor) {
      return null;
    }

    return buildColorMaskScoringImageData(activePalettePreviewColor.id, sourceImageData);
  }, [activePalettePreviewColor, buildColorMaskScoringImageData]);

  const buildColorRawMaskImageData = useCallback((colorId) => {
    if (!imageSize || !colorId) {
      return null;
    }

    const targetColorIndexMap = sharedTargetColorIndexMapRef.current;
    const targetColorIndex = sharedColorIdToIndexRef.current.get(colorId);
    if (!targetColorIndexMap || !Number.isInteger(targetColorIndex)) {
      return null;
    }

    const nextData = new Uint8ClampedArray(imageSize.width * imageSize.height * 4);
    for (let pixelIndex = 0, offset = 0; pixelIndex < targetColorIndexMap.length; pixelIndex += 1, offset += 4) {
      const value = targetColorIndexMap[pixelIndex] === targetColorIndex ? 0 : 255;
      nextData[offset] = value;
      nextData[offset + 1] = value;
      nextData[offset + 2] = value;
      nextData[offset + 3] = 255;
    }

    return new ImageData(nextData, imageSize.width, imageSize.height);
  }, [imageSize]);

  useEffect(() => {
    const currentActiveColor = multicolorPaletteColors.find((color) => color.id === activePaletteColorId);
    if (currentActiveColor?.enabled) {
      return;
    }

    const firstEnabledColor = multicolorPaletteColors.find((color) => color.enabled);
    if (firstEnabledColor) {
      setActivePaletteColorId(firstEnabledColor.id);
      return;
    }

    if (multicolorPaletteColors.length > 0 && activePaletteColorId !== multicolorPaletteColors[0].id) {
      setActivePaletteColorId(multicolorPaletteColors[0].id);
    }
  }, [activePaletteColorId, multicolorPaletteColors]);

  useEffect(() => {
    setMulticolorLineBuckets((currentBuckets) => {
      const currentBucketsByColorId = new Map(
        currentBuckets.map((bucket) => [bucket.colorId, bucket]),
      );

      return multicolorPaletteColors.map((color) => {
        const existingBucket = currentBucketsByColorId.get(color.id);
        return {
          colorId: color.id,
          label: color.label,
          hex: color.hex,
          enabled: color.enabled,
          visible: existingBucket?.visible ?? true,
          lineStrength: existingBucket?.lineStrength ?? parseLineDarknessStep(lineStrength),
          minDistance: existingBucket?.minDistance ?? parseMinDistanceValue(highlightRange),
          lastNailNumber: existingBucket?.lastNailNumber ?? null,
          linesPacked: existingBucket?.linesPacked ?? new Uint16Array(0),
          lineCount:
            existingBucket?.lineCount ??
            getPackedLineCount(existingBucket?.linesPacked ?? new Uint16Array(0)),
        };
      });
    });
  }, [highlightRange, lineStrength, multicolorPaletteColors, parseLineDarknessStep, parseMinDistanceValue]);

  useEffect(() => {
    const availableEntryIds = defaultMulticolorInterleaveEntries.map((entry) => entry.id);
    const normalizedEntryIds = getNormalizedInterleaveEntryIds(
      multicolorInterleaveEntryIdsRef.current,
      availableEntryIds,
    );
    if (areStringArraysEqual(normalizedEntryIds, multicolorInterleaveEntryIdsRef.current)) {
      return;
    }
    multicolorInterleaveEntryIdsRef.current = normalizedEntryIds;
    setMulticolorInterleaveEntryIds(normalizedEntryIds);
  }, [defaultMulticolorInterleaveEntries]);

  useEffect(() => {
    multicolorInterleaveEntryIdsRef.current = multicolorInterleaveEntryIds;
  }, [multicolorInterleaveEntryIds]);

  useEffect(() => {
    if (eligibleMulticolorStepBuckets.length === 0) {
      setMulticolorRoundRobinNextColorId(null);
      return;
    }

    const nextRoundRobinColorStillEligible = eligibleMulticolorStepBuckets.some(
      (bucket) => bucket.colorId === multicolorRoundRobinNextColorId,
    );
    if (!nextRoundRobinColorStillEligible) {
      setMulticolorRoundRobinNextColorId(
        eligibleMulticolorStepBuckets.find((bucket) => bucket.colorId === activePaletteColorId)?.colorId ??
        eligibleMulticolorStepBuckets[0].colorId,
      );
    }
  }, [
    activePaletteColorId,
    eligibleMulticolorStepBuckets,
    multicolorRoundRobinNextColorId,
  ]);

  useEffect(() => {
    const maxStepOrder = multicolorLineBuckets.reduce((bucketMaximumOrder, bucket) => {
      let bucketMax = 0;
      forEachPackedLine(bucket.linesPacked, (line) => {
        if (Number.isInteger(line.stepOrder)) {
          bucketMax = Math.max(bucketMax, line.stepOrder);
        }
      });
      return Math.max(bucketMaximumOrder, bucketMax);
    }, 0);
    multicolorLineStepOrderRef.current = maxStepOrder + 1;
  }, [multicolorLineBuckets]);

  useEffect(() => {
    if (!isActiveColorMaskScoringEnabled) {
      activeColorMaskScoringImageDataRef.current = null;
      return;
    }

    activeColorMaskScoringImageDataRef.current = measurePendingMulticolorEffect(
      'active mask scoring refresh',
      buildActiveColorMaskScoringImageData,
    );
  }, [
    buildActiveColorMaskScoringImageData,
    contrast,
    imageName,
    imageSize,
    isActiveColorMaskScoringEnabled,
    isPaletteDitheringEnabled,
    isPalettePreviewEnabled,
    isMulticolorLabEnabled,
    multicolorPaletteColors,
    activePaletteColorId,
  ]);

  useEffect(() => {
    if (!canUseActiveColorMaskForLineScoring) {
      skipNextActiveTargetImageEffectRef.current = false;
      setActiveMulticolorTargetImage(null);
      return;
    }

    if (skipNextActiveTargetImageEffectRef.current) {
      skipNextActiveTargetImageEffectRef.current = false;
      measurePendingMulticolorEffect('active target refresh skipped', () => {});
      return;
    }

    const canvasImageData = measurePendingMulticolorEffect(
      'active target canvas read',
      getCanvasImageData,
    );
    const nextTargetImage = measurePendingMulticolorEffect(
      'active target rebuild',
      () => buildActiveColorMaskScoringImageData(canvasImageData),
    );
    measurePendingMulticolorEffect('active target state scheduling', () => {
      setActiveMulticolorTargetImage(nextTargetImage);
    });
  }, [
    buildActiveColorMaskScoringImageData,
    canUseActiveColorMaskForLineScoring,
    hiddenPreviewLineKey,
    imageName,
    imageSize,
    multicolorLineBuckets,
    savedNailSequence,
  ]);

  useLayoutEffect(() => {
    const pendingProfile = pendingMulticolorStepProfileRef.current;
    if (!pendingProfile || pendingProfile.layoutCommitAt !== null) {
      return;
    }

    pendingProfile.layoutCommitAt = performance.now();
  });

  useEffect(() => {
    const pendingProfile = pendingMulticolorStepProfileRef.current;
    if (!pendingProfile) {
      return;
    }

    pendingMulticolorStepProfileRef.current = null;
    const commitTime = performance.now();
    const layoutCommitMs =
      pendingProfile.layoutCommitAt === null
        ? null
        : pendingProfile.layoutCommitAt - pendingProfile.handlerEndAt;
    const paintAndPassiveWaitMs =
      pendingProfile.layoutCommitAt === null
        ? null
        : commitTime - pendingProfile.layoutCommitAt;
    const reactCommitMs = commitTime - pendingProfile.handlerEndAt;
    const totalUntilCommitMs = commitTime - pendingProfile.startedAt;
    const rows = [
      ...pendingProfile.rows,
      ...pendingProfile.reactProfiles.map((profile) => ({
        bucket: `react render ${profile.id}`,
        ms: profile.actualDuration,
      })),
      ...(layoutCommitMs === null
        ? []
        : [
            { bucket: 'react layout commit', ms: layoutCommitMs },
            { bucket: 'paint/passive wait', ms: paintAndPassiveWaitMs },
          ]),
      { bucket: 'react state commit', ms: reactCommitMs },
      { bucket: 'total through commit', ms: totalUntilCommitMs },
    ];
    const profileSummary = {
      ...pendingProfile.meta,
      rows: rows.map((row) => ({
        bucket: row.bucket,
        ms: Number(row.ms.toFixed(2)),
        ...(row.changedKeys
          ? {
              changedKeys: row.changedKeys.map((changedKey) => ({
                key: changedKey.key,
                previous: changedKey.previous,
                next: changedKey.next,
              })),
            }
          : {}),
        ...(row.details ? { details: row.details } : {}),
      })),
      handlerMs: Number((pendingProfile.handlerEndAt - pendingProfile.startedAt).toFixed(2)),
      reactCommitMs: Number(reactCommitMs.toFixed(2)),
      totalUntilCommitMs: Number(totalUntilCommitMs.toFixed(2)),
    };
    window.__multicolorStepProfiles = window.__multicolorStepProfiles ?? [];
    window.__multicolorStepProfiles.push(profileSummary);

    console.groupCollapsed(
      `[multicolor step] ${pendingProfile.meta.mode} ${pendingProfile.meta.source} ${pendingProfile.meta.colorLabel}`,
    );
    console.table(
      profileSummary.rows.map((row) => ({
        bucket: row.bucket,
        ms: row.ms,
        changed: row.changedKeys?.map((changedKey) => changedKey.key).join(', ') ?? '',
      })),
    );
    console.log(profileSummary);
    console.groupEnd();
  }, [
    activeMulticolorTargetImage,
    activePaletteColorId,
    hiddenPreviewLineKey,
    lineFrom,
    lineTo,
    multicolorLineBuckets,
    multicolorRoundRobinNextColorId,
  ]);

  const handleReactProfile = useCallback((id, phase, actualDuration, baseDuration) => {
    const pendingProfile = pendingMulticolorStepProfileRef.current;
    if (!pendingProfile) {
      return;
    }

    pendingProfile.reactProfiles.push({
      id,
      phase,
      actualDuration,
      baseDuration,
    });
  }, []);

  const handleProfileEffect = useCallback((bucket, callback) => {
    const pendingProfile = pendingMulticolorStepProfileRef.current;
    if (!pendingProfile) {
      return callback();
    }

    const startTime = performance.now();
    const result = callback();
    pendingProfile.rows.push({
      bucket: `effect ${bucket}`,
      ms: performance.now() - startTime,
    });
    return result;
  }, []);

  const handleDiagnosticRender = useCallback((componentName, changedKeys) => {
    const pendingProfile = pendingMulticolorStepProfileRef.current;
    if (!pendingProfile || changedKeys.length === 0) {
      return;
    }

    pendingProfile.rows.push({
      bucket: `render why ${componentName}`,
      ms: 0,
      changedKeys,
    });
  }, []);

  useEffect(() => {
    if (!multicolorLockedLineOverride) {
      return;
    }

    const lockedColorStillVisible = multicolorPaletteCoverageWithSuggestions.some(
      (color) => color.id === multicolorLockedLineOverride.colorId,
    );
    if (!lockedColorStillVisible) {
      setMulticolorLockedLineOverride(null);
      return;
    }

    const clampedLineCount = clamp(
      multicolorLockedLineOverride.lineCount,
      0,
      multicolorTargetTotalLines,
    );
    if (clampedLineCount !== multicolorLockedLineOverride.lineCount) {
      setMulticolorLockedLineOverride((currentOverride) =>
        currentOverride
          ? {
              ...currentOverride,
              lineCount: clampedLineCount,
            }
          : currentOverride,
      );
    }
  }, [
    multicolorLockedLineOverride,
    multicolorPaletteCoverageWithSuggestions,
    multicolorTargetTotalLines,
  ]);

  const syncVisibleCanvas = () => {
    if (!imageRef.current || !imageCanvasRef.current || !imageSize) {
      return;
    }

    const visibleContext = imageRef.current.getContext('2d');
    if (!visibleContext) {
      return;
    }

    visibleContext.clearRect(0, 0, imageSize.width, imageSize.height);
    if (shouldShowOriginalDebugView && originalImageDataRef.current) {
      visibleContext.putImageData(originalImageDataRef.current, 0, 0);
    } else {
      visibleContext.drawImage(imageCanvasRef.current, 0, 0);
    }

    if (!isPalettePreviewVisible && !isPaletteMaskVisible) {
      return;
    }

    const visibleImage = visibleContext.getImageData(0, 0, imageSize.width, imageSize.height);
    if (isPaletteMaskVisible) {
      const paletteMaskImage = buildColorMaskScoringImageData(
        activePaletteColorId,
        visibleImage,
      );
      if (paletteMaskImage) {
        visibleContext.putImageData(blurMaskImageData(paletteMaskImage, maskBlurRadius), 0, 0);
      }
      return;
    }

    const palettePreviewImage = createPalettePreviewImageData(
      visibleImage,
      enabledPalettePreviewColors,
      isPaletteDitheringEnabled,
      activePaletteColorId,
      isActivePaletteColorOnlyEnabled,
    );
    if (palettePreviewImage) {
      visibleContext.putImageData(palettePreviewImage, 0, 0);
    }
  };

  useEffect(() => {
    syncVisibleCanvas();
  }, [
    imageSize,
    isArtMode,
    isMulticolorLabEnabled,
    isPalettePreviewEnabled,
    isPaletteDitheringEnabled,
    multicolorDebugView,
    multicolorPaletteColors,
    activePaletteColorId,
    isActivePaletteColorOnlyEnabled,
    maskBlurRadius,
    shouldShowOriginalDebugView,
    shouldShowSharedResidualDebugView,
    buildColorMaskScoringImageData,
  ]);

  useEffect(() => {
    if (isPerformingSteps || !imageCanvasRef.current || !imageSize || !originalImageDataRef.current) {
      return;
    }

    const context = imageCanvasRef.current.getContext('2d', {
      willReadFrequently: true,
    });
    if (!context) {
      return;
    }

    writeProcessedImageData(
      context,
      originalImageDataRef.current,
      imageSize.width,
      imageSize.height,
      Number.parseInt(contrast, 10),
      lineBoostMapRef.current,
      MIN_CONTRAST,
      MAX_CONTRAST,
      DEFAULT_CONTRAST,
    );
    invalidateCurrentCanvasMaskCollectionCache();
    syncVisibleCanvas();
  }, [contrast, imageSize, isPerformingSteps]);

  useEffect(() => {
    if (!shouldShowPaletteComparison || !originalImageDataRef.current) {
      return;
    }

    drawImageDataToCanvas(originalComparisonCanvasRef.current, originalImageDataRef.current);
    const palettePreviewImage = createPalettePreviewImageData(
      originalImageDataRef.current,
      enabledPalettePreviewColors,
      false,
      activePaletteColorId,
      isActivePaletteColorOnlyEnabled,
    );
    drawImageDataToCanvas(paletteComparisonCanvasRef.current, palettePreviewImage);
    const ditheredPalettePreviewImage = createPalettePreviewImageData(
      originalImageDataRef.current,
      enabledPalettePreviewColors,
      true,
      activePaletteColorId,
      isActivePaletteColorOnlyEnabled,
    );
    drawImageDataToCanvas(ditheredComparisonCanvasRef.current, ditheredPalettePreviewImage);
  }, [
    shouldShowPaletteComparison,
    enabledPalettePreviewColors,
    activePaletteColorId,
    isActivePaletteColorOnlyEnabled,
  ]);

  useEffect(() => {
    if (!imageCanvasRef.current || !imageSize || enabledPalettePreviewColors.length === 0) {
      setMulticolorPalettePixelCounts([]);
      return;
    }

    const context = imageCanvasRef.current.getContext('2d', {
      willReadFrequently: true,
    });
    if (!context) {
      setMulticolorPalettePixelCounts([]);
      return;
    }

    setMulticolorPalettePixelCounts(
      countPixelsByNearestPaletteColor(
        context.getImageData(0, 0, imageSize.width, imageSize.height),
        enabledPalettePreviewColors,
        imageCenter,
        imageScale,
        previewSize,
      ),
    );
  }, [
    contrast,
    imageName,
    imageSize,
    imageCenter.x,
    imageCenter.y,
    imageScale,
    multicolorPaletteColors,
    previewSize,
  ]);

  useEffect(() => {
    if (
      !imageCanvasRef.current ||
      !imageSize ||
      enabledPalettePreviewColors.length === 0 ||
      previewSize <= 0
    ) {
      setMulticolorPaletteCoverage([]);
      return;
    }

    const context = imageCanvasRef.current.getContext('2d', {
      willReadFrequently: true,
    });
    if (!context) {
      setMulticolorPaletteCoverage([]);
      return;
    }

    const sourceImageData = context.getImageData(0, 0, imageSize.width, imageSize.height);
    setMulticolorPaletteCoverage(
      countPixelsByCurrentPaletteSource(
        sourceImageData,
        enabledPalettePreviewColors,
        isPaletteDitheringEnabled,
        imageCenter,
        imageScale,
        previewSize,
      ),
    );
  }, [
    contrast,
    imageName,
    imageSize,
    imageCenter.x,
    imageCenter.y,
    imageScale,
    isPaletteDitheringEnabled,
    multicolorPaletteColors,
    previewSize,
  ]);

  useEffect(() => {
    if (!imageSize || enabledPalettePreviewColors.length === 0) {
      setMulticolorMaskImages([]);
      return;
    }

    setMulticolorMaskImages(
      enabledPalettePreviewColors.map((color) => ({
        ...color,
        imageData: buildColorRawMaskImageData(color.id),
      })),
    );
  }, [
    buildColorRawMaskImageData,
    enabledPalettePreviewColors,
    imageSize,
  ]);

  const clearSelectionOverlay = () => {
    if (!selectionOverlayRef.current || !imageSize) {
      return;
    }

    const context = selectionOverlayRef.current.getContext('2d');
    context?.clearRect(0, 0, imageSize.width, imageSize.height);
  };

  const paintSelectionPixelsOnOverlay = (pixelIndexes, color) => {
    if (!selectionOverlayRef.current || pixelIndexes.length === 0 || !imageSize) {
      return;
    }

    const context = selectionOverlayRef.current.getContext('2d');
    if (!context) {
      return;
    }

    context.fillStyle = color;
    context.globalAlpha = 0.75;
    for (const pixelIndex of pixelIndexes) {
      const x = pixelIndex % imageSize.width;
      const y = Math.floor(pixelIndex / imageSize.width);
      context.fillRect(x, y, 1, 1);
    }
    context.globalAlpha = 1;
  };

  const eraseSelectionPixelsFromOverlay = (pixelIndexes) => {
    if (!selectionOverlayRef.current || pixelIndexes.length === 0 || !imageSize) {
      return;
    }

    const context = selectionOverlayRef.current.getContext('2d');
    if (!context) {
      return;
    }

    for (const pixelIndex of pixelIndexes) {
      const x = pixelIndex % imageSize.width;
      const y = Math.floor(pixelIndex / imageSize.width);
      context.clearRect(x, y, 1, 1);
    }
  };

  const redrawSelectionOverlay = () => {
    clearSelectionOverlay();

    if (!imageSize) {
      return;
    }

    for (const group of pixelGroups) {
      const pixelIndexes = Array.from(groupPixelsRef.current.get(group.groupNumber) ?? []);
      paintSelectionPixelsOnOverlay(pixelIndexes, group.color);
    }
  };

  const loadImageFromSource = (
    nextUrl,
    nextImageName,
    { shouldRevokeLoadedUrl = false } = {},
  ) => {
    if (!nextUrl) {
      return;
    }

    if (sourceUrlRef.current) {
      URL.revokeObjectURL(sourceUrlRef.current);
      sourceUrlRef.current = null;
    }
    if (shouldRevokeLoadedUrl) {
      sourceUrlRef.current = nextUrl;
    }

    setImageName(nextImageName || 'image');
    imageCenterRef.current = { x: 0, y: 0 };
    setImageCenter(imageCenterRef.current);
    previewScaleRef.current = INITIAL_PREVIEW_SCALE;
    setPreviewScale(INITIAL_PREVIEW_SCALE);
    previewOffsetRef.current = { x: 0, y: 0 };
    setPreviewOffset(previewOffsetRef.current);
    setHoveredPixel(null);
    setIsStepLoopPaused(false);
    setHiddenPreviewLineKey(null);
    setPixelGroups([createPixelGroup(1, GROUP_COLORS)]);
    setActiveGroupId('group-1');
    setNextGroupNumber(2);
    groupPixelsRef.current = new Map([[1, new Set()]]);
    pixelOwnerMapRef.current = null;
    pixelWeightMapRef.current = null;
    lineBoostMapRef.current = null;
    usedLineKeysRef.current = new Set();
    setMulticolorLineBuckets(
      createMulticolorLineBuckets(
        multicolorPaletteColors,
        getLineDarknessStep(),
        parseMinDistanceValue(highlightRange),
      ),
    );
    multicolorLineStepOrderRef.current = 1;
    setMulticolorLockedLineOverride(null);
    setMulticolorTargetTotalLines(DEFAULT_MULTICOLOR_TARGET_TOTAL_LINES);
    setIsExperimentalColorLinesOnlyPreviewEnabled(false);
    setMulticolorExperimentalSteppingMode('shared-best');
    setMulticolorRoundRobinNextColorId(null);
    originalImageDataRef.current = null;
    lineCoverageEngineRef.current.clearCache();
    invalidateCurrentCanvasMaskCollectionCache();
    clearSelectionOverlay();

    const img = new Image();
    img.onload = () => {
      const previewSize = previewRef.current?.clientWidth ?? 420;
      const fittedScale = Math.max(
        previewSize / img.width,
        previewSize / img.height,
      );

      setImageSize({ width: img.width, height: img.height });
      imageScaleRef.current = clamp(
        fittedScale * INITIAL_IMAGE_SCALE_MULTIPLIER,
        MIN_SCALE,
        MAX_SCALE,
      );
      setImageScale(imageScaleRef.current);
      imageCenterRef.current = {
        x: img.width / 2,
        y: img.height / 2,
      };
      setImageCenter(imageCenterRef.current);

      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context?.drawImage(img, 0, 0);
      originalImageDataRef.current = context?.getImageData(0, 0, img.width, img.height) ?? null;
      imageCanvasRef.current = canvas;
      lineBoostMapRef.current = new Uint32Array(img.width * img.height);
      pixelOwnerMapRef.current = new Int32Array(img.width * img.height);
      pixelWeightMapRef.current = new Float32Array(img.width * img.height);
      pixelWeightMapRef.current.fill(1);
      groupPixelsRef.current = new Map([[1, new Set()]]);
      if (context && originalImageDataRef.current) {
        writeProcessedImageData(
          context,
          originalImageDataRef.current,
          img.width,
          img.height,
          Number.parseInt(contrast, 10),
          lineBoostMapRef.current,
          MIN_CONTRAST,
          MAX_CONTRAST,
          DEFAULT_CONTRAST,
        );
        invalidateCurrentCanvasMaskCollectionCache();
      }
      window.requestAnimationFrame(() => {
        clearSelectionOverlay();
      });

      if (shouldRevokeLoadedUrl && sourceUrlRef.current) {
        URL.revokeObjectURL(sourceUrlRef.current);
        sourceUrlRef.current = null;
      }
    };
    img.onerror = () => {
      if (shouldRevokeLoadedUrl && sourceUrlRef.current) {
        URL.revokeObjectURL(sourceUrlRef.current);
        sourceUrlRef.current = null;
      }
    };
    img.src = nextUrl;
  };

  const handleFileChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const nextUrl = URL.createObjectURL(file);
    loadImageFromSource(nextUrl, file.name, { shouldRevokeLoadedUrl: true });
  };

  useEffect(() => {
    if (hasAutoLoadedDefaultImageRef.current) {
      return;
    }
    hasAutoLoadedDefaultImageRef.current = true;
    const defaultImageUrl = new URL('../mona_lisa.PNG', import.meta.url).href;
    loadImageFromSource(defaultImageUrl, 'mona_lisa.PNG');
  }, []);

  const getPreviewFramePoint = (clientX, clientY) => {
    return getPreviewFramePointForElement(
      previewRef.current,
      previewSize,
      clientX,
      clientY,
    );
  };

  const isPointInsideCircle = (clientX, clientY) => {
    const previewPoint = getPreviewFramePoint(clientX, clientY);
    return isPreviewPointInsideCircle(previewPoint, previewSize);
  };

  const getImagePointFromClientPosition = (clientX, clientY) => {
    const previewPoint = getPreviewFramePoint(clientX, clientY);
    return getImagePointFromPreviewPoint(
      previewPoint,
      imageSize,
      imageScale,
      imageCenter,
      previewSize,
    );
  };

  const getPreviewCoordinatesForPixel = (pixelX, pixelY) => {
    return getPreviewCoordinatesForPixelFromState(
      pixelX,
      pixelY,
      imageSize,
      previewSize,
      imageCenter,
      imageScale,
    );
  };

  const isImagePixelInsideCircle = (pixelX, pixelY) => {
    return isImagePixelInsidePreviewCircle(
      pixelX,
      pixelY,
      imageCenter,
      imageScale,
      previewSize,
    );
  };

  const getTopmostHoveredArtLine = (clientX, clientY) => {
    const previewElement = previewRef.current;
    const artLinesSvg = previewElement?.querySelector('.art-lines-layer');
    if (!artLinesSvg) {
      return null;
    }

    const polygonElements = artLinesSvg.querySelectorAll('polygon');
    if (!polygonElements || polygonElements.length === 0) {
      return null;
    }

    const screenMatrix = artLinesSvg.getScreenCTM?.();
    if (!screenMatrix) {
      return null;
    }

    let localPoint = null;
    try {
      localPoint = new DOMPoint(clientX, clientY).matrixTransform(screenMatrix.inverse());
    } catch {
      return null;
    }

    for (let lineIndex = polygonElements.length - 1; lineIndex >= 0; lineIndex -= 1) {
      const polygonElement = polygonElements[lineIndex];
      if (
        typeof polygonElement?.isPointInFill === 'function' &&
        polygonElement.isPointInFill(localPoint)
      ) {
        return artHoverLines[lineIndex] ?? null;
      }
    }

    return null;
  };

  const updateHoveredPixel = (event) => {
    if (!hasLoadedImage) {
      setHoveredPixel(null);
      return;
    }

    const imagePoint = getImagePointFromClientPosition(event.clientX, event.clientY);
    if (!imagePoint) {
      setHoveredPixel(null);
      return;
    }

    const context = imageCanvasRef.current.getContext('2d', {
      willReadFrequently: true,
    });
    const pixel = context?.getImageData(
      imagePoint.pixelColumn,
      imagePoint.pixelRow,
      1,
      1,
    ).data;

    if (!pixel) {
      setHoveredPixel(null);
      return;
    }

    const targetColorIndexMap = sharedTargetColorIndexMapRef.current;
    const currentColorIndexMap = sharedCurrentColorIndexMapRef.current;
    const isAreaCoverageMode = lineCoverageBackendId === 'area';
    const hoverDotRadiusInImagePixels = isAreaCoverageMode
      ? Math.max(0.5, (lineCoverageEngineRef.current?.threadWidthPx ?? 1) / 2)
      : 0.5;
    const hoverDotDiameterInImagePixels = hoverDotRadiusInImagePixels * 2;

    let targetColorIndex = TARGET_NONE_COLOR_INDEX;
    let currentColorIndex = CURRENT_WHITE_COLOR_INDEX;
    let currentColorLabel = 'white';
    if (targetColorIndexMap && currentColorIndexMap) {
      const targetVotes = new Map();
      const currentVotes = isArtMode ? null : new Map();
      const minX = Math.max(0, Math.floor(imagePoint.imageX - hoverDotRadiusInImagePixels - 1));
      const maxX = Math.min(imageSize.width - 1, Math.ceil(imagePoint.imageX + hoverDotRadiusInImagePixels + 1));
      const minY = Math.max(0, Math.floor(imagePoint.imageY - hoverDotRadiusInImagePixels - 1));
      const maxY = Math.min(imageSize.height - 1, Math.ceil(imagePoint.imageY + hoverDotRadiusInImagePixels + 1));
      const maxDistanceSquared = hoverDotRadiusInImagePixels * hoverDotRadiusInImagePixels;

      for (let sampleY = minY; sampleY <= maxY; sampleY += 1) {
        for (let sampleX = minX; sampleX <= maxX; sampleX += 1) {
          let sampleCoverage = 0;
          for (const [offsetX, offsetY] of HOVER_DOT_SAMPLE_OFFSETS) {
            const localX = sampleX + offsetX;
            const localY = sampleY + offsetY;
            const distanceSquared =
              (localX - imagePoint.imageX) * (localX - imagePoint.imageX) +
              (localY - imagePoint.imageY) * (localY - imagePoint.imageY);
            if (distanceSquared <= maxDistanceSquared) {
              sampleCoverage += 1;
            }
          }

          if (sampleCoverage <= 0) {
            continue;
          }

          const weight = sampleCoverage / HOVER_DOT_SAMPLE_OFFSETS.length;
          const linearPixelIndex = sampleY * imageSize.width + sampleX;
          const sampledTargetColorIndex = targetColorIndexMap[linearPixelIndex];
          if (sampledTargetColorIndex !== TARGET_NONE_COLOR_INDEX) {
            targetVotes.set(
              sampledTargetColorIndex,
              (targetVotes.get(sampledTargetColorIndex) ?? 0) + weight,
            );
            if (currentVotes) {
              const sampledCurrentColorIndex = currentColorIndexMap[linearPixelIndex];
              currentVotes.set(
                sampledCurrentColorIndex,
                (currentVotes.get(sampledCurrentColorIndex) ?? 0) + weight,
              );
            }
          }
        }
      }

      const dominantTargetColorIndex = pickDominantIndexByWeight(targetVotes);
      if (Number.isInteger(dominantTargetColorIndex)) {
        targetColorIndex = dominantTargetColorIndex;
      }
      if (currentVotes) {
        const dominantCurrentColorIndex = pickDominantIndexByWeight(currentVotes);
        if (Number.isInteger(dominantCurrentColorIndex)) {
          currentColorIndex = dominantCurrentColorIndex;
        }
      }
    }

    if (!isArtMode) {
      currentColorLabel =
        currentColorIndex === CURRENT_WHITE_COLOR_INDEX
          ? 'white'
          : currentColorIndex >= 0
            ? `#${currentColorIndex + 1}`
            : 'n/a';
    } else {
      const hoveredArtLine = getTopmostHoveredArtLine(event.clientX, event.clientY);
      if (hoveredArtLine?.colorId) {
        const paletteIndex = sharedColorIdToIndexRef.current.get(hoveredArtLine.colorId);
        if (Number.isInteger(paletteIndex)) {
          currentColorIndex = paletteIndex;
          currentColorLabel = `#${paletteIndex + 1}`;
        } else {
          const fallbackIndex = enabledPalettePreviewColors.findIndex(
            (color) => color.id === hoveredArtLine.colorId,
          );
          if (fallbackIndex >= 0) {
            currentColorIndex = fallbackIndex;
            currentColorLabel = `#${fallbackIndex + 1}`;
          } else {
            currentColorIndex = CURRENT_WHITE_COLOR_INDEX;
            currentColorLabel = 'white';
          }
        }
      } else if (hoveredArtLine) {
        currentColorIndex = CURRENT_WHITE_COLOR_INDEX;
        currentColorLabel = 'black';
      } else {
        currentColorIndex = CURRENT_WHITE_COLOR_INDEX;
        currentColorLabel = 'white';
      }
    }

    const outlineCenterX =
      previewSize / 2 + ((imagePoint.imageX + 0.5) - imageCenter.x) * imageScale;
    const outlineCenterY =
      previewSize / 2 + ((imagePoint.imageY + 0.5) - imageCenter.y) * imageScale;
    const outlineSize =
      hoverDotDiameterInImagePixels * imageScale * (imagePoint.contentRect.width / previewSize);

    setHoveredPixel({
      x: event.clientX,
      y: event.clientY,
      left:
        imagePoint.contentRect.left +
        (outlineCenterX - (hoverDotDiameterInImagePixels * imageScale) / 2) *
          (imagePoint.contentRect.width / previewSize),
      top:
        imagePoint.contentRect.top +
        (outlineCenterY - (hoverDotDiameterInImagePixels * imageScale) / 2) *
          (imagePoint.contentRect.height / previewSize),
      width: outlineSize,
      height: outlineSize,
      borderRadius: isAreaCoverageMode ? '999px' : null,
      hoverModeLabel: isAreaCoverageMode ? 'dot' : 'pixel',
      pixelX: imagePoint.pixelColumn,
      pixelY: imagePoint.pixelRow,
      r: pixel[0],
      g: pixel[1],
      b: pixel[2],
      darkness: Math.round((pixel[0] + pixel[1] + pixel[2]) / 3),
      targetColorNumber:
        targetColorIndex !== TARGET_NONE_COLOR_INDEX
          ? targetColorIndex + 1
          : null,
      currentColorNumber:
        currentColorIndex !== CURRENT_WHITE_COLOR_INDEX
          ? currentColorIndex + 1
          : null,
      isCurrentColorWhite: currentColorIndex === CURRENT_WHITE_COLOR_INDEX,
      currentColorLabel,
    });
  };

  const paintBrushSelection = (clientX, clientY) => {
    if (
      !hasLoadedImage ||
      isArtMode ||
      !activeGroupId ||
      !isPointInsideCircle(clientX, clientY)
    ) {
      return false;
    }

    const imagePoint = getImagePointFromClientPosition(clientX, clientY);
    if (!imagePoint) {
      return false;
    }

    const pixelOwnerMap = pixelOwnerMapRef.current;
    const pixelWeightMap = pixelWeightMapRef.current;
    const activeGroup = pixelGroups.find((group) => group.id === activeGroupId);
    if (!pixelOwnerMap || !pixelWeightMap || !activeGroup) {
      return false;
    }

    const activePixels = groupPixelsRef.current.get(activeGroup.groupNumber) ?? new Set();
    groupPixelsRef.current.set(activeGroup.groupNumber, activePixels);
    const countAdjustments = new Map();
    const changedPixelIndexes = [];

    for (let offsetY = -brushRadius; offsetY <= brushRadius; offsetY += 1) {
      for (let offsetX = -brushRadius; offsetX <= brushRadius; offsetX += 1) {
        if (offsetX * offsetX + offsetY * offsetY > brushRadius * brushRadius) {
          continue;
        }

        const pixelX = imagePoint.pixelColumn + offsetX;
        const pixelY = imagePoint.pixelRow + offsetY;
        if (
          pixelX < 0 ||
          pixelY < 0 ||
          pixelX >= imageSize.width ||
          pixelY >= imageSize.height ||
          !isImagePixelInsideCircle(pixelX, pixelY)
        ) {
          continue;
        }

        const pixelIndex = getLinearPixelIndex(imageSize.width, pixelX, pixelY);
        const previousOwner = pixelOwnerMap[pixelIndex];
        if (previousOwner === activeGroup.groupNumber) {
          continue;
        }

        if (previousOwner > 0) {
          const previousGroupPixels = groupPixelsRef.current.get(previousOwner);
          previousGroupPixels?.delete(pixelIndex);
          countAdjustments.set(
            previousOwner,
            (countAdjustments.get(previousOwner) ?? 0) - 1,
          );
        }

        activePixels.add(pixelIndex);
        pixelOwnerMap[pixelIndex] = activeGroup.groupNumber;
        pixelWeightMap[pixelIndex] = activeGroup.value;
        countAdjustments.set(
          activeGroup.groupNumber,
          (countAdjustments.get(activeGroup.groupNumber) ?? 0) + 1,
        );
        changedPixelIndexes.push(pixelIndex);
      }
    }

    if (changedPixelIndexes.length === 0) {
      return false;
    }

    paintSelectionPixelsOnOverlay(changedPixelIndexes, activeGroup.color);
    setPixelGroups((currentGroups) =>
      currentGroups.map((group) => {
        const adjustment = countAdjustments.get(group.groupNumber);
        return adjustment
          ? { ...group, pixelCount: group.pixelCount + adjustment }
          : group;
      }),
    );
    return true;
  };

  const handleAddPixelGroup = () => {
    const nextGroup = createPixelGroup(nextGroupNumber, GROUP_COLORS);
    groupPixelsRef.current.set(nextGroup.groupNumber, new Set());
    setPixelGroups((currentGroups) => [...currentGroups, nextGroup]);
    setActiveGroupId(nextGroup.id);
    setNextGroupNumber((currentValue) => currentValue + 1);
  };

  const handleRemovePixelGroup = (groupId) => {
    const removedGroup = pixelGroups.find((group) => group.id === groupId);
    const removedPixels = removedGroup
      ? Array.from(groupPixelsRef.current.get(removedGroup.groupNumber) ?? [])
      : [];
    if (
      removedGroup &&
      pixelGroups.length > 1 &&
      pixelOwnerMapRef.current &&
      pixelWeightMapRef.current
    ) {
      for (const pixelIndex of removedPixels) {
        pixelOwnerMapRef.current[pixelIndex] = 0;
        pixelWeightMapRef.current[pixelIndex] = 1;
      }
      groupPixelsRef.current.delete(removedGroup.groupNumber);
      eraseSelectionPixelsFromOverlay(removedPixels);
    }

    setPixelGroups((currentGroups) => {
      if (currentGroups.length === 1) {
        const groupPixels = groupPixelsRef.current.get(removedGroup.groupNumber);
        groupPixels?.clear();
        if (pixelOwnerMapRef.current && pixelWeightMapRef.current) {
          for (const pixelIndex of removedPixels) {
            pixelOwnerMapRef.current[pixelIndex] = 0;
            pixelWeightMapRef.current[pixelIndex] = 1;
          }
        }
        eraseSelectionPixelsFromOverlay(removedPixels);
        return currentGroups.map((group) =>
          group.id === groupId ? { ...group, pixelCount: 0, value: 0 } : group,
        );
      }

      const remainingGroups = currentGroups.filter((group) => group.id !== groupId);
      if (groupId === activeGroupId && remainingGroups.length > 0) {
        setActiveGroupId(remainingGroups[0].id);
      }
      return remainingGroups;
    });
  };

  const handleGroupValueChange = (groupId, nextValue) => {
    const clampedValue = clamp(nextValue, MIN_GROUP_VALUE, MAX_GROUP_VALUE);
    const targetGroup = pixelGroups.find((group) => group.id === groupId);
    if (targetGroup && pixelWeightMapRef.current) {
      for (const pixelIndex of groupPixelsRef.current.get(targetGroup.groupNumber) ?? []) {
        pixelWeightMapRef.current[pixelIndex] = clampedValue;
      }
    }

    setPixelGroups((currentGroups) =>
      currentGroups.map((group) =>
        group.id === groupId
          ? {
              ...group,
              value: clampedValue,
            }
          : group,
      ),
    );
  };

  useEffect(() => {
    if (!isArtMode) {
      redrawSelectionOverlay();
    }
  }, [imageSize, isArtMode]);

  const getWeightedAverageDarkness = (sourceImageData, pixels) => {
    if (!imageSize || !sourceImageData || pixels.length === 0) {
      return null;
    }

    const pixelWeightMap = pixelWeightMapRef.current;
    let weightedDarknessSum = 0;
    let totalWeight = 0;

    for (const pixel of pixels) {
      const pixelWeight = pixelWeightMap
        ? pixelWeightMap[getLinearPixelIndex(imageSize.width, pixel.x, pixel.y)]
        : 1;
      if (pixelWeight <= 0) {
        continue;
      }

      weightedDarknessSum +=
        getPixelDarkness(sourceImageData, imageSize.width, pixel.x, pixel.y) * pixelWeight;
      totalWeight += pixelWeight;
    }

    if (totalWeight === 0) {
      return null;
    }

    return weightedDarknessSum / totalWeight;
  };

  const handlePointerDown = (event) => {
    if (!hasLoadedImage) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (isBrushMode && !isArtMode) {
      paintBrushSelection(event.clientX, event.clientY);
      updateHoveredPixel(event);
      setDragState({
        mode: 'brush',
        pointerStart: { x: event.clientX, y: event.clientY },
      });
      return;
    }

    if (!event.shiftKey) {
      setDragState({
        mode: 'preview',
        pointerStart: { x: event.clientX, y: event.clientY },
        startOffset: previewOffsetRef.current,
      });
      return;
    }

    setDragState({
      mode: 'image',
      pointerStart: { x: event.clientX, y: event.clientY },
      startCenter: imageCenterRef.current,
    });
  };

  const handlePointerMove = (event) => {
    if (!dragState) {
      updateHoveredPixel(event);
      return;
    }

    if (dragState.mode === 'brush') {
      paintBrushSelection(event.clientX, event.clientY);
      updateHoveredPixel(event);
      return;
    }

    if (dragState.mode === 'preview') {
      const nextPreviewOffset = getDraggedPreviewOffset(
        dragState.startOffset,
        dragState.pointerStart,
        event.clientX,
        event.clientY,
      );
      previewOffsetRef.current = nextPreviewOffset;
      setPreviewOffset(nextPreviewOffset);
      updateHoveredPixel(event);
      return;
    }

    const nextImageCenter = getDraggedImageCenter(
      dragState.startCenter,
      dragState.pointerStart,
      event.clientX,
      event.clientY,
      previewScaleRef.current,
      imageScaleRef.current,
    );
    imageCenterRef.current = nextImageCenter;
    setImageCenter(nextImageCenter);
    updateHoveredPixel(event);
  };

  const stopDragging = (event) => {
    if (event?.currentTarget?.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragState(null);
  };

  const handleWheel = useCallback((event) => {
    event.preventDefault();
    const previewRect = previewRef.current?.getBoundingClientRect();
    if (!previewRect || previewSize <= 0) {
      return;
    }

    const zoomFactor = getZoomFactor(event.deltaY);

    if (!event.shiftKey) {
      const nextPreviewState = getZoomedPreviewState(
        previewScaleRef.current,
        previewOffsetRef.current,
        event.clientX,
        event.clientY,
        previewRect,
        zoomFactor,
        MIN_PREVIEW_SCALE,
      );
      previewOffsetRef.current = nextPreviewState.previewOffset;
      previewScaleRef.current = nextPreviewState.previewScale;
      setPreviewOffset(nextPreviewState.previewOffset);
      setPreviewScale(nextPreviewState.previewScale);
      return;
    }

    if (!hasLoadedImage) {
      return;
    }

    const previewPoint = getPreviewFramePoint(event.clientX, event.clientY);
    if (!previewPoint) {
      return;
    }

    const nextImageState = getZoomedImageState(
      imageScaleRef.current,
      imageCenterRef.current,
      previewPoint,
      previewSize,
      zoomFactor,
      MIN_SCALE,
      MAX_SCALE,
      clamp,
    );
    imageCenterRef.current = nextImageState.imageCenter;
    imageScaleRef.current = nextImageState.imageScale;
    setImageCenter(nextImageState.imageCenter);
    setImageScale(nextImageState.imageScale);
  }, [hasLoadedImage, previewSize]);

  useEffect(() => {
    const previewElement = previewRef.current;
    if (!previewElement) {
      return undefined;
    }

    previewElement.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      previewElement.removeEventListener('wheel', handleWheel);
    };
  }, [handleWheel]);

  const getLineCoverageForIndexes = (startIndex, endIndex) =>
    lineCoverageEngineRef.current.getLineCoverageForIndexes(startIndex, endIndex, {
      imageSize,
      previewSize,
      imageCenter,
      imageScale,
      nailsCount,
      nails,
    });

  const getSharedStateLineCoverageForIndexes = (startIndex, endIndex) =>
    sharedStateLineCoverageEngineRef.current.getLineCoverageForIndexes(startIndex, endIndex, {
      imageSize,
      previewSize,
      imageCenter,
      imageScale,
      nailsCount,
      nails,
    });

  const getLinePixelsForIndexes = (startIndex, endIndex) =>
    lineCoverageEngineRef.current.getLinePixelsForIndexes(startIndex, endIndex, {
      imageSize,
      previewSize,
      imageCenter,
      imageScale,
      nailsCount,
      nails,
    });

  function rebuildSharedColorFlipMaps() {
    if (
      !imageSize ||
      !originalImageDataRef.current ||
      enabledPalettePreviewColors.length === 0
    ) {
      sharedTargetColorIndexMapRef.current = null;
      sharedCurrentColorIndexMapRef.current = null;
      sharedColorIdToIndexRef.current = new Map();
      sharedTargetRegionGeometriesRef.current = new Map();
      sharedCurrentRegionGeometriesRef.current = new Map();
      sharedTargetRegionGeometryIndexesRef.current = new Map();
      sharedCurrentRegionGeometryIndexesRef.current = new Map();
      return;
    }

    const pixelCount = imageSize.width * imageSize.height;
    const targetMapCacheKey = [
      imageSize.width,
      imageSize.height,
      previewSize,
      imageCenter.x,
      imageCenter.y,
      imageScale,
      isPaletteDitheringEnabled ? 'dithered' : 'nearest',
      enabledPalettePreviewColors.map((color) => `${color.id}:${color.hex}`).join('|'),
    ].join('|');
    const colorIdToIndex = new Map(
      enabledPalettePreviewColors.map((color, index) => [color.id, index]),
    );
    const previousTargetMapCacheKey = sharedTargetMapCacheKeyRef.current;

    let targetColorIndexMap = sharedTargetColorIndexMapRef.current;
    const shouldRebuildTargetMap =
      !targetColorIndexMap ||
      targetColorIndexMap.length !== pixelCount ||
      previousTargetMapCacheKey !== targetMapCacheKey;
    if (shouldRebuildTargetMap) {
      targetColorIndexMap = new Uint8Array(pixelCount);
      targetColorIndexMap.fill(TARGET_NONE_COLOR_INDEX);
      const sourcePaletteImageData = createPalettePreviewImageData(
        originalImageDataRef.current,
        enabledPalettePreviewColors,
        isPaletteDitheringEnabled,
        null,
        false,
      );
      const sourceData = sourcePaletteImageData?.data ?? originalImageDataRef.current.data;
      const quantizedRgbToColorIndex = new Map(
        enabledPalettePreviewColors
          .filter((color) => color.rgb)
          .map((color, index) => [`${color.rgb.r}-${color.rgb.g}-${color.rgb.b}`, index]),
      );

      for (let y = 0; y < imageSize.height; y += 1) {
        for (let x = 0; x < imageSize.width; x += 1) {
          if (
            previewSize > 0 &&
            !isImagePixelInsidePreviewCircle(x, y, imageCenter, imageScale, previewSize)
          ) {
            continue;
          }

          const linearIndex = y * imageSize.width + x;
          const offset = linearIndex * 4;
          const quantizedColorKey = `${sourceData[offset]}-${sourceData[offset + 1]}-${sourceData[offset + 2]}`;
          let nearestColorIndex = quantizedRgbToColorIndex.get(quantizedColorKey) ?? null;
          if (!Number.isInteger(nearestColorIndex)) {
            const nearestColor = getNearestPaletteMatch(
              sourceData[offset],
              sourceData[offset + 1],
              sourceData[offset + 2],
              enabledPalettePreviewColors,
            );
            nearestColorIndex = nearestColor
              ? colorIdToIndex.get(nearestColor.id)
              : null;
          }
          if (Number.isInteger(nearestColorIndex)) {
            targetColorIndexMap[linearIndex] = nearestColorIndex;
          }
        }
      }
      sharedTargetMapCacheKeyRef.current = targetMapCacheKey;
    }

    if (shouldRebuildTargetMap || sharedTargetRegionGeometriesRef.current.size === 0) {
      const targetRegionGeometries = createPaletteRegionGeometries(
        originalImageDataRef.current,
        enabledPalettePreviewColors,
        isPaletteDitheringEnabled,
      );
      sharedTargetRegionGeometriesRef.current = new Map(
        targetRegionGeometries.map((color) => [color.id, color.geometry ?? []]),
      );
      sharedTargetRegionGeometryIndexesRef.current = new Map(
        targetRegionGeometries.map((color) => [
          color.id,
          buildGeometryAreaIndex(color.geometry ?? []),
        ]),
      );
    } else if (sharedTargetRegionGeometryIndexesRef.current.size === 0) {
      sharedTargetRegionGeometryIndexesRef.current = new Map(
        Array.from(sharedTargetRegionGeometriesRef.current.entries()).map(([colorId, geometry]) => [
          colorId,
          buildGeometryAreaIndex(geometry),
        ]),
      );
    }

    let currentColorIndexMap = sharedCurrentColorIndexMapRef.current;
    if (!currentColorIndexMap || currentColorIndexMap.length !== pixelCount) {
      currentColorIndexMap = new Uint8Array(pixelCount);
    }
    currentColorIndexMap.fill(CURRENT_WHITE_COLOR_INDEX);

    const currentRegionGeometriesById = new Map(
      enabledPalettePreviewColors.map((color) => [color.id, []]),
    );
    const lineWidthPx = parseThreadWidthPxValue(threadWidth);

    const replayLines = [];
    let fallbackOrder = 0;
    for (const bucket of multicolorLineBucketsRef.current) {
      const colorIndex = colorIdToIndex.get(bucket.colorId);
      if (!Number.isInteger(colorIndex)) {
        continue;
      }

      forEachPackedLine(bucket.linesPacked, (line) => {
        replayLines.push({
          colorIndex,
          startNailNumber: line.startNailNumber,
          endNailNumber: line.endNailNumber,
          stepOrder: Number.isInteger(line.stepOrder) ? line.stepOrder : null,
          fallbackOrder,
        });
        fallbackOrder += 1;
      });
    }
    replayLines.sort((firstLine, secondLine) => {
      const firstOrder = firstLine.stepOrder ?? Number.MAX_SAFE_INTEGER;
      const secondOrder = secondLine.stepOrder ?? Number.MAX_SAFE_INTEGER;
      if (firstOrder !== secondOrder) {
        return firstOrder - secondOrder;
      }
      return firstLine.fallbackOrder - secondLine.fallbackOrder;
    });

    for (const line of replayLines) {
      const startNail = nails[line.startNailNumber - 1];
      const endNail = nails[line.endNailNumber - 1];
      const lineGeometry = buildLineGeometryForIndexes(
        startNail,
        endNail,
        previewSize,
        imageCenter,
        imageScale,
        lineWidthPx,
      );
      if (lineGeometry.length === 0) {
        continue;
      }

      const colorId = enabledPalettePreviewColors[line.colorIndex]?.id;
      if (!colorId) {
        continue;
      }

      const targetGeometry = sharedTargetRegionGeometriesRef.current.get(colorId) ?? [];
      const currentGeometry = currentRegionGeometriesById.get(colorId) ?? [];
      const paintedGeometry = geometryIntersection(lineGeometry, targetGeometry);
      if (paintedGeometry.length === 0) {
        continue;
      }

      currentRegionGeometriesById.set(
        colorId,
        geometryUnion(currentGeometry, paintedGeometry),
      );
    }

    sharedCurrentRegionGeometriesRef.current = currentRegionGeometriesById;
    sharedCurrentRegionGeometryIndexesRef.current = new Map(
      Array.from(currentRegionGeometriesById.entries()).map(([colorId, geometry]) => [
        colorId,
        buildGeometryAreaIndex(geometry),
      ]),
    );
    sharedTargetColorIndexMapRef.current = targetColorIndexMap;
    sharedCurrentColorIndexMapRef.current = currentColorIndexMap;
    sharedColorIdToIndexRef.current = colorIdToIndex;
  }

  const applyLineToSharedColorFlipMap = useCallback((
    colorId,
    startNailNumber,
    endNailNumber,
  ) => {
    const targetGeometry = sharedTargetRegionGeometriesRef.current.get(colorId);
    const currentGeometry = sharedCurrentRegionGeometriesRef.current.get(colorId) ?? [];
    if (!imageSize || !targetGeometry) {
      return;
    }

    const currentNails = nailsRef.current;
    const startNail = currentNails[startNailNumber - 1];
    const endNail = currentNails[endNailNumber - 1];
    const lineGeometry = buildLineGeometryForIndexes(
      startNail,
      endNail,
      previewSize,
      imageCenter,
      imageScale,
      parseThreadWidthPxValue(threadWidth),
    );
    if (lineGeometry.length === 0) {
      return;
    }

    const paintedGeometry = geometryIntersection(lineGeometry, targetGeometry);
    if (paintedGeometry.length === 0) {
      return;
    }

    const nextCurrentGeometry = geometryUnion(currentGeometry, paintedGeometry);
    sharedCurrentRegionGeometriesRef.current.set(colorId, nextCurrentGeometry);
    sharedCurrentRegionGeometryIndexesRef.current.set(
      colorId,
      buildGeometryAreaIndex(nextCurrentGeometry),
    );
  }, [imageSize, imageCenter, imageScale, previewSize, threadWidth]);

  useEffect(() => {
    rebuildSharedColorFlipMaps();
  }, [
    enabledPalettePreviewColors,
    imageCenter.x,
    imageCenter.y,
    imageScale,
    imageSize,
    isPaletteDitheringEnabled,
    lineCoverageBackendId,
    multicolorLineBuckets,
    previewSize,
  ]);

  function getBestFlipRatioLineForColor(
    originIndex,
    targetColorId,
    options = {},
  ) {
    const metrics = options.metrics ?? null;
    if (
      !imageSize ||
      !Number.isInteger(originIndex) ||
      originIndex < 1 ||
      originIndex > nailsCount
    ) {
      return null;
    }

    const targetGeometryIndex = sharedTargetRegionGeometryIndexesRef.current.get(targetColorId);
    const currentGeometryIndex = sharedCurrentRegionGeometryIndexesRef.current.get(targetColorId);
    if (!targetGeometryIndex || !currentGeometryIndex) {
      return null;
    }

    const usedLineKeys = options.usedLineKeys ?? usedLineKeysRef.current;
    const minimumAllowedDistance =
      options.minimumAllowedDistance ?? parseMinDistanceValue(highlightRange);

    let bestLine = null;
    const currentNails = nailsRef.current;
    for (const targetNail of currentNails) {
      if (metrics) {
        metrics.candidatesTotal += 1;
      }
      const lineKey = getNormalizedLineKey(originIndex, targetNail.number);
      if (!lineKey || usedLineKeys.has(lineKey)) {
        if (metrics) {
          metrics.rejectedUsedLine += 1;
        }
        continue;
      }

      if (
        minimumAllowedDistance > 0 &&
        getCircularNailDistance(targetNail.number, originIndex, nailsCount) <= minimumAllowedDistance
      ) {
        if (metrics) {
          metrics.rejectedDistance += 1;
        }
        continue;
      }

      const geometryStartTime = metrics ? performance.now() : 0;
      const lineGeometry = buildLineGeometryForIndexes(
        currentNails[originIndex - 1],
        targetNail,
        previewSize,
        imageCenter,
        imageScale,
        parseThreadWidthPxValue(threadWidth),
      );
      if (metrics) {
        metrics.lineGeometryMs += performance.now() - geometryStartTime;
      }
      if (lineGeometry.length === 0) {
        if (metrics) {
          metrics.rejectedEmptyGeometry += 1;
        }
        continue;
      }

      const linePrepStartTime = metrics ? performance.now() : 0;
      const lineClipPolygon = getLineClipPolygonFromGeometry(lineGeometry);
      const lineBounds = getBoundsForPoints(lineClipPolygon);
      const totalCoverage = getPolygonArea(lineClipPolygon);
      if (metrics) {
        metrics.linePrepMs += performance.now() - linePrepStartTime;
      }
      if (totalCoverage <= GEOMETRY_AREA_EPSILON || !lineBounds) {
        if (metrics) {
          metrics.rejectedZeroArea += 1;
        }
        continue;
      }

      const targetOverlapStartTime = metrics ? performance.now() : 0;
      const targetOverlapCoverage = getLineOverlapAreaWithGeometryIndex(
        lineClipPolygon,
        lineBounds,
        targetGeometryIndex,
        metrics?.targetOverlap,
      );
      if (metrics) {
        metrics.targetOverlapMs += performance.now() - targetOverlapStartTime;
      }
      if (targetOverlapCoverage <= GEOMETRY_AREA_EPSILON) {
        if (metrics) {
          metrics.rejectedNoTargetOverlap += 1;
        }
        continue;
      }

      const currentOverlapStartTime = metrics ? performance.now() : 0;
      const alreadyPaintedCoverage = getLineOverlapAreaWithGeometryIndex(
        lineClipPolygon,
        lineBounds,
        currentGeometryIndex,
        metrics?.currentOverlap,
      );
      if (metrics) {
        metrics.currentOverlapMs += performance.now() - currentOverlapStartTime;
      }
      const flippedCoverage = Math.max(0, targetOverlapCoverage - alreadyPaintedCoverage);
      const flippedPixelCount = Math.max(0, Math.round(flippedCoverage));
      let score = 0;
      const coverageEntryCount = Math.max(0, Math.round(totalCoverage));
      if (flippedCoverage <= GEOMETRY_AREA_EPSILON) {
        if (metrics) {
          metrics.rejectedAlreadyPainted += 1;
        }
        continue;
      }
      if (metrics) {
        metrics.validCandidates += 1;
      }
      score = flippedCoverage / totalCoverage;

      if (
        !bestLine ||
        score > bestLine.score ||
        (score === bestLine.score && flippedCoverage > bestLine.flippedCoverage)
      ) {
        bestLine = {
          endNailNumber: targetNail.number,
          score,
          flippedPixelCount,
          flippedCoverage,
          pixelCount: coverageEntryCount,
          coverageTotal: totalCoverage,
        };
      }
    }

    return bestLine;
  }

  const getBestLineForImageData = (originIndex, sourceImageData, options = {}) => {
    if (
      !imageSize ||
      !sourceImageData ||
      !Number.isInteger(originIndex) ||
      originIndex < 1 ||
      originIndex > nailsCount
    ) {
      return null;
    }

    const usedLineKeys = options.usedLineKeys ?? usedLineKeysRef.current;
    const minimumAllowedDistance =
      options.minimumAllowedDistance ?? parseMinDistanceValue(highlightRange);

    let minimumDarkness = Infinity;
    let selectedNail = null;

    for (const targetNail of nails) {
      if (usedLineKeys.has(getNormalizedLineKey(originIndex, targetNail.number))) {
        continue;
      }

      if (
        minimumAllowedDistance > 0 &&
        getCircularNailDistance(targetNail.number, originIndex, nailsCount) <= minimumAllowedDistance
      ) {
        continue;
      }

      const pixels = getLinePixelsForIndexes(originIndex, targetNail.number);
      if (pixels.length === 0) {
        continue;
      }

      const averageDarkness = getWeightedAverageDarkness(sourceImageData, pixels);
      if (averageDarkness === null) {
        continue;
      }

      if (averageDarkness < minimumDarkness) {
        minimumDarkness = averageDarkness;
        selectedNail = targetNail.number;
      }
    }

    return selectedNail === null
      ? null
      : {
          endNailNumber: selectedNail,
          score: minimumDarkness,
        };
  };

  const getNextNailForImageData = (originIndex, sourceImageData, options = {}) =>
    getBestLineForImageData(originIndex, sourceImageData, options)?.endNailNumber ?? null;

  const applyLineToImageData = (
    targetImageData,
    startIndex,
    endIndex,
    lineDarknessStep,
    targetLineBoostMap = null,
  ) => {
    const targetLineCoverage = getLineCoverageForIndexes(startIndex, endIndex);
    if (!imageSize || targetLineCoverage.length === 0) {
      return false;
    }

    for (const pixel of targetLineCoverage) {
      const pixelIndex = pixel.pixelIndex;
      const index = pixelIndex * 4;
      targetImageData[index] = Math.min(255, targetImageData[index] + lineDarknessStep);
      targetImageData[index + 1] = Math.min(255, targetImageData[index + 1] + lineDarknessStep);
      targetImageData[index + 2] = Math.min(255, targetImageData[index + 2] + lineDarknessStep);
      if (targetLineBoostMap) {
        targetLineBoostMap[pixelIndex] += lineDarknessStep;
      }
    }

    return true;
  };

  const applyColorResidualLineToImageData = (
    targetImageData,
    startIndex,
    endIndex,
    _lineDarknessStep,
    lineColorRgb,
  ) => {
    const targetCoverageEntries = getLineCoverageForIndexes(startIndex, endIndex);
    if (!imageSize || targetCoverageEntries.length === 0 || !lineColorRgb) {
      return false;
    }

    for (const entry of targetCoverageEntries) {
      if (entry.coverage <= 0) {
        continue;
      }
      const index = entry.pixelIndex * 4;
      targetImageData[index] = lineColorRgb.r;
      targetImageData[index + 1] = lineColorRgb.g;
      targetImageData[index + 2] = lineColorRgb.b;
    }

    return true;
  };

  const getLineDarknessStep = (lineStrengthValue = lineStrength) =>
    parseLineDarknessStep(lineStrengthValue);

  const getUsedLineKeysForMulticolorBucket = useCallback((bucket, bucketList = multicolorLineBucketsRef.current) => {
    const addBucketLineKeys = (targetSet, sourceBucket) => {
      forEachPackedLine(sourceBucket?.linesPacked, (line) => {
        const lineKey = getNormalizedLineKey(line.startNailNumber, line.endNailNumber);
        if (lineKey) {
          targetSet.add(lineKey);
        }
      });
    };

    if (!bucket) {
      const nextUsedLineKeys = new Set(monochromeUsedLineKeys);
      for (const currentBucket of bucketList) {
        addBucketLineKeys(nextUsedLineKeys, currentBucket);
      }
      return nextUsedLineKeys;
    }

    if (multicolorUsedLineExclusionMode === 'shared') {
      const nextUsedLineKeys = new Set(monochromeUsedLineKeys);
      for (const currentBucket of bucketList) {
        addBucketLineKeys(nextUsedLineKeys, currentBucket);
      }
      return nextUsedLineKeys;
    }

    const nextUsedLineKeys = new Set(monochromeUsedLineKeys);
    addBucketLineKeys(nextUsedLineKeys, bucket);
    return nextUsedLineKeys;
  }, [
    monochromeUsedLineKeys,
    multicolorUsedLineExclusionMode,
  ]);
  const activeExperimentalBucketUsedLineKeys = useMemo(
    () => getUsedLineKeysForMulticolorBucket(activeMulticolorLineBucket),
    [activeMulticolorLineBucket, getUsedLineKeysForMulticolorBucket],
  );

  const getCanvasImageData = () => {
    if (!imageCanvasRef.current || !imageSize) {
      return null;
    }

    const context = imageCanvasRef.current.getContext('2d', {
      willReadFrequently: true,
    });
    return context?.getImageData(0, 0, imageSize.width, imageSize.height) ?? null;
  };

  const getEligibleMulticolorStepBuckets = (bucketList = multicolorLineBuckets) =>
    bucketList.filter(
      (bucket) =>
        bucket.enabled &&
        Math.max(
          0,
          (plannedMulticolorLinesByColorId.get(bucket.colorId) ?? 0) -
            (bucket.lineCount ?? getPackedLineCount(bucket.linesPacked)),
        ) > 0,
    );

  const rebuildCanvasFromStoredLineState = (
    savedSequence = savedNailSequence,
    bucketList = multicolorLineBuckets,
    activeColorId = activePaletteColorId,
  ) => {
    if (!imageCanvasRef.current || !imageSize || !originalImageDataRef.current) {
      return false;
    }

    const context = imageCanvasRef.current.getContext('2d', {
      willReadFrequently: true,
    });
    if (!context) {
      return false;
    }

    lineBoostMapRef.current = new Uint32Array(imageSize.width * imageSize.height);
    usedLineKeysRef.current = new Set();
    writeProcessedImageData(
      context,
      originalImageDataRef.current,
      imageSize.width,
      imageSize.height,
      Number.parseInt(contrast, 10),
      lineBoostMapRef.current,
      MIN_CONTRAST,
      MAX_CONTRAST,
      DEFAULT_CONTRAST,
    );

    const canvasImage = context.getImageData(0, 0, imageSize.width, imageSize.height);
    let currentStartNailNumber = 1;
    const monochromeLineDarknessStep = getLineDarknessStep();
    const monochromeAppliedLineKeys = new Set();
    for (const nextNailNumber of savedSequence) {
      if (!Number.isInteger(nextNailNumber) || nextNailNumber < 1 || nextNailNumber > nailsCount) {
        continue;
      }

      const lineKey = getNormalizedLineKey(currentStartNailNumber, nextNailNumber);
      if (
        lineKey &&
        !monochromeAppliedLineKeys.has(lineKey) &&
        applyLineToImageData(
          canvasImage.data,
          currentStartNailNumber,
          nextNailNumber,
          monochromeLineDarknessStep,
          lineBoostMapRef.current,
        )
      ) {
        monochromeAppliedLineKeys.add(lineKey);
        usedLineKeysRef.current.add(lineKey);
      }
      currentStartNailNumber = nextNailNumber;
    }

    for (const bucket of bucketList) {
      const bucketRgb = hexToRgb(bucket.hex);
      const bucketLineDarknessStep =
        multicolorLineStrengthMode === 'shared'
          ? monochromeLineDarknessStep
          : getLineDarknessStep(bucket.lineStrength);
      const bucketAppliedLineKeys =
        multicolorUsedLineExclusionMode === 'shared'
          ? usedLineKeysRef.current
          : new Set(monochromeAppliedLineKeys);
      forEachPackedLine(bucket.linesPacked, (line) => {
        const lineKey = getNormalizedLineKey(line.startNailNumber, line.endNailNumber);
        if (
          !lineKey ||
          bucketAppliedLineKeys.has(lineKey) ||
          !applyColorResidualLineToImageData(
            canvasImage.data,
            line.startNailNumber,
            line.endNailNumber,
            bucketLineDarknessStep,
            bucketRgb,
          )
        ) {
          return;
        }

        bucketAppliedLineKeys.add(lineKey);
        if (multicolorUsedLineExclusionMode === 'shared') {
          usedLineKeysRef.current.add(lineKey);
        }
      });
    }

    context.putImageData(canvasImage, 0, 0);
    invalidateCurrentCanvasMaskCollectionCache();
    const nextTargetImage = buildColorMaskScoringImageData(activeColorId, canvasImage);
    setActiveMulticolorTargetImage(nextTargetImage);
    activeColorMaskScoringImageDataRef.current = isActiveColorMaskScoringEnabled
      ? nextTargetImage
      : null;
    syncVisibleCanvas();
    return true;
  };

  const getExperimentalStartNailNumberForBucket = (bucket) => {
    if (!bucket) {
      return hasValidFromIndex ? fromIndex : 1;
    }

    return bucket.lastNailNumber ?? (hasValidFromIndex ? fromIndex : 1);
  };

  const getNextRoundRobinColorId = (currentColorId, bucketList = multicolorLineBuckets) => {
    const eligibleBuckets = getEligibleMulticolorStepBuckets(bucketList);
    if (eligibleBuckets.length === 0) {
      return null;
    }

    const currentColorIndex = eligibleBuckets.findIndex(
      (bucket) => bucket.colorId === currentColorId,
    );
    if (currentColorIndex < 0) {
      return eligibleBuckets[0].colorId;
    }

    return eligibleBuckets[
      (currentColorIndex + 1) % eligibleBuckets.length
    ].colorId;
  };

  const getSharedBestMulticolorStepCandidate = (
    bucketList = multicolorLineBuckets,
    stepProfile = null,
  ) => {
    if (
      enabledPalettePreviewColors.length === 0 ||
      !sharedTargetColorIndexMapRef.current ||
      !sharedCurrentColorIndexMapRef.current
    ) {
      return null;
    }

    const eligibleBuckets = getEligibleMulticolorStepBuckets(bucketList);
    if (eligibleBuckets.length === 0) {
      return null;
    }

    let bestCandidate = null;
    const evaluateBuckets = () => {
      for (const bucket of eligibleBuckets) {
        const bucketSearchStartedAt = stepProfile ? performance.now() : 0;
        const metrics = stepProfile
          ? {
              candidatesTotal: 0,
              validCandidates: 0,
              rejectedUsedLine: 0,
              rejectedDistance: 0,
              rejectedEmptyGeometry: 0,
              rejectedZeroArea: 0,
              rejectedNoTargetOverlap: 0,
              rejectedAlreadyPainted: 0,
              lineGeometryMs: 0,
              linePrepMs: 0,
              targetOverlapMs: 0,
              currentOverlapMs: 0,
              targetOverlap: {
                scannedPolygons: 0,
                boundsHits: 0,
                clippedRings: 0,
              },
              currentOverlap: {
                scannedPolygons: 0,
                boundsHits: 0,
                clippedRings: 0,
              },
            }
          : null;
        const targetColor = enabledPalettePreviewColors.find(
          (color) => color.id === bucket.colorId,
        );
        if (!targetColor?.rgb) {
          continue;
        }

        const startNailNumber = getExperimentalStartNailNumberForBucket(bucket);
        const minimumAllowedDistance =
          multicolorMinDistanceMode === 'shared'
            ? parseMinDistanceValue(highlightRange)
            : parseMinDistanceValue(bucket.minDistance);
        const bestLine = getBestFlipRatioLineForColor(startNailNumber, bucket.colorId, {
          usedLineKeys: getUsedLineKeysForMulticolorBucket(bucket, bucketList),
          minimumAllowedDistance,
          metrics,
        });
        if (stepProfile && metrics) {
          stepProfile.rows.push({
            bucket: `shared color search: ${bucket.label}`,
            ms: performance.now() - bucketSearchStartedAt,
            details: metrics,
          });
        }
        if (!bestLine) {
          continue;
        }

        if (
          !bestCandidate ||
          bestLine.score > bestCandidate.score ||
          (
            bestLine.score === bestCandidate.score &&
            bestLine.flippedCoverage > bestCandidate.flippedCoverage
          )
        ) {
          bestCandidate = {
            bucket,
            colorId: bucket.colorId,
            colorRgb: targetColor.rgb,
            startNailNumber,
            endNailNumber: bestLine.endNailNumber,
            score: bestLine.score,
            flippedPixelCount: bestLine.flippedPixelCount,
            flippedCoverage: bestLine.flippedCoverage,
            pixelCount: bestLine.pixelCount,
            coverageTotal: bestLine.coverageTotal,
            lineDarknessStep:
              multicolorLineStrengthMode === 'shared'
                ? getLineDarknessStep()
                : getLineDarknessStep(bucket.lineStrength),
            usedLineKeys: getUsedLineKeysForMulticolorBucket(bucket, bucketList),
          };
        }
      }
    };

    if (stepProfile) {
      stepProfile.measure('shared best line search', evaluateBuckets);
    } else {
      evaluateBuckets();
    }

    return bestCandidate;
  };

  const waitForNextWorkSlice = () =>
    new Promise((resolve) => {
      let timeoutId = null;
      let frameId = null;
      let messageChannel = null;
      let hasResolved = false;

      const finish = (timestamp, shouldYieldAfterFrame = false) => {
        if (hasResolved) {
          return;
        }

        hasResolved = true;
        if (frameId !== null) {
          window.cancelAnimationFrame(frameId);
          if (animationFrameRef.current === frameId) {
            animationFrameRef.current = null;
          }
        }
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
        if (messageChannel) {
          messageChannel.port1.onmessage = null;
          messageChannel.port1.close();
          messageChannel.port2.close();
        }

        if (shouldYieldAfterFrame) {
          window.setTimeout(() => resolve(timestamp), 0);
        } else {
          resolve(timestamp);
        }
      };

      if (document.hidden) {
        messageChannel = new MessageChannel();
        messageChannel.port1.onmessage = () => {
          finish(performance.now());
        };
        messageChannel.port2.postMessage(null);
        timeoutId = window.setTimeout(() => {
          finish(performance.now());
        }, 1000);
        return;
      }

      frameId = window.requestAnimationFrame((timestamp) => {
        finish(timestamp, true);
      });
      animationFrameRef.current = frameId;
      timeoutId = window.setTimeout(() => {
        finish(performance.now());
      }, 250);
    });

  const handleSetNextNail = () => {
    if (nextNailNumber !== null) {
      setLineTo(String(nextNailNumber));
    }
  };

  const handleSetFromCurrentTo = () => {
    if (lineTo !== '') {
      setLineFrom(lineTo);
    }
  };

  const handleMakeLinePermanent = (startIndex = fromIndex, endIndex = toIndex, options = {}) => {
    const stepProfile = options.profile ?? null;
    const shouldSkipVisibleSync = Boolean(options.skipVisibleSync);
    const skipGlobalUsedLineCheck = Boolean(options.skipGlobalUsedLineCheck);
    const skipGlobalUsedLineTracking = Boolean(options.skipGlobalUsedLineTracking);
    const lineColorRgb = options.lineColorRgb ?? null;
    const colorId = options.colorId ?? null;
    const skipActiveMaskLineApplication = Boolean(options.skipActiveMaskLineApplication);
    const usedLineKeys = options.usedLineKeys ?? usedLineKeysRef.current;
    const lineDarknessStep = options.lineDarknessStep ?? getLineDarknessStep();
    const lineKey = getNormalizedLineKey(startIndex, endIndex);
    const startNail = nails[startIndex - 1];
    const endNail = nails[endIndex - 1];
    const lineGeometry = buildLineGeometryForIndexes(
      startNail,
      endNail,
      previewSize,
      imageCenter,
      imageScale,
      parseThreadWidthPxValue(threadWidth),
    );
    const lineClipPolygon = getLineClipPolygonFromGeometry(lineGeometry);
    const lineBounds = getBoundsForPoints(lineClipPolygon);
    const targetRegionGeometryIndex =
      colorId ? sharedTargetRegionGeometryIndexesRef.current.get(colorId) ?? [] : null;
    const lineHasDrawableGeometry =
      lineGeometry.length > 0 &&
      (!colorId ||
        !targetRegionGeometryIndex ||
        getLineOverlapAreaWithGeometryIndex(
          lineClipPolygon,
          lineBounds,
          targetRegionGeometryIndex,
        ) > GEOMETRY_AREA_EPSILON);
    if (
      !lineKey ||
      (!skipGlobalUsedLineCheck && usedLineKeys.has(lineKey)) ||
      !imageCanvasRef.current ||
      !imageSize ||
      !lineHasDrawableGeometry
    ) {
      return false;
    }

    const context = imageCanvasRef.current.getContext('2d', {
      willReadFrequently: true,
    });
    if (!context) {
      return false;
    }

    const canvasImage = stepProfile
      ? stepProfile.measure('canvas read', () =>
          context.getImageData(0, 0, imageSize.width, imageSize.height),
        )
      : context.getImageData(0, 0, imageSize.width, imageSize.height);
    const applyLineToSharedBoard = () =>
      lineColorRgb
        ? applyColorResidualLineToImageData(
            canvasImage.data,
            startIndex,
            endIndex,
            lineDarknessStep,
            lineColorRgb,
          )
        : applyLineToImageData(
            canvasImage.data,
            startIndex,
            endIndex,
            lineDarknessStep,
            lineBoostMapRef.current,
          );
    const didApplyRasterLine = stepProfile
      ? stepProfile.measure('line application', applyLineToSharedBoard)
      : applyLineToSharedBoard();
    const didApplyLine = didApplyRasterLine || Boolean(lineColorRgb && colorId);
    if (!didApplyLine) {
      return false;
    }
    if (
      !skipActiveMaskLineApplication &&
      isActiveColorMaskScoringEnabled &&
      activeColorMaskScoringImageDataRef.current
    ) {
      if (stepProfile) {
        stepProfile.measure('active mask line application', () =>
          applyLineToImageData(
            activeColorMaskScoringImageDataRef.current.data,
            startIndex,
            endIndex,
            lineDarknessStep,
          ),
        );
      } else {
        applyLineToImageData(
          activeColorMaskScoringImageDataRef.current.data,
          startIndex,
          endIndex,
          lineDarknessStep,
        );
      }
    }
    if (!skipGlobalUsedLineTracking) {
      usedLineKeysRef.current.add(lineKey);
    }

    if (stepProfile) {
      stepProfile.measure('canvas write', () => context.putImageData(canvasImage, 0, 0));
    } else {
      context.putImageData(canvasImage, 0, 0);
    }
    invalidateCurrentCanvasMaskCollectionCache();
    if (shouldSkipVisibleSync) {
      if (stepProfile) {
        stepProfile.rows.push({
          bucket: 'canvas sync skipped',
          ms: 0,
        });
      }
    } else if (stepProfile) {
      stepProfile.measure('canvas sync', syncVisibleCanvas);
    } else {
      syncVisibleCanvas();
    }
    return true;
  };

  const handleMakeCurrentLinePermanent = () => {
    if (!hasRenderableLine) {
      return;
    }

    if (handleMakeLinePermanent(fromIndex, toIndex)) {
      setHiddenPreviewLineKey(getNormalizedLineKey(fromIndex, toIndex));
    }
  };

  const handleAllOfTheAbove = () => {
    if (!Number.isInteger(fromIndex) || nextNailNumber === null) {
      return;
    }

    const nextNailValue = String(nextNailNumber);
    setLineTo(nextNailValue);
    const didApplyLine = handleMakeLinePermanent(fromIndex, nextNailNumber);
    if (!didApplyLine) {
      return;
    }
    setLineFrom(nextNailValue);
    setSavedNailSequence((currentSequence) => [...currentSequence, nextNailNumber]);
  };

  const flushMulticolorLineBucketsToState = ({ force = false } = {}) => {
    const nextBuckets = multicolorLineBucketsRef.current;
    if (!force && sharedLoopBucketStateFlushPendingRef.current) {
      return false;
    }
    if (nextBuckets === committedMulticolorLineBucketsRef.current) {
      sharedLoopBucketStateFlushPendingRef.current = false;
      return false;
    }

    sharedLoopBucketStateFlushPendingRef.current = true;
    sharedLoopLastBucketFlushAtRef.current = performance.now();
    setMulticolorLineBuckets(nextBuckets);
    return true;
  };

  const maybeFlushSharedLoopBucketsToState = () => {
    if (!isArtModeRef.current) {
      return false;
    }
    if (
      performance.now() - sharedLoopLastBucketFlushAtRef.current <
      SHARED_LOOP_ART_BUCKET_FLUSH_INTERVAL_MS
    ) {
      return false;
    }
    return flushMulticolorLineBucketsToState();
  };

  const handleApplyExperimentalStep = (options = {}) => {
    const shouldCommitBucketState =
      options.commitBucketState ?? !sharedStateLoopRunningRef.current;
    const shouldUpdateSharedLoopCounter =
      options.updateSharedLoopCounter ?? sharedStateLoopRunningRef.current;
    const shouldFlushSharedLoopBuckets =
      options.flushSharedLoopBuckets ?? sharedStateLoopRunningRef.current;
    const currentMulticolorLineBuckets = multicolorLineBucketsRef.current;
    const currentEligibleMulticolorStepBuckets = getEligibleMulticolorStepBuckets(
      currentMulticolorLineBuckets,
    );
    if (currentEligibleMulticolorStepBuckets.length === 0) {
      return {
        ok: false,
        reason: 'No eligible color buckets remain.',
      };
    }

    if (
      sharedTargetRegionGeometriesRef.current.size === 0 ||
      sharedCurrentRegionGeometriesRef.current.size === 0
    ) {
      rebuildSharedColorFlipMaps();
    }

    const stepProfile = createMulticolorStepProfile({
      colorId: multicolorExperimentalSteppingMode,
      colorLabel:
        multicolorExperimentalSteppingMode === 'shared-best'
          ? 'shared best'
          : activeMulticolorLineBucket?.label ?? 'unknown',
      mode: multicolorExperimentalSteppingMode,
      source: isPaletteDitheringEnabled ? 'dithered' : 'nearest',
    });
    const needsCanvasSnapshot = multicolorExperimentalSteppingMode !== 'shared-best';
    const canvasImageData = needsCanvasSnapshot
      ? stepProfile
        ? stepProfile.measure('canvas snapshot', getCanvasImageData)
        : getCanvasImageData()
      : null;
    if (needsCanvasSnapshot && !canvasImageData) {
      return {
        ok: false,
        reason: 'Canvas snapshot was unavailable.',
      };
    }

    let stepCandidate = null;
    if (multicolorExperimentalSteppingMode === 'shared-best') {
      stepCandidate = getSharedBestMulticolorStepCandidate(
        currentMulticolorLineBuckets,
        stepProfile,
      );
    } else {
      const targetColorId =
        multicolorExperimentalSteppingMode === 'round-robin'
          ? (
              multicolorRoundRobinNextColorId ??
              currentEligibleMulticolorStepBuckets.find((bucket) => bucket.colorId === activePaletteColorId)?.colorId ??
              currentEligibleMulticolorStepBuckets[0].colorId
            )
          : activeMulticolorRemainingLineCount > 0
            ? activePaletteColorId
            : null;
      const targetBucket = currentMulticolorLineBuckets.find((bucket) => bucket.colorId === targetColorId);
      const targetColor = enabledPalettePreviewColors.find((color) => color.id === targetColorId);
      if (targetBucket && targetColor?.rgb) {
        const targetStartNailNumber = getExperimentalStartNailNumberForBucket(targetBucket);
        const targetUsedLineKeys = getUsedLineKeysForMulticolorBucket(
          targetBucket,
          currentMulticolorLineBuckets,
        );
        const targetMinimumDistance =
          multicolorMinDistanceMode === 'shared'
            ? parseMinDistanceValue(highlightRange)
            : parseMinDistanceValue(targetBucket.minDistance);
        const targetColorMaskImageData = stepProfile
          ? stepProfile.measure('mask rebuild', () =>
              buildColorMaskScoringImageData(targetColorId, canvasImageData),
            )
          : buildColorMaskScoringImageData(targetColorId, canvasImageData);
        const targetBestLine = targetColorMaskImageData
          ? stepProfile
            ? stepProfile.measure('next nail search', () =>
                getBestLineForImageData(targetStartNailNumber, targetColorMaskImageData.data, {
                  usedLineKeys: targetUsedLineKeys,
                  minimumAllowedDistance: targetMinimumDistance,
                }),
              )
            : getBestLineForImageData(targetStartNailNumber, targetColorMaskImageData.data, {
                usedLineKeys: targetUsedLineKeys,
                minimumAllowedDistance: targetMinimumDistance,
              })
          : null;
        if (targetBestLine) {
          stepCandidate = {
            bucket: targetBucket,
            colorId: targetBucket.colorId,
            colorRgb: targetColor.rgb,
            startNailNumber: targetStartNailNumber,
            endNailNumber: targetBestLine.endNailNumber,
            score: targetBestLine.score,
            lineDarknessStep:
              multicolorLineStrengthMode === 'shared'
                ? getLineDarknessStep()
                : getLineDarknessStep(targetBucket.lineStrength),
            usedLineKeys: targetUsedLineKeys,
          };
        }
      }
    }

    if (!stepCandidate) {
      return {
        ok: false,
        reason: 'No valid line candidate was found.',
      };
    }

    const {
      bucket: targetBucket,
      colorId: targetColorId,
      colorRgb: targetColorRgb,
      startNailNumber: targetStartNailNumber,
      endNailNumber: targetNextNailNumber,
      lineDarknessStep: targetLineDarknessStep,
      usedLineKeys: targetUsedLineKeys,
    } = stepCandidate;

    const didApplyLine = handleMakeLinePermanent(targetStartNailNumber, targetNextNailNumber, {
      profile: stepProfile,
      lineDarknessStep: targetLineDarknessStep,
      lineColorRgb: targetColorRgb,
      colorId: targetColorId,
      skipActiveMaskLineApplication: true,
      skipVisibleSync: shouldDeferMulticolorStepVisuals || sharedStateLoopRunningRef.current,
      skipGlobalUsedLineCheck: multicolorUsedLineExclusionMode === 'per-color',
      skipGlobalUsedLineTracking: multicolorUsedLineExclusionMode === 'per-color',
      usedLineKeys: targetUsedLineKeys,
    });
    if (!didApplyLine) {
      return {
        ok: false,
        reason: 'Selected line could not be applied.',
      };
    }
    const updateSharedGeometry = () =>
      applyLineToSharedColorFlipMap(
        targetColorId,
        targetStartNailNumber,
        targetNextNailNumber,
      );
    if (stepProfile) {
      stepProfile.measure('shared geometry update', updateSharedGeometry);
    } else {
      updateSharedGeometry();
    }

    const shouldRefreshTargetPreview =
      !shouldDeferMulticolorStepVisuals &&
      multicolorExperimentalSteppingMode !== 'shared-best' &&
      isPaletteMaskVisible;
    if (shouldRefreshTargetPreview) {
      activeColorMaskScoringImageDataRef.current = stepProfile
        ? stepProfile.measure('target preview refresh', () =>
            buildColorMaskScoringImageData(targetColorId),
          )
        : buildColorMaskScoringImageData(targetColorId);
    } else if (stepProfile) {
      stepProfile.rows.push({
        bucket: 'target preview refresh skipped',
        ms: 0,
      });
    }
    const nextStepOrder = multicolorLineStepOrderRef.current;
    multicolorLineStepOrderRef.current += 1;
    const nextBuckets = currentMulticolorLineBuckets.map((bucket) =>
      bucket.colorId === targetColorId
        ? {
            ...bucket,
            lastNailNumber: targetNextNailNumber,
            linesPacked: appendPackedLine(
              bucket.linesPacked,
              targetStartNailNumber,
              targetNextNailNumber,
              nextStepOrder,
            ),
            lineCount: (bucket.lineCount ?? getPackedLineCount(bucket.linesPacked)) + 1,
          }
        : bucket,
    );
    multicolorLineBucketsRef.current = nextBuckets;
    const nextTotalLineCount = getMulticolorBucketTotalLineCount(nextBuckets);
    if (shouldUpdateSharedLoopCounter) {
      sharedLoopVisibleLineCountRef.current = nextTotalLineCount;
      setSharedLoopVisibleLineCount(nextTotalLineCount);
    }
    const scheduleStateUpdates = () => {
      skipNextActiveTargetImageEffectRef.current = true;
      if (shouldRefreshTargetPreview) {
        setActiveMulticolorTargetImage(activeColorMaskScoringImageDataRef.current);
      }
      if (shouldCommitBucketState) {
        setMulticolorLineBuckets(nextBuckets);
      } else if (shouldFlushSharedLoopBuckets) {
        maybeFlushSharedLoopBucketsToState();
      }
      setSharedStateNextColorLabel(targetBucket.label);
      if (!shouldDeferMulticolorStepVisuals && !sharedStateLoopRunningRef.current) {
        setActivePaletteColorId(targetColorId);
        setLineTo(String(targetNextNailNumber));
        setLineFrom(String(targetNextNailNumber));
        setHiddenPreviewLineKey(
          getNormalizedLineKey(targetStartNailNumber, targetNextNailNumber),
        );
      }

      if (multicolorExperimentalSteppingMode === 'round-robin') {
        setMulticolorRoundRobinNextColorId(getNextRoundRobinColorId(targetColorId, nextBuckets));
      }
    };

    if (stepProfile) {
      stepProfile.meta = {
        ...stepProfile.meta,
        colorId: targetColorId,
        colorLabel: targetBucket.label,
        startNail: targetStartNailNumber,
        nextNail: targetNextNailNumber,
        score: Number(stepCandidate.score.toFixed(4)),
        flippedPixels: stepCandidate.flippedPixelCount ?? null,
        flippedCoverage: stepCandidate.flippedCoverage ?? null,
        linePixels: stepCandidate.pixelCount ?? null,
        totalCoverage: stepCandidate.coverageTotal ?? null,
      };
      stepProfile.measure('react state scheduling', scheduleStateUpdates);
      stepProfile.handlerEndAt = performance.now();
      pendingMulticolorStepProfileRef.current = stepProfile;
    } else {
      scheduleStateUpdates();
    }
    return {
      ok: true,
      colorLabel: targetBucket.label,
      startNailNumber: targetStartNailNumber,
      endNailNumber: targetNextNailNumber,
      totalLineCount: nextTotalLineCount,
    };
  };
  applyExperimentalStepRef.current = handleApplyExperimentalStep;

  const createSharedLoopWorkerInitPayload = () => ({
    nails,
    nailsCount,
    previewSize,
    imageCenter,
    imageScale,
    lineWidthPx: parseThreadWidthPxValue(threadWidth),
    fallbackStartNailNumber: hasValidFromIndex ? fromIndex : 1,
    colors: enabledPalettePreviewColors.map((color) => ({
      id: color.id,
      label: color.label,
      hex: color.hex,
      rgb: color.rgb,
    })),
    targetGeometriesByColorId: Array.from(sharedTargetRegionGeometriesRef.current.entries()),
    buckets: multicolorLineBucketsRef.current.map((bucket) => {
      const lines = [];
      forEachPackedLine(bucket.linesPacked, (line) => {
        lines.push({
          startNailNumber: line.startNailNumber,
          endNailNumber: line.endNailNumber,
          stepOrder: line.stepOrder,
        });
      });
      return {
        colorId: bucket.colorId,
        label: bucket.label,
        hex: bucket.hex,
        enabled: bucket.enabled,
        visible: bucket.visible,
        lineStrength: parseLineDarknessStep(bucket.lineStrength),
        minDistance: parseMinDistanceValue(bucket.minDistance),
        lastNailNumber: bucket.lastNailNumber,
        lines,
        lineCount: bucket.lineCount ?? getPackedLineCount(bucket.linesPacked),
      };
    }),
    plannedLinesByColorId: Array.from(plannedMulticolorLinesByColorId.entries()),
    monochromeUsedLineKeys: Array.from(monochromeUsedLineKeys),
    usedLineExclusionMode: multicolorUsedLineExclusionMode,
    lineStrengthMode: multicolorLineStrengthMode,
    minDistanceMode: multicolorMinDistanceMode,
    globalLineStrength: getLineDarknessStep(),
    globalMinDistance: parseMinDistanceValue(highlightRange),
    currentOverlapMode:
      typeof window !== 'undefined' &&
      ['candidate-local', 'fragment-index'].includes(window.__sharedLoopCurrentOverlapMode)
        ? window.__sharedLoopCurrentOverlapMode
        : 'global-union',
    nextStepOrder: multicolorLineStepOrderRef.current,
  });

  const pushWorkerSharedLineProfile = (line, mainApplyMs, totalLineCount, message) => {
    if (!isMulticolorStepProfilingEnabled || typeof window === 'undefined') {
      return;
    }

    const profileSummary = {
      mode: 'shared-best-worker',
      source: isPaletteDitheringEnabled ? 'dithered' : 'nearest',
      colorId: line.colorId,
      colorLabel: line.colorLabel,
      startNail: line.startNailNumber,
      nextNail: line.endNailNumber,
      score: Number((line.score ?? 0).toFixed(4)),
      flippedPixels: line.flippedPixelCount ?? null,
      flippedCoverage: line.flippedCoverage ?? null,
      linePixels: line.pixelCount ?? null,
      totalCoverage: line.coverageTotal ?? null,
      rows: [
        { bucket: 'shared best line search', ms: 0 },
        { bucket: 'worker solve', ms: Number((line.workerSolveMs ?? 0).toFixed(2)) },
        { bucket: 'line application', ms: Number(mainApplyMs.toFixed(2)) },
        { bucket: 'worker solver state update', ms: 0 },
        { bucket: 'react state scheduling', ms: 0 },
      ],
      handlerMs: Number(mainApplyMs.toFixed(2)),
      reactCommitMs: 0,
      totalUntilCommitMs: Number(mainApplyMs.toFixed(2)),
      workerBacked: true,
      wasHidden: Boolean(message.wasHidden),
      totalLineCount,
    };
    window.__multicolorStepProfiles = window.__multicolorStepProfiles ?? [];
    window.__multicolorStepProfiles.push(profileSummary);
  };

  const applyWorkerAcceptedSharedLine = (line, message = {}) => {
    const mainApplyStartedAt = performance.now();
    const didApplyLine = handleMakeLinePermanent(line.startNailNumber, line.endNailNumber, {
      lineDarknessStep: line.lineDarknessStep,
      lineColorRgb: line.colorRgb,
      colorId: line.colorId,
      skipActiveMaskLineApplication: true,
      skipVisibleSync: true,
      skipGlobalUsedLineCheck: true,
      skipGlobalUsedLineTracking: multicolorUsedLineExclusionMode === 'per-color',
    });
    const mainApplyEndedAt = performance.now();
    if (!didApplyLine) {
      return {
        ok: false,
        reason: 'Selected worker line could not be applied.',
      };
    }

    const currentBuckets = multicolorLineBucketsRef.current;
    const nextBuckets = currentBuckets.map((bucket) =>
      bucket.colorId === line.colorId
        ? {
            ...bucket,
            lastNailNumber: line.endNailNumber,
            linesPacked: appendPackedLine(
              bucket.linesPacked,
              line.startNailNumber,
              line.endNailNumber,
              line.stepOrder,
            ),
            lineCount: (bucket.lineCount ?? getPackedLineCount(bucket.linesPacked)) + 1,
          }
        : bucket,
    );
    multicolorLineBucketsRef.current = nextBuckets;
    multicolorLineStepOrderRef.current = Math.max(
      multicolorLineStepOrderRef.current,
      (line.stepOrder ?? 0) + 1,
    );
    const nextTotalLineCount = getMulticolorBucketTotalLineCount(nextBuckets);
    sharedLoopVisibleLineCountRef.current = nextTotalLineCount;
    setSharedLoopVisibleLineCount(nextTotalLineCount);
    maybeFlushSharedLoopBucketsToState();
    setSharedStateNextColorLabel(line.colorLabel);
    pushWorkerSharedLineProfile(line, mainApplyEndedAt - mainApplyStartedAt, nextTotalLineCount, message);

    if (typeof window !== 'undefined') {
      window.__sharedLoopWallStepEvents = window.__sharedLoopWallStepEvents ?? [];
      window.__sharedLoopWallStepEvents.push({
        count: window.__sharedLoopWallStepEvents.length + 1,
        applyMs: mainApplyEndedAt - mainApplyStartedAt,
        workerSolveMs: line.workerSolveMs ?? null,
        workerProfile: line.workerProfile ?? null,
        workerBatchOffsetMs: line.workerBatchOffsetMs ?? null,
        workerBatchMs: message.workerBatchMs ?? null,
        commitWaitMs: 0,
        totalBeforeYieldMs: mainApplyEndedAt - mainApplyStartedAt,
        totalLineCount: nextTotalLineCount,
        wasHidden: Boolean(message.wasHidden),
        workerBacked: true,
        workerTimestamp: message.workerTimestamp ?? null,
        workerPerformanceNow: message.workerPerformanceNow ?? null,
        timestamp: Date.now(),
        performanceNow: mainApplyEndedAt,
      });
    }

    return { ok: true };
  };

  const finalizeSharedStateLoop = (stopReason = 'Stopped.') => {
    sharedStateLoopStopRequestedRef.current = true;
    sharedLoopWorkerRef.current?.postMessage({ type: 'stop' });
    flushMulticolorLineBucketsToState({ force: true });
    sharedStateLoopRunningRef.current = false;
    if (isMountedRef.current) {
      setSharedStateLoopStatus(stopReason);
      setIsSharedStateLoopRunning(false);
    }
  };

  sharedLoopWorkerMessageHandlerRef.current = (message) => {
    if (message?.type === 'accepted-lines') {
      for (const line of message.lines ?? []) {
        if (
          !isMountedRef.current ||
          sharedStateLoopStopRequestedRef.current ||
          multicolorExperimentalSteppingModeRef.current !== 'shared-best'
        ) {
          break;
        }
        const result = applyWorkerAcceptedSharedLine(line, message);
        if (!result.ok) {
          finalizeSharedStateLoop(`Stopped: ${result.reason}`);
          break;
        }
      }
      return;
    }
    if (message?.type === 'initialized') {
      if (typeof window !== 'undefined') {
        window.__sharedLoopWorkerInitEvents = window.__sharedLoopWorkerInitEvents ?? [];
        window.__sharedLoopWorkerInitEvents.push({
          precomputeSummary: message.precomputeSummary ?? null,
          timestamp: Date.now(),
          performanceNow: performance.now(),
        });
      }
      return;
    }
    if (message?.type === 'stopped') {
      finalizeSharedStateLoop(message.reason ?? 'Stopped.');
    }
  };

  const getSharedLoopWorker = () => {
    if (sharedLoopWorkerRef.current) {
      return sharedLoopWorkerRef.current;
    }

    const worker = new Worker(
      new URL('./workers/sharedLoopDriver.worker.js', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (event) => {
      sharedLoopWorkerMessageHandlerRef.current?.(event.data);
    };
    worker.onerror = (event) => {
      finalizeSharedStateLoop(`Stopped: worker error${event.message ? `: ${event.message}` : '.'}`);
    };
    sharedLoopWorkerRef.current = worker;
    return worker;
  };

  const handleToggleSharedStateLoop = () => {
    if (sharedStateLoopRunningRef.current) {
      sharedStateLoopStopRequestedRef.current = true;
      sharedLoopWorkerRef.current?.postMessage({ type: 'stop' });
      flushMulticolorLineBucketsToState({ force: true });
      sharedStateLoopRunningRef.current = false;
      setSharedStateLoopStatus('Stopped: user requested stop.');
      setIsSharedStateLoopRunning(false);
      return;
    }

    if (multicolorExperimentalSteppingMode !== 'shared-best') {
      setSharedStateLoopStatus('Not started: stepping mode is not shared best.');
      return;
    }

    if (!canApplyExperimentalMulticolorStep) {
      setSharedStateLoopStatus('Not started: no eligible line can currently be applied.');
      return;
    }

    if (sharedTargetRegionGeometriesRef.current.size === 0) {
      rebuildSharedColorFlipMaps();
    }

    sharedStateLoopStopRequestedRef.current = false;
    sharedStateLoopRunningRef.current = true;
    sharedLoopBucketStateFlushPendingRef.current = false;
    sharedLoopLastBucketFlushAtRef.current = performance.now();
    sharedLoopVisibleLineCountRef.current = getMulticolorBucketTotalLineCount(
      multicolorLineBucketsRef.current,
    );
    setSharedLoopVisibleLineCount(sharedLoopVisibleLineCountRef.current);
    const worker = getSharedLoopWorker();
    worker.postMessage({
      type: 'init',
      payload: createSharedLoopWorkerInitPayload(),
    });
    window.setTimeout(() => {
      if (!isMountedRef.current || !sharedStateLoopRunningRef.current) {
        return;
      }
      setSharedStateLoopStatus('Running.');
      setIsSharedStateLoopRunning(true);
      worker.postMessage({
        type: 'start',
        isHidden: document.hidden,
      });
    }, 0);
  };

  const handlePerform9000Steps = async () => {
    if (isPerformingSteps) {
      pauseRequestedRef.current = true;
      return;
    }

    if (!imageCanvasRef.current || !imageSize || !hasValidFromIndex) {
      return;
    }

    const context = imageCanvasRef.current.getContext('2d', {
      willReadFrequently: true,
    });
    if (!context) {
      return;
    }

    const lineDarknessStep = getLineDarknessStep();
    const canvasImage = context.getImageData(0, 0, imageSize.width, imageSize.height);
    let activeColorMaskScoringImage = isActiveColorMaskScoringEnabled
      ? activeColorMaskScoringImageDataRef.current ?? buildActiveColorMaskScoringImageData(canvasImage)
      : null;
    if (isActiveColorMaskScoringEnabled) {
      activeColorMaskScoringImageDataRef.current = activeColorMaskScoringImage;
    }
    let currentFromIndex = fromIndex;
    let stepIndex = 0;

    pauseRequestedRef.current = false;
    setIsStepLoopPaused(false);
    setIsPerformingSteps(true);
    setHoveredPixel(null);

    try {
      while (stepIndex < 9000 && isMountedRef.current && !pauseRequestedRef.current) {
        const frameStart = await waitForNextWorkSlice();
        if (!isMountedRef.current) {
          break;
        }

        const sliceBudgetMs = document.hidden ? 90 : 12;
        const frameNails = [];
        while (
          stepIndex < 9000 &&
          isMountedRef.current &&
          !pauseRequestedRef.current &&
          performance.now() - frameStart < sliceBudgetMs
        ) {
          const nextNail = getNextNailForImageData(
            currentFromIndex,
            activeColorMaskScoringImage?.data ?? canvasImage.data,
          );
          if (nextNail === null) {
            stepIndex = 9000;
            break;
          }

          const didApplyLine = applyLineToImageData(
            canvasImage.data,
            currentFromIndex,
            nextNail,
            lineDarknessStep,
            lineBoostMapRef.current,
          );
          if (!didApplyLine) {
            stepIndex = 9000;
            break;
          }
          if (activeColorMaskScoringImage) {
            applyLineToImageData(
              activeColorMaskScoringImage.data,
              currentFromIndex,
              nextNail,
              lineDarknessStep,
            );
          }

          usedLineKeysRef.current.add(getNormalizedLineKey(currentFromIndex, nextNail));
          frameNails.push(nextNail);
          currentFromIndex = nextNail;
          stepIndex += 1;
        }

        if (frameNails.length > 0 && isMountedRef.current) {
          const latestNail = frameNails[frameNails.length - 1];
          if (!document.hidden) {
            context.putImageData(canvasImage, 0, 0);
            invalidateCurrentCanvasMaskCollectionCache();
            syncVisibleCanvas();
          }
          setLineTo(String(latestNail));
          setLineFrom(String(latestNail));
          setSavedNailSequence((currentSequence) => [...currentSequence, ...frameNails]);
        }
      }
    } finally {
      const didPause = pauseRequestedRef.current;
      pauseRequestedRef.current = false;
      if (isMountedRef.current) {
        context.putImageData(canvasImage, 0, 0);
        invalidateCurrentCanvasMaskCollectionCache();
        syncVisibleCanvas();
        setIsPerformingSteps(false);
        setIsStepLoopPaused(didPause);
      }
    }
  };

  const imageStyle = {
    top: 0,
    left: 0,
    width: imageSize ? `${imageSize.width * imageScale}px` : '0px',
    height: imageSize ? `${imageSize.height * imageScale}px` : '0px',
    transform: `translate(${previewSize / 2 - imageCenter.x * imageScale}px, ${previewSize / 2 - imageCenter.y * imageScale}px)`,
    cursor:
      isBrushMode && !isArtMode
        ? 'crosshair'
        : dragState?.mode === 'image'
          ? 'grabbing'
        : hasLoadedImage
            ? 'grab'
            : 'default',
    filter:
      isPalettePreviewVisible || isPaletteMaskVisible
        ? 'none'
        : shouldShowCurrentGrayscaleDebugView
          ? 'grayscale(1)'
          : shouldShowOriginalDebugView
            ? 'none'
            : shouldShowSharedResidualDebugView
            ? 'none'
            : isBlackAndWhite
              ? 'grayscale(1)'
              : 'none',
  };
  const imageLayerStyle = {
    width: imageSize ? `${imageSize.width * imageScale}px` : '0px',
    height: imageSize ? `${imageSize.height * imageScale}px` : '0px',
    transform: imageStyle.transform,
  };

  const previewStyle = {
    transform: `translate(${previewOffset.x}px, ${previewOffset.y}px) scale(${previewScale / 100})`,
    cursor: dragState?.mode === 'preview' ? 'grabbing' : 'default',
  };
  const inversePreviewScale = 100 / previewScale;
  const {
    nailFontSize,
    nailRadius,
    nails,
  } = useMemo(
    () => buildNails(nailsCount, inversePreviewScale),
    [nailsCount, inversePreviewScale],
  );
  useEffect(() => {
    nailsRef.current = nails;
  }, [nails]);
  useEffect(() => {
    isArtModeRef.current = isArtMode;
  }, [isArtMode]);
  useEffect(() => {
    committedMulticolorLineBucketsRef.current = multicolorLineBuckets;
    sharedLoopBucketStateFlushPendingRef.current = false;
    if (!sharedStateLoopRunningRef.current) {
      multicolorLineBucketsRef.current = multicolorLineBuckets;
      const committedLineCount = getMulticolorBucketTotalLineCount(multicolorLineBuckets);
      if (sharedLoopVisibleLineCountRef.current === committedLineCount) {
        sharedLoopVisibleLineCountRef.current = null;
        setSharedLoopVisibleLineCount(null);
      }
    }
  }, [multicolorLineBuckets]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    window.__debugGetMulticolorLineBuckets = () =>
      multicolorLineBucketsRef.current.map((bucket) => {
        const lines = [];
        forEachPackedLine(bucket.linesPacked, (line) => {
          lines.push({
            startNailNumber: line.startNailNumber,
            endNailNumber: line.endNailNumber,
            stepOrder: line.stepOrder,
          });
        });
        return {
          colorId: bucket.colorId,
          label: bucket.label,
          hex: bucket.hex,
          lineCount: bucket.lineCount ?? getPackedLineCount(bucket.linesPacked),
          lines,
        };
      });

    return () => {
      delete window.__debugGetMulticolorLineBuckets;
    };
  }, []);

  const fromIndex = Number.parseInt(lineFrom, 10);
  const toIndex = Number.parseInt(lineTo, 10);
  const hasValidLine =
    Number.isInteger(fromIndex) &&
    Number.isInteger(toIndex) &&
    fromIndex >= 1 &&
    toIndex >= 1 &&
    fromIndex <= nailsCount &&
    toIndex <= nailsCount;
  const lineStart = hasValidLine ? nails[fromIndex - 1] : null;
  const lineEnd = hasValidLine ? nails[toIndex - 1] : null;
  const hasValidFromIndex =
    Number.isInteger(fromIndex) && fromIndex >= 1 && fromIndex <= nailsCount;
  const activeColorExperimentFromIndex =
    activeMulticolorLineBucket?.lastNailNumber ??
    (hasValidFromIndex ? fromIndex : 1);
  const isSharedBestMulticolorStepping =
    isMulticolorLabEnabled &&
    isPalettePreviewEnabled &&
    multicolorExperimentalSteppingMode === 'shared-best';
  const shouldComputeGrayscaleLineTools = !isSharedBestMulticolorStepping;
  const shouldComputeAverageDarkness =
    shouldComputeGrayscaleLineTools &&
    !shouldDeferMulticolorStepVisuals &&
    !isArtMode &&
    hasLoadedImage &&
    lineStart &&
    lineEnd;
  const shouldComputeNextNail =
    shouldComputeGrayscaleLineTools &&
    !shouldDeferMulticolorStepVisuals &&
    hasLoadedImage &&
    hasValidFromIndex &&
    Boolean(imageSize);
  const needsImageData = shouldComputeAverageDarkness || shouldComputeNextNail;
  const imageData = measurePendingMulticolorRender('image data read', () =>
    needsImageData && imageCanvasRef.current && imageSize
      ? imageCanvasRef.current
          .getContext('2d', { willReadFrequently: true })
          ?.getImageData(0, 0, imageSize.width, imageSize.height).data ?? null
      : null,
  );
  const lineScoringImageData = isActiveColorMaskScoringEnabled
    ? activeColorMaskScoringImageDataRef.current?.data ?? null
    : imageData;
  let activeColorExperimentScoringImageData = null;
  if (
    canUseActiveColorMaskForLineScoring &&
    multicolorExperimentalSteppingMode !== 'shared-best'
  ) {
    activeColorExperimentScoringImageData = activeColorMaskScoringImageDataRef.current?.data ?? null;
    if (!activeColorExperimentScoringImageData) {
      const canvasImageData = measurePendingMulticolorRender(
        'active mask canvas read',
        getCanvasImageData,
      );
      const generatedMaskImageData = measurePendingMulticolorRender(
        'active mask rebuild',
        () => buildActiveColorMaskScoringImageData(canvasImageData),
      );
      if (generatedMaskImageData) {
        activeColorMaskScoringImageDataRef.current = generatedMaskImageData;
        activeColorExperimentScoringImageData = generatedMaskImageData.data;
      }
    }
  }

  const linePixels = measurePendingMulticolorRender('preview line pixels', () =>
    shouldComputeAverageDarkness
      ? getLinePixelsForIndexes(fromIndex, toIndex)
      : [],
  );
  const hasRenderableLine = linePixels.length > 1;
  const currentPreviewLineKey =
    hasValidLine ? getNormalizedLineKey(fromIndex, toIndex) : null;
  const isCurrentLineUsed =
    currentPreviewLineKey !== null && usedLineKeysRef.current.has(currentPreviewLineKey);
  const shouldShowPreviewLine =
    lineStart &&
    lineEnd &&
    !shouldDeferMulticolorStepVisuals &&
    currentPreviewLineKey !== hiddenPreviewLineKey &&
    !isCurrentLineUsed;

  let averageLineDarkness = null;
  if (linePixels.length > 0 && lineScoringImageData && imageSize) {
    const weightedDarkness = getWeightedAverageDarkness(lineScoringImageData, linePixels);
    averageLineDarkness =
      weightedDarkness === null ? null : Math.round(weightedDarkness);
  }

  let darknessSeries = [];
  if (shouldComputeNextNail && lineScoringImageData) {
    darknessSeries = measurePendingMulticolorRender('darkness chart', () =>
      nails.map((targetNail) => {
        const isUsedLine = usedLineKeysRef.current.has(
          getNormalizedLineKey(fromIndex, targetNail.number),
        );
        const pixels = getLinePixelsForIndexes(fromIndex, targetNail.number);
        const weightedDarkness = getWeightedAverageDarkness(lineScoringImageData, pixels);

        return {
          nail: targetNail.number,
          darkness: isUsedLine ? 255 : weightedDarkness ?? 255,
          isUsedLine,
        };
      }),
    );
  }

  const graphWidth = 320;
  const graphHeight = 120;
  const graphPadding = { top: 0, right: 0, bottom: 0, left: 0 };
  const graphInnerWidth = graphWidth - graphPadding.left - graphPadding.right;
  const graphInnerHeight = graphHeight - graphPadding.top - graphPadding.bottom;
  const barWidth =
    darknessSeries.length > 0 ? graphInnerWidth / darknessSeries.length : 0;
  const highlightDistance = Number.parseInt(highlightRange, 10);
  const hasHighlightDistance =
    Number.isInteger(highlightDistance) && highlightDistance >= 0 && hasValidFromIndex;
  const eligibleDarknessSeries =
    hasHighlightDistance
      ? darknessSeries.filter(
          (point) =>
            !point.isUsedLine &&
            getCircularNailDistance(point.nail, fromIndex, nailsCount) > highlightDistance,
        )
      : darknessSeries.filter((point) => !point.isUsedLine);
  const minimumDarkness =
    eligibleDarknessSeries.length > 0
      ? Math.min(...eligibleDarknessSeries.map((point) => point.darkness))
      : null;
  const darkestNails =
    minimumDarkness === null
      ? []
      : eligibleDarknessSeries.filter((point) => point.darkness === minimumDarkness);
  const nextNailNumber =
    shouldComputeNextNail && lineScoringImageData
      ? darkestNails[0]?.nail ?? null
      : null;
  const activeColorExperimentNextNailNumber = measurePendingMulticolorRender(
    'active color next nail',
    () =>
      multicolorExperimentalSteppingMode !== 'shared-best' &&
      activeMulticolorRemainingLineCount > 0 &&
      activeColorExperimentScoringImageData
        ? getNextNailForImageData(activeColorExperimentFromIndex, activeColorExperimentScoringImageData, {
            usedLineKeys: activeExperimentalBucketUsedLineKeys,
            minimumAllowedDistance:
              multicolorMinDistanceMode === 'shared'
                ? parseMinDistanceValue(highlightRange)
                : parseMinDistanceValue(activeMulticolorLineBucket?.minDistance),
          })
        : null,
  );
  const canApplyExperimentalMulticolorStep =
    canUseActiveColorMaskForLineScoring &&
    (
      (
        multicolorExperimentalSteppingMode === 'shared-best' ||
        multicolorExperimentalSteppingMode === 'round-robin'
      )
        ? eligibleMulticolorStepBuckets.length > 0
        : activeMulticolorRemainingLineCount > 0 && activeColorExperimentNextNailNumber !== null
    );

  useEffect(() => {
    if (multicolorExperimentalSteppingMode === 'shared-best') {
      return;
    }

    if (!sharedStateLoopRunningRef.current) {
      return;
    }

    sharedStateLoopStopRequestedRef.current = true;
    sharedStateLoopRunningRef.current = false;
    setSharedStateLoopStatus('Stopped: stepping mode changed.');
    setIsSharedStateLoopRunning(false);
  }, [multicolorExperimentalSteppingMode]);

  useEffect(() => {
    if (multicolorExperimentalSteppingMode !== 'shared-best') {
      setSharedStateNextColorLabel(null);
    }
  }, [multicolorExperimentalSteppingMode]);
  const darkestNailsKey = darkestNails.map((point) => point.nail).join(',');

  useEffect(() => {
    setIsMinimumDarknessExpanded(false);
  }, [minimumDarkness, darkestNailsKey]);

  const artPolygonWidth = useMemo(() => {
    if (previewSize <= 0) {
      return 0.2;
    }
    const threadWidthPixels = parseThreadWidthPxValue(threadWidth);
    return Math.max(0.05, (threadWidthPixels / previewSize) * 100);
  }, [previewSize, threadWidth]);
  const shouldBuildArtGeometry = isArtMode || isWhiteTestOverlayEnabled;
  const monochromeArtLineSegments = useMemo(
    () => {
      if (!shouldBuildArtGeometry) {
        return [];
      }
      return buildLinePolygonSegments(
        buildArtLineSegments(savedNailSequence, nails),
        artPolygonWidth,
      );
    },
    [artPolygonWidth, nails, savedNailSequence, shouldBuildArtGeometry],
  );
  const renderedExperimentalLines = useMemo(() => {
    if (!shouldBuildArtGeometry) {
      return [];
    }
    const visibleBucketsByColorId = new Map(
      multicolorLineBuckets
        .filter(
          (bucket) =>
            bucket.visible &&
            (bucket.lineCount ?? getPackedLineCount(bucket.linesPacked)) > 0,
        )
        .map((bucket) => [bucket.colorId, bucket]),
    );
    const activeInterleaveEntries = multicolorInterleaveOrder.filter((entry) =>
      visibleBucketsByColorId.has(entry.colorId),
    );

    if (activeInterleaveEntries.length === 0) {
      return [];
    }

    const occurrenceCountByColorId = new Map();
    for (const entry of activeInterleaveEntries) {
      occurrenceCountByColorId.set(
        entry.colorId,
        (occurrenceCountByColorId.get(entry.colorId) ?? 0) + 1,
      );
    }

    const slicedLinesByEntryId = new Map();
    for (const [colorId, bucket] of visibleBucketsByColorId) {
      const occurrenceCount = occurrenceCountByColorId.get(colorId) ?? 0;
      if (occurrenceCount <= 0) {
        continue;
      }

      const bucketLineCount = bucket.lineCount ?? getPackedLineCount(bucket.linesPacked);
      const lineSlices = splitWholeUnits(bucketLineCount, occurrenceCount);
      let lineOffset = 0;
      let occurrenceIndex = 1;

      for (const lineSliceCount of lineSlices) {
        const lineSlice = slicePackedLines(bucket.linesPacked, lineOffset, lineSliceCount);
        const mappedLines = [];
        forEachPackedLine(lineSlice, (line, index) => {
          mappedLines.push({
            startNailNumber: line.startNailNumber,
            endNailNumber: line.endNailNumber,
            stepOrder: line.stepOrder,
            colorId: bucket.colorId,
            label: bucket.label,
            hex: bucket.hex,
            visible: bucket.visible,
            key:
              `${bucket.colorId}-pass-${occurrenceIndex}-line-${index}` +
              `-${line.startNailNumber}-${line.endNailNumber}`,
          });
        });
        slicedLinesByEntryId.set(
          `${colorId}-pass-${occurrenceIndex}`,
          mappedLines,
        );
        lineOffset += lineSliceCount;
        occurrenceIndex += 1;
      }
    }

    const interleavedLines = activeInterleaveEntries.flatMap(
      (entry) => slicedLinesByEntryId.get(entry.id) ?? [],
    );

    return interleavedLines
      .map((line, renderOrderIndex) => ({
        ...line,
        renderOrderIndex,
      }))
      .sort((firstLine, secondLine) => {
        const firstHasStepOrder = Number.isInteger(firstLine.stepOrder);
        const secondHasStepOrder = Number.isInteger(secondLine.stepOrder);
        if (firstHasStepOrder && secondHasStepOrder) {
          return firstLine.stepOrder - secondLine.stepOrder;
        }
        if (firstHasStepOrder !== secondHasStepOrder) {
          return firstHasStepOrder ? 1 : -1;
        }
        return firstLine.renderOrderIndex - secondLine.renderOrderIndex;
      })
      .map(({ renderOrderIndex, ...line }) => line);
  }, [multicolorInterleaveOrder, multicolorLineBuckets, shouldBuildArtGeometry]);
  const experimentalArtLineSegments = useMemo(
    () => {
      if (!shouldBuildArtGeometry) {
        return [];
      }
      return buildLinePolygonSegments(
        buildManualArtLineSegments(
          renderedExperimentalLines
            .map((line) => ({
              startNailNumber: line.startNailNumber,
              endNailNumber: line.endNailNumber,
              stroke: line.hex,
              colorId: line.colorId ?? null,
            })),
          nails,
          'experimental-art-line',
        ),
        artPolygonWidth,
      );
    },
    [artPolygonWidth, nails, renderedExperimentalLines, shouldBuildArtGeometry],
  );
  const artHoverLines = useMemo(() => {
    if (!isArtMode) {
      return [];
    }
    const monochromeLines = savedNailSequence
      .map((endNailNumber, index) => ({
        startNailNumber: index === 0 ? 1 : savedNailSequence[index - 1],
        endNailNumber,
        colorId: null,
      }))
      .filter(
        (line) =>
          Number.isInteger(line.startNailNumber) &&
          Number.isInteger(line.endNailNumber) &&
          line.startNailNumber > 0 &&
          line.endNailNumber > 0,
      );
    const experimentalLines = renderedExperimentalLines.map((line) => ({
      startNailNumber: line.startNailNumber,
      endNailNumber: line.endNailNumber,
      colorId: line.colorId ?? null,
    }));

    return isExperimentalColorLinesOnlyPreviewEnabled
      ? experimentalLines
      : [...monochromeLines, ...experimentalLines];
  }, [
    isExperimentalColorLinesOnlyPreviewEnabled,
    renderedExperimentalLines,
    savedNailSequence,
  ]);
  const allArtLineSegments = useMemo(
    () =>
      isExperimentalColorLinesOnlyPreviewEnabled
        ? experimentalArtLineSegments
        : [...monochromeArtLineSegments, ...experimentalArtLineSegments],
    [
      experimentalArtLineSegments,
      isExperimentalColorLinesOnlyPreviewEnabled,
      monochromeArtLineSegments,
    ],
  );
  const artLineSegments = useMemo(
    () => (isArtMode ? allArtLineSegments : []),
    [allArtLineSegments, isArtMode],
  );
  const shouldComputeExactColorAreas = isWhiteTestOverlayEnabled;
  const exactColorAreaStats = useMemo(() => {
    if (!shouldComputeExactColorAreas) {
      return EMPTY_EXACT_COLOR_AREA_STATS;
    }
    const { totalArea, areasById, geometriesById } = computeExactColorRegions({
      artLineSegments: allArtLineSegments,
      paletteColors: multicolorPaletteColors,
    });
    const stats = [
      {
        id: VECTOR_WHITE_REGION_ID,
        label: 'white',
        hex: '#ffffff',
        area: areasById.get(VECTOR_WHITE_REGION_ID) ?? 0,
      },
      {
        id: VECTOR_BLACK_REGION_ID,
        label: 'black',
        hex: '#020617',
        area: areasById.get(VECTOR_BLACK_REGION_ID) ?? 0,
      },
      ...multicolorPaletteColors.map((color) => ({
        id: color.id,
        label: color.label,
        hex: color.hex,
        area: areasById.get(color.id) ?? 0,
      })),
    ].map((entry) => ({
      ...entry,
      percent: totalArea > 0 ? (entry.area / totalArea) * 100 : 0,
    }));

    return {
      totalArea,
      stats,
      geometriesById,
    };
  }, [allArtLineSegments, multicolorPaletteColors, shouldComputeExactColorAreas]);
  const whiteTestOverlayPathData = useMemo(() => {
    if (!isWhiteTestOverlayEnabled) {
      return '';
    }
    const whiteGeometry =
      exactColorAreaStats?.geometriesById?.get(VECTOR_WHITE_REGION_ID) ?? [];
    return multiPolygonToSvgPathData(whiteGeometry);
  }, [exactColorAreaStats, isWhiteTestOverlayEnabled]);
  const activeGroup =
    pixelGroups.find((group) => group.id === activeGroupId) ?? pixelGroups[0] ?? null;
  const averageLineDarknessDisplay =
    averageLineDarkness === null ? 'none' : String(averageLineDarkness);

  const handleResetImage = () => {
    if (!imageCanvasRef.current || !imageSize || !originalImageDataRef.current) {
      return;
    }

    const context = imageCanvasRef.current.getContext('2d', {
      willReadFrequently: true,
    });
    if (!context) {
      return;
    }

    lineBoostMapRef.current?.fill(0);
    usedLineKeysRef.current = new Set();
    writeProcessedImageData(
      context,
      originalImageDataRef.current,
      imageSize.width,
      imageSize.height,
      Number.parseInt(contrast, 10),
      lineBoostMapRef.current,
      MIN_CONTRAST,
      MAX_CONTRAST,
      DEFAULT_CONTRAST,
    );
    invalidateCurrentCanvasMaskCollectionCache();
    activeColorMaskScoringImageDataRef.current = isActiveColorMaskScoringEnabled
      ? buildActiveColorMaskScoringImageData(
          context.getImageData(0, 0, imageSize.width, imageSize.height),
        )
      : null;
    syncVisibleCanvas();
    setSavedNailSequence([]);
    setMulticolorLineBuckets(
      createMulticolorLineBuckets(
        multicolorPaletteColors,
        getLineDarknessStep(),
        parseMinDistanceValue(highlightRange),
      ),
    );
    multicolorLineStepOrderRef.current = 1;
    setIsExperimentalColorLinesOnlyPreviewEnabled(false);
    setMulticolorExperimentalSteppingMode('shared-best');
    setMulticolorRoundRobinNextColorId(null);
    setIsStepLoopPaused(false);
    setHiddenPreviewLineKey(currentPreviewLineKey);
    setHoveredPixel(null);
  };

  const handleRefreshMulticolorPreviews = () => {
    rebuildSharedColorFlipMaps();
    syncVisibleCanvas();
    if (!canUseActiveColorMaskForLineScoring) {
      setActiveMulticolorTargetImage(null);
      return;
    }

    const canvasImageData = getCanvasImageData();
    const nextTargetImage = buildActiveColorMaskScoringImageData(canvasImageData);
    if (isActiveColorMaskScoringEnabled) {
      activeColorMaskScoringImageDataRef.current = nextTargetImage;
    }
    setActiveMulticolorTargetImage(nextTargetImage);
  };

  const handleFindBestFitPalette = () => {
    if (!originalImageDataRef.current) {
      return;
    }

    const nextPaletteColors = findBestFitPaletteColors(
      originalImageDataRef.current,
      clamp(
        multicolorPaletteFinderColorCount,
        MIN_PALETTE_FINDER_COLOR_COUNT,
        MAX_PALETTE_FINDER_COLOR_COUNT,
      ),
      imageCenter,
      imageScale,
      previewSize,
    );
    if (nextPaletteColors.length === 0) {
      return;
    }

    setMulticolorPalettePresetId('custom-found-palette');
    setMulticolorPaletteColors(nextPaletteColors);
    setActivePaletteColorId(nextPaletteColors[0].id);
    setMulticolorLockedLineOverride(null);
    setMulticolorRoundRobinNextColorId(null);
  };

  const handleToggleMulticolorBucketVisibility = (colorId, isVisible) => {
    setMulticolorLineBuckets((currentBuckets) =>
      currentBuckets.map((bucket) =>
        bucket.colorId === colorId
          ? {
              ...bucket,
              visible: isVisible,
            }
          : bucket,
      ),
    );
  };

  const handleSoloMulticolorBucket = (colorId) => {
    setMulticolorLineBuckets((currentBuckets) =>
      currentBuckets.map((bucket) => ({
        ...bucket,
        visible: bucket.colorId === colorId,
      })),
    );
    setActivePaletteColorId(colorId);
  };

  const handleShowAllMulticolorBuckets = () => {
    setMulticolorLineBuckets((currentBuckets) =>
      currentBuckets.map((bucket) => ({
        ...bucket,
        visible: true,
      })),
    );
  };

  const handleSetMulticolorBucketLineStrength = (colorId, nextLineStrength) => {
    setMulticolorLineBuckets((currentBuckets) =>
      currentBuckets.map((bucket) =>
        bucket.colorId === colorId
          ? {
              ...bucket,
              lineStrength: parseLineDarknessStep(nextLineStrength),
            }
          : bucket,
      ),
    );
  };

  const handleSetMulticolorBucketMinDistance = (colorId, nextMinDistance) => {
    setMulticolorLineBuckets((currentBuckets) =>
      currentBuckets.map((bucket) =>
        bucket.colorId === colorId
          ? {
              ...bucket,
              minDistance: parseMinDistanceValue(nextMinDistance),
            }
          : bucket,
      ),
    );
  };

  const handleMoveMulticolorInterleaveEntryUp = (entryId) => {
    setMulticolorInterleaveEntryIds((currentEntryIds) => {
      const currentIndex = currentEntryIds.indexOf(entryId);
      if (currentIndex <= 0) {
        return currentEntryIds;
      }
      return moveArrayItem(currentEntryIds, currentIndex, currentIndex - 1);
    });
  };

  const handleMoveMulticolorInterleaveEntryDown = (entryId) => {
    setMulticolorInterleaveEntryIds((currentEntryIds) => {
      const currentIndex = currentEntryIds.indexOf(entryId);
      if (currentIndex < 0 || currentIndex >= currentEntryIds.length - 1) {
        return currentEntryIds;
      }
      return moveArrayItem(currentEntryIds, currentIndex, currentIndex + 1);
    });
  };

  const handleResetMulticolorInterleaveOrder = () => {
    setMulticolorInterleaveEntryIds(
      defaultMulticolorInterleaveEntries.map((entry) => entry.id),
    );
  };

  const handleResetMulticolorBucket = (colorId) => {
    const nextBuckets = multicolorLineBuckets.map((bucket) =>
      bucket.colorId === colorId
        ? {
            ...bucket,
            lastNailNumber: null,
            linesPacked: new Uint16Array(0),
            lineCount: 0,
          }
        : bucket,
    );
    setMulticolorLineBuckets(nextBuckets);
    setIsExperimentalColorLinesOnlyPreviewEnabled(
      nextBuckets.some((bucket) => (bucket.lineCount ?? getPackedLineCount(bucket.linesPacked)) > 0) &&
      isExperimentalColorLinesOnlyPreviewEnabled,
    );
    rebuildCanvasFromStoredLineState(savedNailSequence, nextBuckets, activePaletteColorId);
  };

  const handleResetAllMulticolorState = () => {
    const nextBuckets = multicolorLineBuckets.map((bucket) => ({
      ...bucket,
      lastNailNumber: null,
      linesPacked: new Uint16Array(0),
      lineCount: 0,
    }));
    setMulticolorLineBuckets(nextBuckets);
    setIsExperimentalColorLinesOnlyPreviewEnabled(false);
    setMulticolorRoundRobinNextColorId(
      getNextRoundRobinColorId(
        activePaletteColorId,
        nextBuckets,
      ),
    );
    const fallbackNailNumber = savedNailSequence[savedNailSequence.length - 1] ?? 1;
    setLineFrom(String(fallbackNailNumber));
    setLineTo(String(fallbackNailNumber));
    setHiddenPreviewLineKey(null);
    rebuildCanvasFromStoredLineState(savedNailSequence, nextBuckets, activePaletteColorId);
  };

  const handleExportMulticolorSession = () => {
    const exportLineBuckets = sharedStateLoopRunningRef.current
      ? multicolorLineBucketsRef.current
      : multicolorLineBuckets;
    const fileBaseName = imageName
      ? imageName.replace(/\.[^.]+$/, '')
      : 'string-art';
    const multicolorSession = {
      version: 4,
      palettePresetId: multicolorPalettePresetId,
      paletteColors: multicolorPaletteColors,
      activePaletteColorId,
      isMulticolorLabEnabled,
      isPalettePreviewEnabled,
      isPaletteDitheringEnabled,
      multicolorDebugView,
      maskBlurRadius,
      multicolorPaletteFinderColorCount,
      multicolorTargetTotalLines,
      multicolorLockedLineOverride,
      multicolorExperimentalSteppingMode,
      multicolorRoundRobinNextColorId,
      multicolorUsedLineExclusionMode,
      multicolorLineStrengthMode,
      multicolorMinDistanceMode,
      lineCoverageBackendId,
      threadWidthPx: parseThreadWidthPxValue(threadWidth),
      multicolorInterleaveEntryIds,
      isExperimentalColorLinesOnlyPreviewEnabled,
      lineBuckets: exportLineBuckets.map((bucket) => ({
        ...bucket,
        linesPacked: Array.from(bucket.linesPacked ?? []),
        lineCount: bucket.lineCount ?? getPackedLineCount(bucket.linesPacked),
      })),
    };
    const exportUrl = URL.createObjectURL(
      new Blob([JSON.stringify(multicolorSession, null, 2)], { type: 'application/json' }),
    );
    const downloadLink = document.createElement('a');
    downloadLink.href = exportUrl;
    downloadLink.download = `${fileBaseName}-multicolor-session.json`;
    downloadLink.click();
    URL.revokeObjectURL(exportUrl);
  };

  const handleImportMulticolorSession = async (file) => {
    if (!file) {
      return;
    }

    try {
      const rawSession = JSON.parse(await file.text());
      const nextPaletteColors = Array.isArray(rawSession?.paletteColors)
        ? rawSession.paletteColors
            .map((color) => ({
              id: typeof color?.id === 'string' ? color.id : null,
              label: typeof color?.label === 'string' ? color.label : null,
              hex: typeof color?.hex === 'string' ? color.hex : null,
              enabled: Boolean(color?.enabled),
            }))
            .filter((color) => color.id && color.label && color.hex)
        : [];
      if (nextPaletteColors.length === 0) {
        throw new Error('Missing palette colors');
      }

      const paletteColorIds = new Set(nextPaletteColors.map((color) => color.id));
      const importedBucketsByColorId = new Map(
        Array.isArray(rawSession?.lineBuckets)
          ? rawSession.lineBuckets
              .filter((bucket) => paletteColorIds.has(bucket?.colorId))
              .map((bucket) => [
                bucket.colorId,
                {
                  visible: bucket?.visible !== false,
                  enabled: bucket?.enabled !== false,
                  lineStrength: parseLineDarknessStep(bucket?.lineStrength),
                  minDistance: parseMinDistanceValue(bucket?.minDistance),
                  lastNailNumber:
                    Number.isInteger(bucket?.lastNailNumber) && bucket.lastNailNumber > 0
                      ? bucket.lastNailNumber
                      : null,
                  linesPacked: Array.isArray(bucket?.linesPacked)
                    ? (() => {
                        const values = bucket.linesPacked
                          .map((value) => Number.parseInt(value, 10))
                          .filter((value) => Number.isInteger(value) && value > 0);
                        return Uint16Array.from(values);
                      })()
                    : Array.isArray(bucket?.lines)
                      ? (() => {
                          const packedLines = [];
                          let fallbackStepOrder = 1;
                          for (const line of bucket.lines) {
                            const startNailNumber = Number.isInteger(line?.startNailNumber)
                              ? line.startNailNumber
                              : null;
                            const endNailNumber = Number.isInteger(line?.endNailNumber)
                              ? line.endNailNumber
                              : null;
                            if (
                              !Number.isInteger(startNailNumber) ||
                              !Number.isInteger(endNailNumber) ||
                              startNailNumber <= 0 ||
                              endNailNumber <= 0
                            ) {
                              continue;
                            }
                            const stepOrder = Number.isInteger(line?.stepOrder)
                              ? line.stepOrder
                              : fallbackStepOrder;
                            packedLines.push(startNailNumber, endNailNumber, stepOrder);
                            fallbackStepOrder += 1;
                          }
                          return Uint16Array.from(packedLines);
                        })()
                      : new Uint16Array(0),
                },
              ])
          : [],
      );
      const nextBuckets = nextPaletteColors.map((color) => {
        const importedBucket = importedBucketsByColorId.get(color.id);
        return {
          colorId: color.id,
          label: color.label,
          hex: color.hex,
          enabled: importedBucket?.enabled ?? color.enabled,
          visible: importedBucket?.visible ?? true,
          lineStrength: importedBucket?.lineStrength ?? parseLineDarknessStep(lineStrength),
          minDistance: importedBucket?.minDistance ?? parseMinDistanceValue(highlightRange),
          lastNailNumber: importedBucket?.lastNailNumber ?? null,
          linesPacked: importedBucket?.linesPacked ?? new Uint16Array(0),
          lineCount: getPackedLineCount(importedBucket?.linesPacked ?? new Uint16Array(0)),
        };
      });
      const nextActivePaletteColorId = paletteColorIds.has(rawSession?.activePaletteColorId)
        ? rawSession.activePaletteColorId
        : nextPaletteColors.find((color) => color.enabled)?.id ?? nextPaletteColors[0].id;
      const nextLockedLineOverride =
        rawSession?.multicolorLockedLineOverride &&
        paletteColorIds.has(rawSession.multicolorLockedLineOverride.colorId)
          ? {
              colorId: rawSession.multicolorLockedLineOverride.colorId,
              lineCount: Math.max(
                0,
                Number.parseInt(rawSession.multicolorLockedLineOverride.lineCount, 10) || 0,
              ),
            }
          : null;

      setMulticolorPalettePresetId(
        typeof rawSession?.palettePresetId === 'string'
          ? rawSession.palettePresetId
          : multicolorPalettePresetId,
      );
      setMulticolorPaletteColors(nextPaletteColors);
      setActivePaletteColorId(nextActivePaletteColorId);
      setIsMulticolorLabEnabled(rawSession?.isMulticolorLabEnabled !== false);
      setIsPalettePreviewEnabled(rawSession?.isPalettePreviewEnabled !== false);
      setIsPaletteDitheringEnabled(Boolean(rawSession?.isPaletteDitheringEnabled));
      setMulticolorDebugView(
        typeof rawSession?.multicolorDebugView === 'string'
          ? rawSession.multicolorDebugView
          : multicolorDebugView,
      );
      setMaskBlurRadius(
        Math.max(0, Number.parseInt(rawSession?.maskBlurRadius, 10) || 0),
      );
      setMulticolorTargetTotalLines(
        Math.max(
          0,
          Number.parseInt(
            rawSession?.multicolorTargetTotalLines,
            10,
          ) || DEFAULT_MULTICOLOR_TARGET_TOTAL_LINES,
        ),
      );
      setMulticolorPaletteFinderColorCount(
        clamp(
          Number.parseInt(rawSession?.multicolorPaletteFinderColorCount, 10) ||
            DEFAULT_PALETTE_FINDER_COLOR_COUNT,
          MIN_PALETTE_FINDER_COLOR_COUNT,
          MAX_PALETTE_FINDER_COLOR_COUNT,
        ),
      );
      setMulticolorLockedLineOverride(nextLockedLineOverride);
      setMulticolorExperimentalSteppingMode(
        ['shared-best', 'round-robin', 'single-color'].includes(
          rawSession?.multicolorExperimentalSteppingMode,
        )
          ? rawSession.multicolorExperimentalSteppingMode
          : 'shared-best',
      );
      setMulticolorRoundRobinNextColorId(
        paletteColorIds.has(rawSession?.multicolorRoundRobinNextColorId)
          ? rawSession.multicolorRoundRobinNextColorId
          : null,
      );
      setMulticolorUsedLineExclusionMode(
        rawSession?.multicolorUsedLineExclusionMode === 'per-color' ? 'per-color' : 'shared',
      );
      setMulticolorLineStrengthMode(
        rawSession?.multicolorLineStrengthMode === 'per-color' ? 'per-color' : 'shared',
      );
      setMulticolorMinDistanceMode(
        rawSession?.multicolorMinDistanceMode === 'per-color' ? 'per-color' : 'shared',
      );
      setLineCoverageBackendId(
        LINE_COVERAGE_BACKENDS.some((backend) => backend.id === rawSession?.lineCoverageBackendId)
          ? rawSession.lineCoverageBackendId
          : DEFAULT_LINE_COVERAGE_BACKEND,
      );
      setThreadWidth(
        String(
          parseThreadWidthPxValue(
            rawSession?.threadWidthPx ?? rawSession?.threadWidth,
          ),
        ),
      );
      setMulticolorInterleaveEntryIds(
        Array.isArray(rawSession?.multicolorInterleaveEntryIds)
          ? rawSession.multicolorInterleaveEntryIds.filter((entryId) => typeof entryId === 'string')
          : [],
      );
      setIsExperimentalColorLinesOnlyPreviewEnabled(
        Boolean(rawSession?.isExperimentalColorLinesOnlyPreviewEnabled) &&
        nextBuckets.some((bucket) => (bucket.lineCount ?? getPackedLineCount(bucket.linesPacked)) > 0),
      );
      setMulticolorLineBuckets(nextBuckets);
      const importedMaxStepOrder = nextBuckets.reduce((maximumOrder, bucket) => {
        let bucketMaxOrder = 0;
        forEachPackedLine(bucket.linesPacked, (line) => {
          if (Number.isInteger(line.stepOrder)) {
            bucketMaxOrder = Math.max(bucketMaxOrder, line.stepOrder);
          }
        });
        return Math.max(maximumOrder, bucketMaxOrder);
      }, 0);
      multicolorLineStepOrderRef.current = importedMaxStepOrder + 1;
      setHiddenPreviewLineKey(null);
      rebuildCanvasFromStoredLineState(savedNailSequence, nextBuckets, nextActivePaletteColorId);
    } catch (error) {
      window.alert('Could not import the multicolor session JSON.');
    }
  };

  const handleExportNailList = () => {
    const nailListContent = [1, ...savedNailSequence].join('\n');
    const fileBaseName = imageName
      ? imageName.replace(/\.[^.]+$/, '')
      : 'string-art';
    const exportUrl = URL.createObjectURL(new Blob([nailListContent], { type: 'text/plain' }));
    const downloadLink = document.createElement('a');
    downloadLink.href = exportUrl;
    downloadLink.download = `${fileBaseName}-nail-list.txt`;
    downloadLink.click();
    URL.revokeObjectURL(exportUrl);
  };

  return (
    <Profiler id="App" onRender={handleReactProfile}>
      <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top-row">
          <label className="upload-field">
            <span>Choose image</span>
            <input
              type="file"
              accept="image/*"
              onChange={handleFileChange}
            />
          </label>
          <form
            action="https://www.paypal.com/donate"
            method="post"
            target="_top"
            className="donate-form"
          >
            <input
              type="hidden"
              name="hosted_button_id"
              value="MRJF9A83YR2BE"
            />
            <input
              type="image"
              alt="Donate with PayPal button"
              src="https://www.paypalobjects.com/en_US/IL/i/btn/btn_donateCC_LG.gif"
              border="0"
              name="submit"
              title="PayPal - The safer, easier way to pay online!"
            />
          </form>
        </div>

        <div className="panel">
          <div className="nail-controls">
            <label className="slider-control slider-control-wide">
              <span>Nails: {nailsCount}</span>
              <input
                type="range"
                min="0"
                max="300"
                step="1"
                value={nailsCount}
                onChange={(event) => {
                  setNailsCount(clamp(Number(event.target.value), 0, 300));
                }}
              />
            </label>

            <div className="line-inputs">
              <label className="slider-control line-input">
                <span>From: {lineFrom || 1}</span>
                <input
                  type="range"
                  min="1"
                  max={Math.max(nailsCount, 1)}
                  step="1"
                  value={lineFrom === '' ? 1 : lineFrom}
                  onChange={(event) => setLineFrom(event.target.value)}
                />
              </label>
              <label className="slider-control line-input">
                <span>To: {lineTo || 1}</span>
                <input
                  type="range"
                  min="1"
                  max={Math.max(nailsCount, 1)}
                  step="1"
                  value={lineTo === '' ? 1 : lineTo}
                  onChange={(event) => setLineTo(event.target.value)}
                />
              </label>
              <label className="slider-control line-input">
                <span>Min distance: {highlightRange}</span>
                <input
                  type="range"
                  min={MIN_HIGHLIGHT_DISTANCE}
                  max={MAX_HIGHLIGHT_DISTANCE}
                  step="1"
                  value={highlightRange}
                  onChange={(event) => {
                    setHighlightRange(
                      String(
                        clamp(
                          Number(event.target.value),
                          MIN_HIGHLIGHT_DISTANCE,
                          MAX_HIGHLIGHT_DISTANCE,
                        ),
                      ),
                    );
                  }}
                />
              </label>
              <label className="slider-control line-input">
                <span>Line strength: {lineStrength}</span>
                <input
                  type="range"
                  min={MIN_LINE_STRENGTH}
                  max={MAX_LINE_STRENGTH}
                  step="1"
                  value={lineStrength}
                  onChange={(event) => {
                    setLineStrength(
                      String(
                        clamp(
                          Number(event.target.value),
                          MIN_LINE_STRENGTH,
                          MAX_LINE_STRENGTH,
                        ),
                      ),
                    );
                  }}
                />
              </label>
            </div>
            <label className="slider-control slider-control-wide">
              <span>Line width: {parseThreadWidthPxValue(threadWidth).toFixed(2)}px</span>
              <input
                type="range"
                min={MIN_THREAD_WIDTH_PX}
                max={MAX_THREAD_WIDTH_PX}
                step="0.05"
                value={threadWidth}
                onChange={(event) => {
                  setThreadWidth(
                    String(parseThreadWidthPxValue(event.target.value)),
                  );
                }}
              />
            </label>
            <label className="slider-control slider-control-wide">
              <span>Contrast: {contrast}%</span>
              <input
                type="range"
                min={MIN_CONTRAST}
                max={MAX_CONTRAST}
                step="1"
                value={contrast}
                onChange={(event) => {
                  setContrast(
                    String(
                      clamp(
                        Number(event.target.value),
                        MIN_CONTRAST,
                        MAX_CONTRAST,
                      ),
                    ),
                  );
                }}
              />
            </label>
          </div>
          <p className="line-darkness">
            Average darkness: {averageLineDarknessDisplay}
          </p>
          <p className="line-darkness-source">
            Scoring source: {lineScoringModeLabel}
          </p>
          {darknessSeries.length > 0 && (
            <div className="darkness-chart">
              <svg
                viewBox={`0 0 ${graphWidth} ${graphHeight}`}
                aria-label="Average darkness by target nail"
              >
                <line
                  className="chart-axis"
                  x1={graphPadding.left}
                  y1={graphPadding.top}
                  x2={graphPadding.left}
                  y2={graphHeight - graphPadding.bottom}
                />
                <line
                  className="chart-axis"
                  x1={graphPadding.left}
                  y1={graphHeight - graphPadding.bottom}
                  x2={graphWidth - graphPadding.right}
                  y2={graphHeight - graphPadding.bottom}
                />
                {darknessSeries.map((point, index) => {
                  const barHeight = (point.darkness / 255) * graphInnerHeight;
                  const x = graphPadding.left + index * barWidth;
                  const y =
                    graphHeight - graphPadding.bottom - barHeight;
                  const isWithinHighlightDistance =
                    hasHighlightDistance &&
                    getCircularNailDistance(point.nail, fromIndex, nailsCount) <= highlightDistance;

                  return (
                    <rect
                      key={`bar-${point.nail}`}
                      className={[
                        'chart-bar',
                        point.nail === toIndex ? 'is-active' : '',
                        isWithinHighlightDistance ? 'is-range-highlighted' : '',
                      ].filter(Boolean).join(' ')}
                      x={x}
                      y={y}
                      width={Math.max(barWidth + 0.35, 0.6)}
                      height={barHeight}
                    />
                  );
                })}
                <text
                  className="chart-label"
                  x={graphPadding.left}
                  y={graphHeight - 4}
                >
                  1
                </text>
                <text
                  className="chart-label"
                  x={graphWidth - graphPadding.right}
                  y={graphHeight - 4}
                  textAnchor="end"
                >
                  {nailsCount}
                </text>
                <text
                  className="chart-label"
                  x={10}
                  y={graphPadding.top + 4}
                >
                  255
                </text>
                <text
                  className="chart-label"
                  x={14}
                  y={graphHeight - graphPadding.bottom}
                  dominantBaseline="ideographic"
                >
                  0
                </text>
              </svg>
              {darkestNails.length > 0 && (
                <p className="chart-minimum">
                  {darkestNails.length > 1 && !isMinimumDarknessExpanded ? (
                    <>
                      Minimum darkness {Math.round(minimumDarkness)} at{' '}
                      <button
                        className="chart-minimum-toggle"
                        type="button"
                        onClick={() => setIsMinimumDarknessExpanded(true)}
                      >
                        many
                      </button>{' '}
                      nails
                    </>
                  ) : (
                    <>
                      Minimum darkness outside of red area: {Math.round(minimumDarkness)} at nail
                      {darkestNails.length > 1 ? 's' : ''} {darkestNails.map((point) => point.nail).join(', ')}
                    </>
                  )}
                </p>
              )}
            </div>
          )}
          <button
            className="action-button action-button-secondary"
            type="button"
            onClick={handleSetNextNail}
            disabled={nextNailNumber === null}
          >
            Set next nail {nextNailNumber ?? '-'}
          </button>
          <button
            className="action-button"
            type="button"
            onClick={handleMakeCurrentLinePermanent}
            disabled={!hasRenderableLine || isCurrentLineUsed}
          >
            make line permanent
          </button>
          <button
            className="action-button action-button-secondary"
            type="button"
            onClick={handleSetFromCurrentTo}
            disabled={lineTo === ''}
          >
            Set &apos;from&apos; {lineTo || '-'}
          </button>
          <button
            className="action-button action-button-secondary"
            type="button"
            onClick={handleAllOfTheAbove}
            disabled={nextNailNumber === null}
          >
            all of the above once
          </button>
          <button
            className="action-button action-button-secondary"
            type="button"
            onClick={handlePerform9000Steps}
            disabled={
              !isPerformingSteps &&
              (
                !imageCanvasRef.current ||
                !imageSize ||
                !hasValidFromIndex
              )
            }
          >
            {isPerformingSteps
              ? `pause at ${savedNailSequence.length}`
              : isStepLoopPaused
                ? `continue (${savedNailSequence.length})`
                : 'loop all of the above'}
          </button>
          <button
            className="action-button action-button-secondary"
            type="button"
            onClick={() => {
              setIsArtMode((currentValue) => !currentValue);
              setHoveredPixel(null);
            }}
            disabled={isPerformingSteps}
          >
            {isArtMode ? 'switch to algorithm' : 'switch to art'}
          </button>
          <div className="panel-footer-actions">
            <button
              className="action-button action-button-secondary"
              type="button"
              onClick={handleResetImage}
              disabled={!hasLoadedImage || isPerformingSteps}
            >
              reset
            </button>
            <button
              className="action-button action-button-secondary"
              type="button"
              onClick={handleExportNailList}
              disabled={savedNailSequence.length === 0}
            >
              export nail list
            </button>
          </div>
          {SHOW_BRUSH_PANEL && (
            <Profiler id="BrushPanel" onRender={handleReactProfile}>
              <BrushPanel
                activeGroup={activeGroup}
                activeGroupId={activeGroupId}
                brushRadius={brushRadius}
                groupValueStep={GROUP_VALUE_STEP}
                hasLoadedImage={hasLoadedImage}
                isArtMode={isArtMode}
                isBrushMode={isBrushMode}
                maxBrushRadius={MAX_BRUSH_RADIUS}
                maxGroupValue={MAX_GROUP_VALUE}
                minBrushRadius={MIN_BRUSH_RADIUS}
                minGroupValue={MIN_GROUP_VALUE}
                onActiveGroupChange={setActiveGroupId}
                onAddPixelGroup={handleAddPixelGroup}
                onBrushModeChange={setIsBrushMode}
                onBrushRadiusChange={(nextValue) => {
                  setBrushRadius(
                    clamp(Number(nextValue), MIN_BRUSH_RADIUS, MAX_BRUSH_RADIUS),
                  );
                }}
                onDiagnosticRender={handleDiagnosticRender}
                onGroupValueChange={(groupId, nextValue) => {
                  const parsedValue = Number.parseFloat(nextValue);
                  handleGroupValueChange(
                    groupId,
                    Number.isFinite(parsedValue) ? parsedValue : 0,
                  );
                }}
                onRemovePixelGroup={handleRemovePixelGroup}
                pixelGroups={pixelGroups}
              />
            </Profiler>
          )}
          <Profiler id="MulticolorLab" onRender={handleReactProfile}>
            <MulticolorLab
            activePaletteColor={activePaletteColor}
            activePaletteColorId={activePaletteColorId}
            activeColorExperimentFromIndex={activeColorExperimentFromIndex}
            ditheredComparisonCanvasRef={ditheredComparisonCanvasRef}
            activeBucketPlannedLineCount={activeMulticolorPlannedLineCount}
            activeBucketRemainingLineCount={activeMulticolorRemainingLineCount}
            enabledPalettePreviewColors={enabledPalettePreviewColors}
            hasOriginalImage={Boolean(originalImageDataRef.current)}
            isActiveColorOnlyControlVisible={isActiveColorOnlyControlVisible}
            isActivePaletteColorOnlyEnabled={isActivePaletteColorOnlyEnabled}
            canApplyExperimentalStep={canApplyExperimentalMulticolorStep}
            currentActiveTargetImage={activeMulticolorTargetImage}
            exactColorAreaStats={exactColorAreaStats}
            isExperimentalRoundRobinSteppingEnabled={multicolorExperimentalSteppingMode === 'round-robin'}
            isExperimentalSharedBestSteppingEnabled={multicolorExperimentalSteppingMode === 'shared-best'}
            isMulticolorFastSteppingEnabled={isMulticolorFastSteppingEnabled}
            isMulticolorStepProfilingEnabled={isMulticolorStepProfilingEnabled}
            isMulticolorLabEnabled={isMulticolorLabEnabled}
            isPaletteDitheringEnabled={isPaletteDitheringEnabled}
            isPaletteMaskVisible={isPaletteMaskVisible}
            isPalettePreviewEnabled={isPalettePreviewEnabled}
            isWhiteTestOverlayEnabled={isWhiteTestOverlayEnabled}
            maskBlurRadius={maskBlurRadius}
            multicolorDebugView={multicolorDebugView}
            multicolorLineBuckets={multicolorLineBuckets}
            multicolorMaskImages={multicolorMaskImages}
            multicolorPaletteColors={multicolorPaletteColors}
            multicolorPaletteCoverage={multicolorPaletteCoverage}
            multicolorPaletteCoverageWithLineAllocation={multicolorPaletteCoverageWithLineAllocation}
            multicolorPaletteCoverageWithSuggestions={multicolorPaletteCoverageWithSuggestions}
            multicolorPaletteFinderColorCount={multicolorPaletteFinderColorCount}
            multicolorLockedLineOverride={multicolorLockedLineOverride}
            multicolorPalettePixelCountMap={multicolorPalettePixelCountMap}
            multicolorPalettePreset={multicolorPalettePreset}
            multicolorInterleaveOrder={multicolorInterleaveOrder}
            multicolorReadOnlyInterleavePassCount={readOnlyInterleavePassCount}
            onMoveMulticolorInterleaveEntryDown={handleMoveMulticolorInterleaveEntryDown}
            onMoveMulticolorInterleaveEntryUp={handleMoveMulticolorInterleaveEntryUp}
            onResetMulticolorInterleaveOrder={handleResetMulticolorInterleaveOrder}
            originalComparisonCanvasRef={originalComparisonCanvasRef}
            paletteComparisonCanvasRef={paletteComparisonCanvasRef}
            rawActiveMaskImage={activeMaskImage?.imageData ?? null}
            blurredActiveMaskImage={blurredActiveMaskImage}
            activeColorExperimentNextNailNumber={activeColorExperimentNextNailNumber}
            activeExperimentalLineCount={
              activeMulticolorLineBucket?.lineCount ??
              getPackedLineCount(activeMulticolorLineBucket?.linesPacked)
            }
            globalLineStrength={parseLineDarknessStep(lineStrength)}
            globalMinDistance={parseMinDistanceValue(highlightRange)}
            isExperimentalColorLinesOnlyPreviewEnabled={isExperimentalColorLinesOnlyPreviewEnabled}
            multicolorLineStrengthMode={multicolorLineStrengthMode}
            multicolorMinDistanceMode={multicolorMinDistanceMode}
            multicolorUsedLineExclusionMode={multicolorUsedLineExclusionMode}
            lineCoverageBackendId={lineCoverageBackendId}
            lineCoverageBackendOptions={LINE_COVERAGE_BACKENDS}
            onSetMulticolorBucketLineStrength={handleSetMulticolorBucketLineStrength}
            onSetMulticolorBucketMinDistance={handleSetMulticolorBucketMinDistance}
            onShowAllMulticolorBuckets={handleShowAllMulticolorBuckets}
            onSoloMulticolorBucket={handleSoloMulticolorBucket}
            onToggleMulticolorBucketVisibility={handleToggleMulticolorBucketVisibility}
            setActivePaletteColorId={setActivePaletteColorId}
            onApplyActiveColorExperimentStep={handleApplyExperimentalStep}
            onExportMulticolorSession={handleExportMulticolorSession}
            onFindBestFitPalette={handleFindBestFitPalette}
            onImportMulticolorSession={handleImportMulticolorSession}
            onDiagnosticRender={handleDiagnosticRender}
            onProfileEffect={handleProfileEffect}
            onRefreshMulticolorPreviews={handleRefreshMulticolorPreviews}
            onResetAllMulticolorState={handleResetAllMulticolorState}
            onResetMulticolorBucket={handleResetMulticolorBucket}
            setIsActivePaletteColorOnlyEnabled={setIsActivePaletteColorOnlyEnabled}
            setIsExperimentalColorLinesOnlyPreviewEnabled={setIsExperimentalColorLinesOnlyPreviewEnabled}
            setIsExperimentalRoundRobinSteppingEnabled={(nextValue) => {
              setMulticolorExperimentalSteppingMode(nextValue ? 'round-robin' : 'single-color');
              if (nextValue) {
                setMulticolorRoundRobinNextColorId(getNextRoundRobinColorId(activePaletteColorId));
              }
            }}
            setIsExperimentalSharedBestSteppingEnabled={(nextValue) => {
              setMulticolorExperimentalSteppingMode(nextValue ? 'shared-best' : 'single-color');
            }}
            setIsMulticolorFastSteppingEnabled={setIsMulticolorFastSteppingEnabled}
            setIsMulticolorStepProfilingEnabled={setIsMulticolorStepProfilingEnabled}
            setIsMulticolorLabEnabled={setIsMulticolorLabEnabled}
            setIsPaletteDitheringEnabled={setIsPaletteDitheringEnabled}
            setIsPalettePreviewEnabled={setIsPalettePreviewEnabled}
            setMaskBlurRadius={setMaskBlurRadius}
            setMulticolorDebugView={setMulticolorDebugView}
            setMulticolorLockedLineOverride={setMulticolorLockedLineOverride}
            setMulticolorPaletteColors={setMulticolorPaletteColors}
            setMulticolorPaletteFinderColorCount={setMulticolorPaletteFinderColorCount}
            setMulticolorPalettePresetId={setMulticolorPalettePresetId}
            setMulticolorTargetTotalLines={setMulticolorTargetTotalLines}
            setMulticolorLineStrengthMode={setMulticolorLineStrengthMode}
            setMulticolorMinDistanceMode={setMulticolorMinDistanceMode}
            setMulticolorUsedLineExclusionMode={setMulticolorUsedLineExclusionMode}
            setLineCoverageBackendId={setLineCoverageBackendId}
            shouldShowPaletteComparison={shouldShowPaletteComparison}
            multicolorTargetTotalLines={multicolorTargetTotalLines}
            sharedStateNextColorLabel={sharedStateNextColorLabel}
            totalExperimentalMulticolorLines={displayedTotalExperimentalMulticolorLines}
            totalAllocatedSuggestedLines={totalAllocatedSuggestedLines}
            totalPaletteCoverageTenths={totalPaletteCoverageTenths}
            isSharedStateLoopRunning={isSharedStateLoopRunning}
            sharedStateLoopStatus={sharedStateLoopStatus}
            onToggleSharedStateLoop={handleToggleSharedStateLoop}
            onToggleWhiteTestOverlay={() => {
              setIsWhiteTestOverlayEnabled((currentValue) => !currentValue);
            }}
            />
          </Profiler>
        </div>

      </aside>

      <Profiler id="PreviewWorkspace" onRender={handleReactProfile}>
        <PreviewWorkspace
        artLineSegments={artLineSegments}
        cropToCircle={cropToCircle}
        handlePointerDown={handlePointerDown}
        handlePointerMove={handlePointerMove}
        hasLoadedImage={hasLoadedImage}
        imageLayerStyle={imageLayerStyle}
        imageRef={imageRef}
        imageSize={imageSize}
        imageStyle={imageStyle}
        isArtMode={isArtMode}
        lineEnd={lineEnd}
        linePixels={linePixels}
        lineStart={lineStart}
        isWhiteTestOverlayEnabled={isWhiteTestOverlayEnabled}
        whiteTestOverlayPathData={whiteTestOverlayPathData}
        nailFontSize={nailFontSize}
        nailRadius={nailRadius}
        nails={nails}
        nailsCount={nailsCount}
        onDiagnosticRender={handleDiagnosticRender}
        onPointerCancel={(event) => {
          stopDragging(event);
          setHoveredPixel(null);
        }}
        onPointerLeave={(event) => {
          stopDragging(event);
          setHoveredPixel(null);
        }}
        onPointerUp={stopDragging}
        previewRef={previewRef}
        previewStyle={previewStyle}
        selectionOverlayRef={selectionOverlayRef}
        shouldShowPreviewLine={shouldShowPreviewLine}
        showNailNumbers={showNailNumbers}
        />
      </Profiler>
      <Profiler id="HoveredPixelOverlay" onRender={handleReactProfile}>
        <HoveredPixelOverlay
        hoveredPixel={hoveredPixel}
        isArtMode={isArtMode}
        isBlackAndWhite={isBlackAndWhite}
        isBrushMode={isBrushMode}
        onDiagnosticRender={handleDiagnosticRender}
        />
      </Profiler>
      </div>
    </Profiler>
  );
}

export default App;
