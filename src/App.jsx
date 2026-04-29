import { Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import BrushPanel from './components/BrushPanel';
import HoveredPixelOverlay from './components/HoveredPixelOverlay';
import MulticolorLab, { buildFinalDrawingPlanFromTasRows } from './components/MulticolorLab';
import PreviewWorkspace from './components/PreviewWorkspace';
import {
  buildArtLineSegments,
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
  rasterizeLinePixels,
  writeProcessedImageData,
} from './stringArtMath';
import {
  buildAllTasRegionsPaletteFit,
  buildTasChordNetwork,
  buildTasPixelOwnershipPreview,
  buildTasPreviewSegments,
  buildTasRegionPaletteFit,
  getTasRegionCount,
} from './tasGeometry';
import { getAreaWeightedTasRegionLimitCounts } from './tasLimits';
import {
  allocateWholeUnitsByWeight,
  allocateWholeUnitsByWeightWithLock,
  blurMaskImageData,
  clonePalettePreset,
  countPixelsByCurrentPaletteSource,
  countPixelsByNearestPaletteColor,
  createAutomaticPaletteColors,
  createPaletteMaskImageCollection,
  createPaletteMaskImageData,
  createPalettePreviewImageData,
  drawImageDataToCanvas,
  getOklabDistanceSquared,
  hexToRgb,
  isImagePixelInsidePreviewCircle,
  MULTICOLOR_PALETTE_PRESETS,
  rgbToOklab,
} from './multicolor';

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
const MIN_CONTRAST = 0;
const MAX_CONTRAST = 100;
const DEFAULT_CONTRAST = 100;
const DEFAULT_MULTICOLOR_TARGET_TOTAL_LINES = 2000;
const DEFAULT_TAS_REGION_CHORD_LIMIT_PERCENT = 100;
const DEFAULT_FINAL_STRING_TRIM_PERCENT = 0;
const MIN_RESIDUAL_STRING_THICKNESS = 0;
const MAX_RESIDUAL_STRING_THICKNESS = 100;
const DEFAULT_RESIDUAL_STRING_THICKNESS = 35;
const MIN_BRUSH_RADIUS = 1;
const MAX_BRUSH_RADIUS = 40;
const MIN_GROUP_VALUE = 0;
const MAX_GROUP_VALUE = 10;
const GROUP_VALUE_STEP = 0.05;
const SHOW_BRUSH_TOOLS = false;
const GROUP_COLORS = [
  '#0ea5e9',
  '#f97316',
  '#22c55e',
  '#e11d48',
  '#8b5cf6',
  '#facc15',
];

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
    lines: [],
  }));
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

function lerpNumber(startValue, endValue, amount) {
  return startValue + (endValue - startValue) * amount;
}

function getOrientedTasEndpoints(chord, fromNailNumber, toNailNumber) {
  if (!chord) {
    return null;
  }

  if (chord.startNailNumber === fromNailNumber && chord.endNailNumber === toNailNumber) {
    return {
      from: { x: chord.tasX1, y: chord.tasY1 },
      to: { x: chord.tasX2, y: chord.tasY2 },
    };
  }

  if (chord.endNailNumber === fromNailNumber && chord.startNailNumber === toNailNumber) {
    return {
      from: { x: chord.tasX2, y: chord.tasY2 },
      to: { x: chord.tasX1, y: chord.tasY1 },
    };
  }

  return null;
}

function buildFinalPlanLineSegments(steps, nails, chordByKey, trimPercent) {
  const trimAmount = clamp(
    Number.isFinite(trimPercent) ? trimPercent / 100 : 0,
    0,
    1,
  );

  return steps.reduce((segments, step, index) => {
    const startNail = nails[step.drawFromNailNumber - 1];
    const endNail = nails[step.drawToNailNumber - 1];
    if (!startNail || !endNail) {
      return segments;
    }

    const tasEndpoints = getOrientedTasEndpoints(
      chordByKey.get(step.chordKey),
      step.drawFromNailNumber,
      step.drawToNailNumber,
    );
    const targetFrom = tasEndpoints?.from ?? { x: startNail.cx, y: startNail.cy };
    const targetTo = tasEndpoints?.to ?? { x: endNail.cx, y: endNail.cy };

    segments.push({
      key: `final-drawing-plan-line-${index}-${step.drawFromNailNumber}-${step.drawToNailNumber}`,
      x1: lerpNumber(startNail.cx, targetFrom.x, trimAmount),
      y1: lerpNumber(startNail.cy, targetFrom.y, trimAmount),
      x2: lerpNumber(endNail.cx, targetTo.x, trimAmount),
      y2: lerpNumber(endNail.cy, targetTo.y, trimAmount),
      stroke: step.colorHex,
      className: 'art-line final-plan-line',
    });

    return segments;
  }, []);
}

function createWhiteSharedBoard(imageSize) {
  if (!imageSize?.width || !imageSize?.height) {
    return null;
  }

  const board = new Float32Array(imageSize.width * imageSize.height * 3);
  board.fill(255);
  return board;
}

function createSharedResidualVisibilityMask(imageSize) {
  if (!imageSize?.width || !imageSize?.height) {
    return null;
  }

  const visibilityMask = new Float32Array(imageSize.width * imageSize.height);
  visibilityMask.fill(1);
  return visibilityMask;
}

function getTargetPixelOklab(targetData, offset) {
  return rgbToOklab(targetData[offset], targetData[offset + 1], targetData[offset + 2]);
}

function getOklabSquaredError(red, green, blue, targetData, offset) {
  return getOklabDistanceSquared(
    rgbToOklab(red, green, blue),
    getTargetPixelOklab(targetData, offset),
  );
}

function buildPaletteTargetColorIndexes(targetImageData, paletteColors) {
  if (!targetImageData || paletteColors.length === 0) {
    return {
      colorTargetIndexById: new Map(),
      targetColorIndexes: null,
      targetPixelCountById: new Map(),
      totalTargetPixelCount: 0,
    };
  }

  const colorTargetIndexById = new Map();
  const colorIndexByRgb = new Map();
  const colorIdByTargetIndex = new Map();
  const targetPixelCountById = new Map(paletteColors.map((color) => [color.id, 0]));
  paletteColors.forEach((color, index) => {
    const targetIndex = index + 1;
    colorTargetIndexById.set(color.id, targetIndex);
    colorIdByTargetIndex.set(targetIndex, color.id);
    if (color.rgb) {
      colorIndexByRgb.set(`${color.rgb.r}-${color.rgb.g}-${color.rgb.b}`, targetIndex);
    }
  });

  const targetColorIndexes = new Uint16Array(targetImageData.width * targetImageData.height);
  let totalTargetPixelCount = 0;
  for (let offset = 0; offset < targetImageData.data.length; offset += 4) {
    const pixelIndex = offset / 4;
    const targetIndex =
      colorIndexByRgb.get(
        `${targetImageData.data[offset]}-${targetImageData.data[offset + 1]}-${targetImageData.data[offset + 2]}`,
      ) ?? 0;
    targetColorIndexes[pixelIndex] = targetIndex;
    const colorId = colorIdByTargetIndex.get(targetIndex);
    if (colorId) {
      targetPixelCountById.set(colorId, (targetPixelCountById.get(colorId) ?? 0) + 1);
      totalTargetPixelCount += 1;
    }
  }

  return {
    colorTargetIndexById,
    targetPixelCountById,
    targetColorIndexes,
    totalTargetPixelCount,
  };
}

function getSharedResidualColorBalanceMultiplier({
  colorId,
  lineCountByColorId,
  targetPixelCountById,
  totalLineCount,
  totalTargetPixelCount,
}) {
  const targetPixelCount = targetPixelCountById?.get(colorId) ?? 0;
  if (targetPixelCount <= 0 || totalTargetPixelCount <= 0) {
    return 1;
  }

  const targetShare = targetPixelCount / totalTargetPixelCount;
  const expectedLineCount = Math.max(0, (totalLineCount + 1) * targetShare);
  const candidateLineCount = (lineCountByColorId?.get(colorId) ?? 0) + 1;
  return clamp((expectedLineCount + 10) / (candidateLineCount + 10), 0.15, 8);
}

function getResidualCoveredPixelWeight(thicknessPercent) {
  const normalizedThickness = clamp(
    Number.isFinite(thicknessPercent) ? thicknessPercent : DEFAULT_RESIDUAL_STRING_THICKNESS,
    MIN_RESIDUAL_STRING_THICKNESS,
    MAX_RESIDUAL_STRING_THICKNESS,
  ) / 100;
  return 0.95 - normalizedThickness * 0.9;
}

function getResidualOcclusionPixelStride(thicknessPercent) {
  const normalizedThickness = clamp(
    Number.isFinite(thicknessPercent) ? thicknessPercent : DEFAULT_RESIDUAL_STRING_THICKNESS,
    MIN_RESIDUAL_STRING_THICKNESS,
    MAX_RESIDUAL_STRING_THICKNESS,
  );

  if (normalizedThickness <= 10) {
    return 5;
  }

  if (normalizedThickness <= 25) {
    return 4;
  }

  if (normalizedThickness <= 45) {
    return 3;
  }

  if (normalizedThickness <= 70) {
    return 2;
  }

  return 1;
}

function scoreSharedResidualLine({
  board,
  colorRgb,
  colorTargetIndex,
  imageSize,
  linePixels,
  targetData,
  targetColorIndexes,
  threadOpacity,
  visibilityMask,
}) {
  if (!board || !targetData || !colorRgb || !imageSize || linePixels.length === 0) {
    return -Infinity;
  }

  let score = 0;
  for (const pixel of linePixels) {
    const pixelIndex = pixel.y * imageSize.width + pixel.x;
    const visibilityWeight = visibilityMask?.[pixelIndex] ?? 1;

    const boardOffset = pixelIndex * 3;
    const targetOffset = pixelIndex * 4;
    const boardRed = board[boardOffset];
    const boardGreen = board[boardOffset + 1];
    const boardBlue = board[boardOffset + 2];
    const effectiveThreadOpacity = threadOpacity * visibilityWeight;
    const nextRed = boardRed * (1 - effectiveThreadOpacity) + colorRgb.r * effectiveThreadOpacity;
    const nextGreen =
      boardGreen * (1 - effectiveThreadOpacity) + colorRgb.g * effectiveThreadOpacity;
    const nextBlue =
      boardBlue * (1 - effectiveThreadOpacity) + colorRgb.b * effectiveThreadOpacity;

    const improvement =
      getOklabSquaredError(boardRed, boardGreen, boardBlue, targetData, targetOffset) -
      getOklabSquaredError(nextRed, nextGreen, nextBlue, targetData, targetOffset);

    if (targetColorIndexes && targetColorIndexes[pixelIndex] !== colorTargetIndex) {
      score += visibilityWeight * Math.min(0, improvement);
    } else {
      score += visibilityWeight * improvement;
    }
  }

  return score;
}

function applySharedResidualLineToBoard({
  board,
  colorRgb,
  imageSize,
  linePixels,
  threadOpacity,
  visibilityMask,
}) {
  if (!board || !colorRgb || !imageSize || linePixels.length === 0) {
    return false;
  }

  let didUpdate = false;
  for (const pixel of linePixels) {
    const pixelIndex = pixel.y * imageSize.width + pixel.x;
    const visibilityWeight = visibilityMask?.[pixelIndex] ?? 1;
    const effectiveThreadOpacity = threadOpacity * visibilityWeight;

    const boardOffset = pixelIndex * 3;
    board[boardOffset] =
      board[boardOffset] * (1 - effectiveThreadOpacity) + colorRgb.r * effectiveThreadOpacity;
    board[boardOffset + 1] =
      board[boardOffset + 1] * (1 - effectiveThreadOpacity) +
      colorRgb.g * effectiveThreadOpacity;
    board[boardOffset + 2] =
      board[boardOffset + 2] * (1 - effectiveThreadOpacity) +
      colorRgb.b * effectiveThreadOpacity;
    didUpdate = true;
  }

  return didUpdate;
}

function markSharedResidualLineOccluded({
  coveredPixelWeight,
  imageSize,
  linePixels,
  pixelStride = 1,
  visibilityMask,
}) {
  if (!imageSize || !visibilityMask || linePixels.length === 0) {
    return;
  }

  const normalizedStride = Math.max(1, Math.round(pixelStride));
  for (let index = 0; index < linePixels.length; index += normalizedStride) {
    const pixel = linePixels[index];
    const pixelIndex = pixel.y * imageSize.width + pixel.x;
    visibilityMask[pixelIndex] = Math.min(
      visibilityMask[pixelIndex],
      coveredPixelWeight,
    );
  }
}

function getLimitedTasChordKeySet({
  sortedRows,
  regionLimitPercent,
  regions,
  maxRegionIndex,
}) {
  if (!Array.isArray(sortedRows) || sortedRows.length === 0) {
    return new Set();
  }

  if (!Number.isFinite(regionLimitPercent) || regionLimitPercent <= 0) {
    return new Set();
  }

  const rowsByRegion = new Map();
  for (const row of sortedRows) {
    const regionRows = rowsByRegion.get(row.regionIndex) ?? [];
    regionRows.push(row);
    rowsByRegion.set(row.regionIndex, regionRows);
  }

  const regionLimitCounts = getAreaWeightedTasRegionLimitCounts({
    regions,
    limitPercent: regionLimitPercent,
    maxRegionIndex,
  });
  const activeChordKeys = new Set();
  for (const [regionIndex, regionRows] of rowsByRegion.entries()) {
    const regionLimit = Math.min(
      regionRows.length,
      regionLimitCounts.get(regionIndex) ?? 0,
    );
    if (regionLimit <= 0) {
      continue;
    }

    for (const row of regionRows.slice(-regionLimit)) {
      activeChordKeys.add(row.chordKey);
    }
  }

  return activeChordKeys;
}

function getMaxEnabledTasRegionIndexForMinDistance(nailsCount, minDistance) {
  const regionCount = getTasRegionCount(nailsCount);
  if (regionCount <= 0) {
    return -1;
  }

  const normalizedMinDistance = Math.max(
    0,
    Math.round(Number.isFinite(minDistance) ? minDistance : 0),
  );
  return Math.min(
    regionCount - 1,
    Math.max(-1, regionCount - normalizedMinDistance),
  );
}

function filterTasPaletteFitByMaxRegion(fit, maxRegionIndex) {
  if (!fit) {
    return null;
  }

  const segments = (fit.segments ?? []).filter(
    (segment) => segment.regionIndex <= maxRegionIndex,
  );
  const sortedRows = (fit.sortedRows ?? []).filter(
    (row) => row.regionIndex <= maxRegionIndex,
  );
  const finiteErrorRows = sortedRows.filter((row) => Number.isFinite(row.error));
  const totalError = finiteErrorRows.reduce((sum, row) => sum + row.error, 0);

  return {
    ...fit,
    assignedPixelCount: sortedRows.reduce((sum, row) => sum + row.pixelCount, 0),
    averageError: finiteErrorRows.length > 0 ? totalError / finiteErrorRows.length : null,
    fittedTasCount: sortedRows.length,
    regionTasCount: sortedRows.length,
    segments,
    sortedRows,
  };
}

function filterTasPaletteFitByRegion(fit, regionIndex, regionTasCount = 0) {
  if (!fit) {
    return null;
  }

  const segments = (fit.segments ?? []).filter(
    (segment) => segment.regionIndex === regionIndex,
  );
  const sortedRows = (fit.sortedRows ?? []).filter(
    (row) => row.regionIndex === regionIndex,
  );
  const finiteErrorRows = sortedRows.filter((row) => Number.isFinite(row.error));
  const totalError = finiteErrorRows.reduce((sum, row) => sum + row.error, 0);

  return {
    ...fit,
    assignedPixelCount: sortedRows.reduce((sum, row) => sum + row.pixelCount, 0),
    averageError: finiteErrorRows.length > 0 ? totalError / finiteErrorRows.length : null,
    fittedTasCount: sortedRows.length,
    regionTasCount,
    segments,
    sortedRows,
  };
}

function App() {
  const [imageName, setImageName] = useState('');
  const [imageSize, setImageSize] = useState(null);
  const [cropToCircle, setCropToCircle] = useState(true);
  const [isBlackAndWhite, setIsBlackAndWhite] = useState(true);
  const [showNailNumbers, setShowNailNumbers] = useState(true);
  const [nailsCount, setNailsCount] = useState(100);
  const [lineFrom, setLineFrom] = useState('1');
  const [lineTo, setLineTo] = useState('1');
  const [highlightRange, setHighlightRange] = useState(String(DEFAULT_HIGHLIGHT_DISTANCE));
  const [lineStrength, setLineStrength] = useState(String(DEFAULT_LINE_STRENGTH));
  const [contrast, setContrast] = useState(String(DEFAULT_CONTRAST));
  const [savedNailSequence, setSavedNailSequence] = useState([]);
  const [isArtMode, setIsArtMode] = useState(true);
  const [plannerMode, setPlannerMode] = useState('residual');
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
  const [multicolorDebugView, setMulticolorDebugView] = useState('palette-preview');
  const [multicolorPalettePresetId, setMulticolorPalettePresetId] = useState(
    MULTICOLOR_PALETTE_PRESETS[0].id,
  );
  const [multicolorPaletteColors, setMulticolorPaletteColors] = useState(() =>
    clonePalettePreset(MULTICOLOR_PALETTE_PRESETS[0]).colors,
  );
  const [automaticPaletteColorCount, setAutomaticPaletteColorCount] = useState(4);
  const [isPalettePreviewEnabled, setIsPalettePreviewEnabled] = useState(true);
  const [isPaletteDitheringEnabled, setIsPaletteDitheringEnabled] = useState(true);
  const [multicolorPalettePixelCounts, setMulticolorPalettePixelCounts] = useState([]);
  const [multicolorPaletteCoverage, setMulticolorPaletteCoverage] = useState([]);
  const [multicolorLockedLineOverride, setMulticolorLockedLineOverride] = useState(null);
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
  const [multicolorExperimentalSteppingMode, setMulticolorExperimentalSteppingMode] = useState('single-color');
  const [multicolorRoundRobinNextColorId, setMulticolorRoundRobinNextColorId] = useState(null);
  const [multicolorMaskImages, setMulticolorMaskImages] = useState([]);
  const [activeMulticolorTargetImage, setActiveMulticolorTargetImage] = useState(null);
  const [multicolorUsedLineExclusionMode, setMulticolorUsedLineExclusionMode] = useState('shared');
  const [multicolorLineStrengthMode, setMulticolorLineStrengthMode] = useState('shared');
  const [multicolorMinDistanceMode, setMulticolorMinDistanceMode] = useState('shared');
  const [isMulticolorStepProfilingEnabled, setIsMulticolorStepProfilingEnabled] = useState(false);
  const [isMulticolorFastSteppingEnabled, setIsMulticolorFastSteppingEnabled] = useState(false);
  const [multicolorInterleaveEntryIds, setMulticolorInterleaveEntryIds] = useState([]);
  const [isTasPreviewEnabled, setIsTasPreviewEnabled] = useState(false);
  const [isTasOwnershipPreviewEnabled, setIsTasOwnershipPreviewEnabled] = useState(false);
  const [isTasPaletteFitPreviewEnabled, setIsTasPaletteFitPreviewEnabled] = useState(true);
  const [isTasPaletteFitLimitedToPalette, setIsTasPaletteFitLimitedToPalette] = useState(true);
  const [tasViewScope, setTasViewScope] = useState('all');
  const [selectedTasRegionIndex, setSelectedTasRegionIndex] = useState(0);
  const [selectedTasChordKey, setSelectedTasChordKey] = useState(null);
  const [selectedConnectorGapChordKey, setSelectedConnectorGapChordKey] = useState(null);
  const [selectedChainChordKeys, setSelectedChainChordKeys] = useState([]);
  const [selectedConnectorChordKeys, setSelectedConnectorChordKeys] = useState([]);
  const [tasRegionChordLimitPercent, setTasRegionChordLimitPercent] = useState(
    DEFAULT_TAS_REGION_CHORD_LIMIT_PERCENT,
  );
  const [finalStringTrimPercent, setFinalStringTrimPercent] = useState(
    DEFAULT_FINAL_STRING_TRIM_PERCENT,
  );
  const [isTasSameColorFocusEnabled, setIsTasSameColorFocusEnabled] = useState(false);
  const [sharedResidualLines, setSharedResidualLines] = useState([]);
  const [sharedResidualCurrentNails, setSharedResidualCurrentNails] = useState({});
  const [sharedResidualLastStep, setSharedResidualLastStep] = useState(null);
  const [residualStringThickness, setResidualStringThickness] = useState(
    DEFAULT_RESIDUAL_STRING_THICKNESS,
  );

  const previewRef = useRef(null);
  const imageRef = useRef(null);
  const selectionOverlayRef = useRef(null);
  const imageCanvasRef = useRef(null);
  const imageScaleRef = useRef(INITIAL_IMAGE_SCALE_MULTIPLIER);
  const previewScaleRef = useRef(INITIAL_PREVIEW_SCALE);
  const imageCenterRef = useRef({ x: 0, y: 0 });
  const previewOffsetRef = useRef({ x: 0, y: 0 });
  const tasOwnershipPreviewCacheRef = useRef(new Map());
  const originalComparisonCanvasRef = useRef(null);
  const paletteComparisonCanvasRef = useRef(null);
  const ditheredComparisonCanvasRef = useRef(null);
  const originalImageDataRef = useRef(null);
  const activeColorMaskScoringImageDataRef = useRef(null);
  const sourceUrlRef = useRef(null);
  const animationFrameRef = useRef(null);
  const isMountedRef = useRef(true);
  const pauseRequestedRef = useRef(false);
  const pixelWeightMapRef = useRef(null);
  const linePixelsCacheRef = useRef(new Map());
  const lineBoostMapRef = useRef(null);
  const usedLineKeysRef = useRef(new Set());
  const currentCanvasRevisionRef = useRef(0);
  const sharedResidualBoardRef = useRef(null);
  const sharedResidualVisibilityMaskRef = useRef(null);
  const currentCanvasMaskCollectionCacheRef = useRef({ key: '', masks: [] });
  const pendingMulticolorStepProfileRef = useRef(null);
  const skipNextActiveTargetImageEffectRef = useRef(false);
  const pixelOwnerMapRef = useRef(null);
  const groupPixelsRef = useRef(new Map([[1, new Set()]]));
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
    };
  }, []);

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
    linePixelsCacheRef.current.clear();
  }, [
    imageSize,
    nailsCount,
    previewSize,
    imageScale,
    imageCenter.x,
    imageCenter.y,
  ]);

  const multicolorPalettePreset = MULTICOLOR_PALETTE_PRESETS.find(
    (preset) => preset.id === multicolorPalettePresetId,
  ) ?? {
    id: multicolorPalettePresetId,
    name: 'Automatic palette',
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
        .filter((color) => color.rgb),
    [enabledPaletteColors],
  );
  const activePaletteColor = multicolorPaletteColors.find((color) => color.id === activePaletteColorId) ?? null;
  const activePalettePreviewColor = enabledPalettePreviewColors.find(
    (color) => color.id === activePaletteColorId,
  ) ?? null;
  const getInitialSharedResidualCurrentNails = useCallback(
    () => Object.fromEntries(enabledPalettePreviewColors.map((color) => [color.id, 1])),
    [enabledPalettePreviewColors],
  );
  useEffect(() => {
    sharedResidualBoardRef.current = createWhiteSharedBoard(imageSize);
    sharedResidualVisibilityMaskRef.current = createSharedResidualVisibilityMask(imageSize);
    setSharedResidualLines([]);
    setSharedResidualCurrentNails(getInitialSharedResidualCurrentNails());
    setSharedResidualLastStep(null);
  }, [getInitialSharedResidualCurrentNails, imageName, imageSize, nailsCount]);
  const canUseActiveColorMaskForLineScoring =
    isMulticolorLabEnabled &&
    isPalettePreviewEnabled &&
    Boolean(imageSize) &&
    Boolean(activePalettePreviewColor);
  const isActiveColorMaskScoringEnabled =
    false;
  const lineScoringModeLabel = isActiveColorMaskScoringEnabled
    ? `active color${activePaletteColor ? ` (${activePaletteColor.label})` : ''}`
    : 'grayscale';
  const multicolorPalettePixelCountMap = new Map(
    multicolorPalettePixelCounts.map((color) => [color.id, color.pixelCount]),
  );
  const sharedResidualLineCountMap = useMemo(() => {
    const lineCounts = new Map();
    for (const line of sharedResidualLines) {
      lineCounts.set(line.colorId, (lineCounts.get(line.colorId) ?? 0) + 1);
    }
    return lineCounts;
  }, [sharedResidualLines]);
  const residualCoveredPixelWeight = getResidualCoveredPixelWeight(residualStringThickness);
  const residualOcclusionPixelStride = getResidualOcclusionPixelStride(residualStringThickness);
  const getSharedResidualLineCountMap = (lines) => {
    const lineCounts = new Map();
    for (const line of lines) {
      lineCounts.set(line.colorId, (lineCounts.get(line.colorId) ?? 0) + 1);
    }
    return lineCounts;
  };
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
  const totalExperimentalMulticolorLines = multicolorLineBuckets.reduce(
    (sum, bucket) => sum + bucket.lines.length,
    0,
  );
  const getRemainingPlannedLinesForBucket = (bucket) =>
    Math.max(0, (plannedMulticolorLinesByColorId.get(bucket.colorId) ?? 0) - bucket.lines.length);
  const eligibleMulticolorStepBuckets = enabledMulticolorLineBuckets.filter(
    (bucket) => getRemainingPlannedLinesForBucket(bucket) > 0,
  );
  const interleaveEligibleBuckets = multicolorLineBuckets.filter(
    (bucket) =>
      (plannedMulticolorLinesByColorId.get(bucket.colorId) ?? 0) > 0 ||
      bucket.lines.length > 0,
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
        new Set(
          bucket.lines
            .map((line) => getNormalizedLineKey(line.startNailNumber, line.endNailNumber))
            .filter(Boolean),
        ),
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
  const isActiveColorOnlyControlVisible = false;
  const shouldShowOriginalDebugView =
    isMulticolorLabEnabled && multicolorDebugView === 'original';
  const shouldShowCurrentGrayscaleDebugView =
    isMulticolorLabEnabled && multicolorDebugView === 'current-grayscale';
  const isPalettePreviewVisible =
    isMulticolorLabEnabled &&
    isPalettePreviewEnabled &&
    enabledPalettePreviewColors.length > 0;
  const isPaletteMaskVisible =
    false;
  const shouldShowPaletteComparison =
    isPalettePreviewVisible &&
    Boolean(originalImageDataRef.current);
  const shouldDeferMulticolorStepVisuals =
    false;
  const residualImagePreviewMode =
    !isPalettePreviewEnabled || multicolorDebugView === 'original'
      ? 'original'
      : isPaletteDitheringEnabled
        ? 'dithered'
        : 'palette';
  const residualPreviewMode = isArtMode ? 'strings' : residualImagePreviewMode;
  const getSharedResidualTarget = () => {
    const originalImageData = originalImageDataRef.current;
    if (!originalImageData) {
      return null;
    }

    if (residualImagePreviewMode === 'original' || enabledPalettePreviewColors.length === 0) {
      return {
        colorTargetIndexById: null,
        imageData: originalImageData,
        targetColorIndexes: null,
        targetPixelCountById: null,
        totalTargetPixelCount: 0,
      };
    }

    const targetImageData = createPalettePreviewImageData(
      originalImageData,
      enabledPalettePreviewColors,
      residualImagePreviewMode === 'dithered',
      null,
      false,
    ) ?? originalImageData;
    const targetColorIndexInfo = buildPaletteTargetColorIndexes(
      targetImageData,
      enabledPalettePreviewColors,
    );

    return {
      ...targetColorIndexInfo,
      imageData: targetImageData,
    };
  };

  const setResidualPreviewMode = (nextMode) => {
    if (nextMode === 'strings') {
      setIsArtMode(true);
      setHoveredPixel(null);
      return;
    }

    setIsArtMode(false);
    if (nextMode === 'original') {
      setMulticolorDebugView('original');
      setIsPalettePreviewEnabled(false);
      return;
    }

    setMulticolorDebugView('palette-preview');
    setIsPalettePreviewEnabled(true);
    setIsPaletteDitheringEnabled(nextMode === 'dithered');
  };

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
    if (
      !imageSize ||
      enabledPalettePreviewColors.length === 0 ||
      !colorId ||
      !imageCanvasRef.current
    ) {
      return null;
    }

    if (!sourceImageData) {
      return getCurrentCanvasMaskCollection().find((color) => color.id === colorId)?.imageData ?? null;
    }

    return createPaletteMaskImageData(
      sourceImageData,
      enabledPalettePreviewColors,
      isPaletteDitheringEnabled,
      colorId,
    );
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
          lines: existingBucket?.lines ?? [],
        };
      });
    });
  }, [highlightRange, lineStrength, multicolorPaletteColors, parseLineDarknessStep, parseMinDistanceValue]);

  useEffect(() => {
    const availableEntryIds = defaultMulticolorInterleaveEntries.map((entry) => entry.id);
    setMulticolorInterleaveEntryIds((currentEntryIds) => {
      const normalizedEntryIds = getNormalizedInterleaveEntryIds(
        currentEntryIds,
        availableEntryIds,
      );
      return areStringArraysEqual(normalizedEntryIds, currentEntryIds)
        ? currentEntryIds
        : normalizedEntryIds;
    });
  }, [defaultMulticolorInterleaveEntries]);

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
      const paletteMaskImage = createPaletteMaskImageData(
        visibleImage,
        enabledPalettePreviewColors,
        isPaletteDitheringEnabled,
        activePaletteColorId,
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
    if (!imageCanvasRef.current || !imageSize || enabledPalettePreviewColors.length === 0) {
      setMulticolorMaskImages([]);
      return;
    }

    const context = imageCanvasRef.current.getContext('2d', {
      willReadFrequently: true,
    });
    if (!context) {
      setMulticolorMaskImages([]);
      return;
    }

    setMulticolorMaskImages(
      createPaletteMaskImageCollection(
        context.getImageData(0, 0, imageSize.width, imageSize.height),
        enabledPalettePreviewColors,
        isPaletteDitheringEnabled,
      ),
    );
  }, [
    contrast,
    imageName,
    imageSize,
    isPaletteDitheringEnabled,
    multicolorPaletteColors,
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

  const handleFileChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (sourceUrlRef.current) {
      URL.revokeObjectURL(sourceUrlRef.current);
      sourceUrlRef.current = null;
    }

    const nextUrl = URL.createObjectURL(file);
    sourceUrlRef.current = nextUrl;
    setImageName(file.name);
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
    setMulticolorLockedLineOverride(null);
    setMulticolorTargetTotalLines(DEFAULT_MULTICOLOR_TARGET_TOTAL_LINES);
    setIsExperimentalColorLinesOnlyPreviewEnabled(false);
    setMulticolorExperimentalSteppingMode('single-color');
    setMulticolorRoundRobinNextColorId(null);
    originalImageDataRef.current = null;
    linePixelsCacheRef.current.clear();
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

      if (sourceUrlRef.current) {
        URL.revokeObjectURL(sourceUrlRef.current);
        sourceUrlRef.current = null;
      }
    };
    img.src = nextUrl;
  };

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

  const updateHoveredPixel = (event) => {
    if (isArtMode || !hasLoadedImage) {
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

    setHoveredPixel({
      x: event.clientX,
      y: event.clientY,
      left:
        imagePoint.contentRect.left +
        (previewSize / 2 + (imagePoint.pixelColumn - imageCenter.x) * imageScale) *
          (imagePoint.contentRect.width / previewSize),
      top:
        imagePoint.contentRect.top +
        (previewSize / 2 + (imagePoint.pixelRow - imageCenter.y) * imageScale) *
          (imagePoint.contentRect.height / previewSize),
      width: imageScale * (imagePoint.contentRect.width / previewSize),
      height: imageScale * (imagePoint.contentRect.height / previewSize),
      pixelX: imagePoint.pixelColumn,
      pixelY: imagePoint.pixelRow,
      r: pixel[0],
      g: pixel[1],
      b: pixel[2],
      darkness: Math.round((pixel[0] + pixel[1] + pixel[2]) / 3),
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

  const getLinePixelsForIndexes = (startIndex, endIndex) => {
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
    const cachedPixels = linePixelsCacheRef.current.get(cacheKey);
    if (cachedPixels) {
      return cachedPixels;
    }

    const startPreviewX = (startNail.cx / 100) * previewSize;
    const startPreviewY = (startNail.cy / 100) * previewSize;
    const endPreviewX = (endNail.cx / 100) * previewSize;
    const endPreviewY = (endNail.cy / 100) * previewSize;
    const startImageX =
      imageCenter.x + (startPreviewX - previewSize / 2) / imageScale;
    const startImageY =
      imageCenter.y + (startPreviewY - previewSize / 2) / imageScale;
    const endImageX =
      imageCenter.x + (endPreviewX - previewSize / 2) / imageScale;
    const endImageY =
      imageCenter.y + (endPreviewY - previewSize / 2) / imageScale;

    const linePixels = rasterizeLinePixels(
      startImageX,
      startImageY,
      endImageX,
      endImageY,
      imageSize.width,
      imageSize.height,
    );
    linePixelsCacheRef.current.set(cacheKey, linePixels);
    return linePixels;
  };

  const getNextNailForImageData = (originIndex, sourceImageData, options = {}) => {
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

    return selectedNail;
  };

  const applyLineToImageData = (
    targetImageData,
    startIndex,
    endIndex,
    lineDarknessStep,
    targetLineBoostMap = null,
  ) => {
    const targetLinePixels = getLinePixelsForIndexes(startIndex, endIndex);
    if (!imageSize || targetLinePixels.length === 0) {
      return false;
    }

    for (const pixel of targetLinePixels) {
      const pixelIndex = pixel.y * imageSize.width + pixel.x;
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

  const getLineDarknessStep = (lineStrengthValue = lineStrength) =>
    parseLineDarknessStep(lineStrengthValue);

  const getUsedLineKeysForMulticolorBucket = useCallback((bucket) => {
    if (!bucket) {
      return sharedMulticolorUsedLineKeys;
    }

    if (multicolorUsedLineExclusionMode === 'shared') {
      return sharedMulticolorUsedLineKeys;
    }

    const nextUsedLineKeys = new Set(monochromeUsedLineKeys);
    for (const lineKey of multicolorLineKeysByColorId.get(bucket.colorId) ?? []) {
      nextUsedLineKeys.add(lineKey);
    }
    return nextUsedLineKeys;
  }, [
    monochromeUsedLineKeys,
    multicolorLineKeysByColorId,
    multicolorUsedLineExclusionMode,
    sharedMulticolorUsedLineKeys,
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

  const resetSharedResidualExperiment = () => {
    sharedResidualBoardRef.current = createWhiteSharedBoard(imageSize);
    sharedResidualVisibilityMaskRef.current = createSharedResidualVisibilityMask(imageSize);
    setSharedResidualLines([]);
    setSharedResidualCurrentNails(getInitialSharedResidualCurrentNails());
    setSharedResidualLastStep(null);
  };

  const handleResidualStringThicknessChange = (nextValue) => {
    setResidualStringThickness(
      clamp(nextValue, MIN_RESIDUAL_STRING_THICKNESS, MAX_RESIDUAL_STRING_THICKNESS),
    );
    sharedResidualBoardRef.current = createWhiteSharedBoard(imageSize);
    sharedResidualVisibilityMaskRef.current = createSharedResidualVisibilityMask(imageSize);
    setSharedResidualLines([]);
    setSharedResidualCurrentNails(getInitialSharedResidualCurrentNails());
    setSharedResidualLastStep(null);
    setIsStepLoopPaused(false);
  };

  const ensureSharedResidualVisibilityMask = (lines = sharedResidualLines) => {
    if (sharedResidualVisibilityMaskRef.current || !imageSize) {
      return sharedResidualVisibilityMaskRef.current;
    }

    const visibilityMask = createSharedResidualVisibilityMask(imageSize);
    for (const line of lines) {
      markSharedResidualLineOccluded({
        coveredPixelWeight: residualCoveredPixelWeight,
        imageSize,
        linePixels: getLinePixelsForIndexes(line.startNailNumber, line.endNailNumber),
        pixelStride: residualOcclusionPixelStride,
        visibilityMask,
      });
    }
    sharedResidualVisibilityMaskRef.current = visibilityMask;
    return visibilityMask;
  };

  const getSharedResidualUsedLineKeys = (lines) =>
    new Set(
      lines
        .map((line) => getNormalizedLineKey(line.startNailNumber, line.endNailNumber))
        .filter(Boolean),
    );

  const findBestSharedResidualCandidate = ({
    board,
    currentNails,
    minimumAllowedDistance,
    targetData,
    targetColorIndexes,
    colorTargetIndexById,
    lineCountByColorId,
    threadOpacity,
    targetPixelCountById,
    totalLineCount,
    totalTargetPixelCount,
    usedLineKeys,
    visibilityMask,
  }) => {
    let bestCandidate = null;

    for (const color of enabledPalettePreviewColors) {
      const originNailNumber = currentNails[color.id] ?? 1;
      for (const targetNail of nails) {
        if (targetNail.number === originNailNumber) {
          continue;
        }

        if (
          minimumAllowedDistance > 0 &&
          getCircularNailDistance(targetNail.number, originNailNumber, nailsCount) <=
            minimumAllowedDistance
        ) {
          continue;
        }

        const lineKey = getNormalizedLineKey(originNailNumber, targetNail.number);
        if (!lineKey || usedLineKeys.has(lineKey)) {
          continue;
        }

        const linePixels = getLinePixelsForIndexes(originNailNumber, targetNail.number);
        const score = scoreSharedResidualLine({
          board,
          colorTargetIndex: colorTargetIndexById?.get(color.id) ?? 0,
          colorRgb: color.rgb,
          imageSize,
          linePixels,
          targetData,
          targetColorIndexes,
          threadOpacity,
          visibilityMask,
        });
        const balancedScore = score * getSharedResidualColorBalanceMultiplier({
          colorId: color.id,
          lineCountByColorId,
          targetPixelCountById,
          totalLineCount,
          totalTargetPixelCount,
        });

        if (!bestCandidate || balancedScore > bestCandidate.balancedScore) {
          bestCandidate = {
            balancedScore,
            color,
            endNailNumber: targetNail.number,
            lineKey,
            linePixels,
            score,
            startNailNumber: originNailNumber,
          };
        }
      }
    }

    return bestCandidate;
  };

  const applySharedResidualCandidate = (
    candidate,
    board,
    threadOpacity,
    visibilityMask,
    coveredPixelWeight,
    pixelStride,
  ) => {
    applySharedResidualLineToBoard({
      board,
      colorRgb: candidate.color.rgb,
      imageSize,
      linePixels: candidate.linePixels,
      threadOpacity,
      visibilityMask,
    });
    markSharedResidualLineOccluded({
      coveredPixelWeight,
      imageSize,
      linePixels: candidate.linePixels,
      pixelStride,
      visibilityMask,
    });

    return {
      colorId: candidate.color.id,
      endNailNumber: candidate.endNailNumber,
      hex: candidate.color.hex,
      label: candidate.color.label,
      score: candidate.score,
      startNailNumber: candidate.startNailNumber,
    };
  };

  const createSharedResidualLastStep = (line) => ({
    colorLabel: line.label,
    endNailNumber: line.endNailNumber,
    score: line.score,
    startNailNumber: line.startNailNumber,
    status: 'Applied',
  });

  const handleApplySharedResidualStep = () => {
    if (
      !imageSize ||
      !originalImageDataRef.current ||
      enabledPalettePreviewColors.length === 0
    ) {
      return;
    }

    if (!sharedResidualBoardRef.current) {
      sharedResidualBoardRef.current = createWhiteSharedBoard(imageSize);
    }

    const board = sharedResidualBoardRef.current;
    const visibilityMask = ensureSharedResidualVisibilityMask();
    const target = getSharedResidualTarget();
    if (!target) {
      return;
    }

    const targetData = target.imageData.data;
    const minimumAllowedDistance = parseMinDistanceValue(highlightRange);
    const threadOpacity = clamp(getLineDarknessStep() / 100, 0.01, 0.95);
    const bestCandidate = findBestSharedResidualCandidate({
      board,
      colorTargetIndexById: target.colorTargetIndexById,
      currentNails: sharedResidualCurrentNails,
      lineCountByColorId: getSharedResidualLineCountMap(sharedResidualLines),
      minimumAllowedDistance,
      targetData,
      targetColorIndexes: target.targetColorIndexes,
      targetPixelCountById: target.targetPixelCountById,
      threadOpacity,
      totalLineCount: sharedResidualLines.length,
      totalTargetPixelCount: target.totalTargetPixelCount,
      usedLineKeys: getSharedResidualUsedLineKeys(sharedResidualLines),
      visibilityMask,
    });

    if (!bestCandidate || bestCandidate.score <= 0) {
      setSharedResidualLastStep({
        status: 'No improving move',
        score: bestCandidate?.score ?? null,
      });
      return;
    }

    const nextLine = applySharedResidualCandidate(
      bestCandidate,
      board,
      threadOpacity,
      visibilityMask,
      residualCoveredPixelWeight,
      residualOcclusionPixelStride,
    );
    setSharedResidualLines((currentLines) => [...currentLines, nextLine]);
    setSharedResidualCurrentNails((currentNails) => ({
      ...currentNails,
      [nextLine.colorId]: nextLine.endNailNumber,
    }));
    setSharedResidualLastStep(createSharedResidualLastStep(nextLine));
    setIsArtMode(true);
  };

  const handleLoopSharedResidualSteps = async () => {
    if (isPerformingSteps) {
      pauseRequestedRef.current = true;
      return;
    }

    if (
      !imageSize ||
      !originalImageDataRef.current ||
      enabledPalettePreviewColors.length === 0
    ) {
      return;
    }

    if (!sharedResidualBoardRef.current) {
      sharedResidualBoardRef.current = createWhiteSharedBoard(imageSize);
    }

    const board = sharedResidualBoardRef.current;
    const visibilityMask = ensureSharedResidualVisibilityMask(sharedResidualLines);
    const target = getSharedResidualTarget();
    if (!target) {
      return;
    }

    const targetData = target.imageData.data;
    const minimumAllowedDistance = parseMinDistanceValue(highlightRange);
    const threadOpacity = clamp(getLineDarknessStep() / 100, 0.01, 0.95);
    const currentLines = [...sharedResidualLines];
    const currentNails = {
      ...getInitialSharedResidualCurrentNails(),
      ...sharedResidualCurrentNails,
    };
    const usedLineKeys = getSharedResidualUsedLineKeys(currentLines);
    const lineCountByColorId = getSharedResidualLineCountMap(currentLines);
    let lastStep = null;
    let didReachNaturalStop = false;
    let loopStepCount = 0;
    let lastUiYieldAt = performance.now();

    pauseRequestedRef.current = false;
    setIsStepLoopPaused(false);
    setIsPerformingSteps(true);
    setHoveredPixel(null);
    setIsArtMode(true);

    try {
      while (loopStepCount < 9000 && isMountedRef.current && !pauseRequestedRef.current) {
          const bestCandidate = findBestSharedResidualCandidate({
            board,
            colorTargetIndexById: target.colorTargetIndexById,
            currentNails,
            lineCountByColorId,
            minimumAllowedDistance,
            targetData,
            targetColorIndexes: target.targetColorIndexes,
            targetPixelCountById: target.targetPixelCountById,
            threadOpacity,
            totalLineCount: currentLines.length,
            totalTargetPixelCount: target.totalTargetPixelCount,
            usedLineKeys,
            visibilityMask,
          });

        if (!bestCandidate || bestCandidate.score <= 0) {
          didReachNaturalStop = true;
          break;
        }

        const nextLine = applySharedResidualCandidate(
          bestCandidate,
          board,
          threadOpacity,
          visibilityMask,
          residualCoveredPixelWeight,
          residualOcclusionPixelStride,
        );
          currentLines.push(nextLine);
          currentNails[nextLine.colorId] = nextLine.endNailNumber;
          lineCountByColorId.set(
            nextLine.colorId,
            (lineCountByColorId.get(nextLine.colorId) ?? 0) + 1,
          );
          usedLineKeys.add(bestCandidate.lineKey);
        lastStep = createSharedResidualLastStep(nextLine);
        loopStepCount += 1;

        const now = performance.now();
        if (loopStepCount % 50 === 0 || now - lastUiYieldAt >= 500) {
          setSharedResidualLines([...currentLines]);
          setSharedResidualCurrentNails({ ...currentNails });
          setSharedResidualLastStep(lastStep);
          lastUiYieldAt = now;
          await waitForNextWorkSlice();
        }
      }
    } finally {
      const didPause = pauseRequestedRef.current;
      pauseRequestedRef.current = false;
      if (isMountedRef.current) {
        setSharedResidualLines([...currentLines]);
        setSharedResidualCurrentNails({ ...currentNails });
        setSharedResidualLastStep(
          didReachNaturalStop
            ? {
                status: 'No improving move',
                score: lastStep?.score ?? null,
              }
            : lastStep,
        );
        setIsPerformingSteps(false);
        setIsStepLoopPaused(didPause);
      }
    }
  };

  const getEligibleMulticolorStepBuckets = (bucketList = multicolorLineBuckets) =>
    bucketList.filter(
      (bucket) =>
        bucket.enabled &&
        Math.max(
          0,
          (plannedMulticolorLinesByColorId.get(bucket.colorId) ?? 0) - bucket.lines.length,
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
      const bucketLineDarknessStep =
        multicolorLineStrengthMode === 'shared'
          ? monochromeLineDarknessStep
          : getLineDarknessStep(bucket.lineStrength);
      const bucketAppliedLineKeys =
        multicolorUsedLineExclusionMode === 'shared'
          ? usedLineKeysRef.current
          : new Set(monochromeAppliedLineKeys);
      for (const line of bucket.lines) {
        const lineKey = getNormalizedLineKey(line.startNailNumber, line.endNailNumber);
        if (
          !lineKey ||
          bucketAppliedLineKeys.has(lineKey) ||
          !applyLineToImageData(
            canvasImage.data,
            line.startNailNumber,
            line.endNailNumber,
            bucketLineDarknessStep,
            lineBoostMapRef.current,
          )
        ) {
          continue;
        }

        bucketAppliedLineKeys.add(lineKey);
        if (multicolorUsedLineExclusionMode === 'shared') {
          usedLineKeysRef.current.add(lineKey);
        }
      }
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

  const waitForNextWorkSlice = () =>
    new Promise((resolve) => {
      if (!document.hidden) {
        animationFrameRef.current = window.requestAnimationFrame((timestamp) => {
          animationFrameRef.current = null;
          resolve(timestamp);
        });
        return;
      }

      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve(performance.now());
      };
      channel.port2.postMessage(null);
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
    const usedLineKeys = options.usedLineKeys ?? usedLineKeysRef.current;
    const lineDarknessStep = options.lineDarknessStep ?? getLineDarknessStep();
    const lineKey = getNormalizedLineKey(startIndex, endIndex);
    const targetLinePixels = stepProfile
      ? stepProfile.measure('line pixel lookup', () => getLinePixelsForIndexes(startIndex, endIndex))
      : getLinePixelsForIndexes(startIndex, endIndex);
    if (
      !lineKey ||
      (!skipGlobalUsedLineCheck && usedLineKeys.has(lineKey)) ||
      !imageCanvasRef.current ||
      !imageSize ||
      targetLinePixels.length === 0
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
    const didApplyLine = stepProfile
      ? stepProfile.measure('line application', () =>
          applyLineToImageData(
            canvasImage.data,
            startIndex,
            endIndex,
            lineDarknessStep,
            lineBoostMapRef.current,
          ),
        )
      : applyLineToImageData(
          canvasImage.data,
          startIndex,
          endIndex,
          lineDarknessStep,
          lineBoostMapRef.current,
        );
    if (!didApplyLine) {
      return false;
    }
    if (isActiveColorMaskScoringEnabled && activeColorMaskScoringImageDataRef.current) {
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

  const handleApplyExperimentalStep = () => {
    if (eligibleMulticolorStepBuckets.length === 0) {
      return;
    }

    const targetColorId =
      multicolorExperimentalSteppingMode === 'round-robin'
        ? (
            multicolorRoundRobinNextColorId ??
            eligibleMulticolorStepBuckets.find((bucket) => bucket.colorId === activePaletteColorId)?.colorId ??
            eligibleMulticolorStepBuckets[0].colorId
          )
        : activeMulticolorRemainingLineCount > 0
          ? activePaletteColorId
          : null;
    if (!targetColorId) {
      return;
    }
    const targetBucket = multicolorLineBuckets.find((bucket) => bucket.colorId === targetColorId);
    if (!targetBucket) {
      return;
    }

    const stepProfile = createMulticolorStepProfile({
      colorId: targetColorId,
      colorLabel: targetBucket.label,
      mode: multicolorExperimentalSteppingMode,
      source: isPaletteDitheringEnabled ? 'dithered' : 'nearest',
    });
    const targetStartNailNumber = getExperimentalStartNailNumberForBucket(targetBucket);
    const targetUsedLineKeys = getUsedLineKeysForMulticolorBucket(targetBucket);
    const targetLineDarknessStep =
      multicolorLineStrengthMode === 'shared'
        ? getLineDarknessStep()
        : getLineDarknessStep(targetBucket.lineStrength);
    const targetMinimumDistance =
      multicolorMinDistanceMode === 'shared'
        ? parseMinDistanceValue(highlightRange)
        : parseMinDistanceValue(targetBucket.minDistance);
    const canvasImageData = stepProfile
      ? stepProfile.measure('canvas snapshot', getCanvasImageData)
      : getCanvasImageData();
    const targetColorMaskImageData = stepProfile
      ? stepProfile.measure('mask rebuild', () =>
          buildColorMaskScoringImageData(targetColorId, canvasImageData),
        )
      : buildColorMaskScoringImageData(targetColorId, canvasImageData);
    const targetNextNailNumber = targetColorMaskImageData
      ? stepProfile
        ? stepProfile.measure('next nail search', () =>
            getNextNailForImageData(targetStartNailNumber, targetColorMaskImageData.data, {
              usedLineKeys: targetUsedLineKeys,
              minimumAllowedDistance: targetMinimumDistance,
            }),
          )
        : getNextNailForImageData(targetStartNailNumber, targetColorMaskImageData.data, {
            usedLineKeys: targetUsedLineKeys,
            minimumAllowedDistance: targetMinimumDistance,
          })
      : null;
    if (targetNextNailNumber === null) {
      return;
    }

    const didApplyLine = handleMakeLinePermanent(targetStartNailNumber, targetNextNailNumber, {
      profile: stepProfile,
      lineDarknessStep: targetLineDarknessStep,
      skipVisibleSync: shouldDeferMulticolorStepVisuals,
      skipGlobalUsedLineCheck: multicolorUsedLineExclusionMode === 'per-color',
      skipGlobalUsedLineTracking: multicolorUsedLineExclusionMode === 'per-color',
      usedLineKeys: targetUsedLineKeys,
    });
    if (!didApplyLine) {
      return;
    }

    const shouldRefreshTargetPreview = !shouldDeferMulticolorStepVisuals;
    if (shouldRefreshTargetPreview) {
      activeColorMaskScoringImageDataRef.current = stepProfile
        ? stepProfile.measure('target preview refresh', () =>
            targetColorId === activePaletteColorId && isActiveColorMaskScoringEnabled
              ? activeColorMaskScoringImageDataRef.current
              : buildColorMaskScoringImageData(targetColorId),
          )
        : targetColorId === activePaletteColorId && isActiveColorMaskScoringEnabled
          ? activeColorMaskScoringImageDataRef.current
          : buildColorMaskScoringImageData(targetColorId);
    } else if (stepProfile) {
      stepProfile.rows.push({
        bucket: 'target preview refresh skipped',
        ms: 0,
      });
    }
    const experimentalLine = {
      startNailNumber: targetStartNailNumber,
      endNailNumber: targetNextNailNumber,
    };
    const nextBuckets = multicolorLineBuckets.map((bucket) =>
      bucket.colorId === targetColorId
        ? {
            ...bucket,
            lastNailNumber: targetNextNailNumber,
            lines: [...bucket.lines, experimentalLine],
          }
        : bucket,
    );
    const scheduleStateUpdates = () => {
      skipNextActiveTargetImageEffectRef.current = true;
      if (!shouldDeferMulticolorStepVisuals) {
        setActiveMulticolorTargetImage(activeColorMaskScoringImageDataRef.current);
      }
      setMulticolorLineBuckets(nextBuckets);
      if (!shouldDeferMulticolorStepVisuals) {
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
        startNail: targetStartNailNumber,
        nextNail: targetNextNailNumber,
      };
      stepProfile.measure('react state scheduling', scheduleStateUpdates);
      stepProfile.handlerEndAt = performance.now();
      pendingMulticolorStepProfileRef.current = stepProfile;
    } else {
      scheduleStateUpdates();
    }
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
    [inversePreviewScale, nailsCount],
  );
  const tasGeometryNails = useMemo(() => buildNails(nailsCount, 1).nails, [nailsCount]);
  const tasNetwork = useMemo(() => buildTasChordNetwork(tasGeometryNails), [tasGeometryNails]);
  const tasChordByKey = useMemo(
    () => new Map((tasNetwork.chords ?? []).map((chord) => [chord.key, chord])),
    [tasNetwork],
  );
  const normalizedSelectedTasRegionIndex = clamp(
    selectedTasRegionIndex,
    0,
    Math.max(0, tasNetwork.regionCount - 1),
  );
  const selectedTasRegion =
    tasNetwork.regions[normalizedSelectedTasRegionIndex] ?? null;
  const tasMinDistance = parseMinDistanceValue(highlightRange);
  const maxEnabledTasRegionIndex = getMaxEnabledTasRegionIndexForMinDistance(
    nailsCount,
    tasMinDistance,
  );
  const disabledTasRegionCount = Math.max(
    0,
    tasNetwork.regionCount - Math.max(0, maxEnabledTasRegionIndex + 1),
  );
  const isSelectedTasRegionEnabled =
    maxEnabledTasRegionIndex >= 0 &&
    normalizedSelectedTasRegionIndex <= maxEnabledTasRegionIndex;
  const isTasPlannerActive = plannerMode === 'tas';
  const tasPreviewSegmentsByRegion = useMemo(() => {
    const segmentsByRegion = new Map();
    for (const segment of buildTasPreviewSegments(tasNetwork)) {
      const regionSegments = segmentsByRegion.get(segment.regionIndex) ?? [];
      regionSegments.push(segment);
      segmentsByRegion.set(segment.regionIndex, regionSegments);
    }
    return segmentsByRegion;
  }, [tasNetwork]);
  const tasPreviewSegments = useMemo(
    () => {
      if (!isTasPlannerActive || !isTasPreviewEnabled) {
        return [];
      }

      if (tasViewScope !== 'all') {
        return normalizedSelectedTasRegionIndex <= maxEnabledTasRegionIndex
          ? tasPreviewSegmentsByRegion.get(normalizedSelectedTasRegionIndex) ?? []
          : [];
      }

      const segments = [];
      for (let regionIndex = 0; regionIndex <= maxEnabledTasRegionIndex; regionIndex += 1) {
        segments.push(...(tasPreviewSegmentsByRegion.get(regionIndex) ?? []));
      }
      return segments;
    },
    [
      isTasPlannerActive,
      isTasPreviewEnabled,
      maxEnabledTasRegionIndex,
      normalizedSelectedTasRegionIndex,
      tasPreviewSegmentsByRegion,
      tasViewScope,
    ],
  );
  const tasOwnershipPreview = useMemo(
    () => {
      if (
        !isTasPlannerActive ||
        !isTasOwnershipPreviewEnabled ||
        !hasLoadedImage ||
        !isSelectedTasRegionEnabled
      ) {
        return null;
      }

      const cacheKey = [
        imageName,
        imageSize?.width ?? 0,
        imageSize?.height ?? 0,
        imageCenter.x,
        imageCenter.y,
        imageScale,
        previewSize,
        nailsCount,
        normalizedSelectedTasRegionIndex,
      ].join('|');
      const cachedPreview = tasOwnershipPreviewCacheRef.current.get(cacheKey);
      if (cachedPreview) {
        return cachedPreview;
      }

      const nextPreview = buildTasPixelOwnershipPreview({
        imageSize,
        imageCenter,
        imageScale,
        previewSize,
        regionIndex: normalizedSelectedTasRegionIndex,
        tasNetwork,
      });
      tasOwnershipPreviewCacheRef.current.set(cacheKey, nextPreview);
      return nextPreview;
    },
    [
      hasLoadedImage,
      imageName,
      imageCenter,
      imageScale,
      imageSize,
      isTasPlannerActive,
      isSelectedTasRegionEnabled,
      isTasOwnershipPreviewEnabled,
      nailsCount,
      normalizedSelectedTasRegionIndex,
      previewSize,
      tasNetwork,
    ],
  );
  const tasPaletteFitSourceImageData = useMemo(() => {
    if (
      !isTasPlannerActive ||
      !isTasPaletteFitPreviewEnabled ||
      !hasLoadedImage ||
      !imageCanvasRef.current ||
      !imageSize
    ) {
      return null;
    }

    const context = imageCanvasRef.current.getContext('2d', {
      willReadFrequently: true,
    });
    const sourceImageData = context?.getImageData(0, 0, imageSize.width, imageSize.height) ?? null;
    if (!sourceImageData || enabledPalettePreviewColors.length === 0) {
      return sourceImageData;
    }

    return createPalettePreviewImageData(
      sourceImageData,
      enabledPalettePreviewColors,
      isPaletteDitheringEnabled,
      null,
      false,
    );
  }, [
    contrast,
    enabledPalettePreviewColors,
    hasLoadedImage,
    imageName,
    imageSize,
    isTasPlannerActive,
    isPaletteDitheringEnabled,
    isTasPaletteFitPreviewEnabled,
  ]);
  const allTasPaletteFit = useMemo(
    () => {
      if (
        !isTasPlannerActive ||
        !isTasPaletteFitPreviewEnabled ||
        !hasLoadedImage ||
        !tasPaletteFitSourceImageData
      ) {
        return null;
      }

      return filterTasPaletteFitByMaxRegion(
        buildAllTasRegionsPaletteFit({
            sourceImageData: tasPaletteFitSourceImageData,
            imageCenter,
            imageScale,
            previewSize,
            tasNetwork,
            paletteColors: enabledPalettePreviewColors,
            limitToPalette: isTasPaletteFitLimitedToPalette,
          }),
        maxEnabledTasRegionIndex,
      );
    },
    [
      enabledPalettePreviewColors,
      hasLoadedImage,
      imageCenter,
      imageScale,
      isTasPlannerActive,
      isTasPaletteFitPreviewEnabled,
      isTasPaletteFitLimitedToPalette,
      maxEnabledTasRegionIndex,
      previewSize,
      tasPaletteFitSourceImageData,
      tasNetwork,
    ],
  );
  const tasPaletteFit = useMemo(
    () =>
      isTasPlannerActive &&
      isTasPaletteFitPreviewEnabled &&
      hasLoadedImage &&
      isSelectedTasRegionEnabled &&
      tasPaletteFitSourceImageData
        ? buildTasRegionPaletteFit({
            sourceImageData: tasPaletteFitSourceImageData,
            imageCenter,
            imageScale,
            previewSize,
            regionIndex: normalizedSelectedTasRegionIndex,
            tasNetwork,
            paletteColors: enabledPalettePreviewColors,
            limitToPalette: isTasPaletteFitLimitedToPalette,
          })
        : null,
    [
      enabledPalettePreviewColors,
      hasLoadedImage,
      imageCenter,
      imageScale,
      isSelectedTasRegionEnabled,
      isTasPlannerActive,
      isTasPaletteFitPreviewEnabled,
      isTasPaletteFitLimitedToPalette,
      normalizedSelectedTasRegionIndex,
      previewSize,
      tasPaletteFitSourceImageData,
      tasNetwork,
    ],
  );
  const scopedTasPaletteFit =
    tasViewScope === 'all' && allTasPaletteFit ? allTasPaletteFit : tasPaletteFit;
  const tasPaletteFitActiveChordKeys = useMemo(
    () =>
      getLimitedTasChordKeySet({
        sortedRows: scopedTasPaletteFit?.sortedRows ?? [],
        regionLimitPercent: tasRegionChordLimitPercent,
        regions: tasNetwork.regions,
        maxRegionIndex: maxEnabledTasRegionIndex,
      }),
    [maxEnabledTasRegionIndex, scopedTasPaletteFit, tasNetwork, tasRegionChordLimitPercent],
  );
  const activeLimitedTasCount = tasPaletteFitActiveChordKeys.size;
  const visibleTasPaletteFitSegments = useMemo(() => {
    const fitSegments = scopedTasPaletteFit?.segments ?? [];
    return fitSegments.map((segment) => {
      const isTasLimitActive = tasPaletteFitActiveChordKeys.has(segment.chordKey);
      const isFocusedSameColorTas =
        isTasSameColorFocusEnabled &&
        isTasLimitActive &&
        segment.assignedColorId === activePaletteColorId;
      return {
        ...segment,
        isTasLimitActive,
        isTasLimitInactive: !isTasLimitActive,
        isFocusedSameColorTas,
        isUnfocusedSameColorTas:
          isTasSameColorFocusEnabled && isTasLimitActive && !isFocusedSameColorTas,
      };
    });
  }, [
    activePaletteColorId,
    isTasSameColorFocusEnabled,
    scopedTasPaletteFit,
    tasPaletteFitActiveChordKeys,
  ]);
  const finalDrawingPlan = useMemo(
    () =>
      isTasPlannerActive
        ? buildFinalDrawingPlanFromTasRows({
            maxRegionIndex: maxEnabledTasRegionIndex,
            paletteColors: multicolorPaletteColors,
            regionLimitPercent: tasRegionChordLimitPercent,
            regions: tasNetwork.regions,
            sortedRows: allTasPaletteFit?.sortedRows ?? [],
          })
        : buildFinalDrawingPlanFromTasRows({
            maxRegionIndex: -1,
            paletteColors: [],
            regionLimitPercent: 0,
            regions: [],
            sortedRows: [],
          }),
    [
      allTasPaletteFit,
      isTasPlannerActive,
      maxEnabledTasRegionIndex,
      multicolorPaletteColors,
      tasNetwork,
      tasRegionChordLimitPercent,
    ],
  );
  const isFinalDrawingPlanRenderable =
    isTasPlannerActive &&
    isMulticolorLabEnabled &&
    isPalettePreviewEnabled &&
    isTasPaletteFitPreviewEnabled &&
    finalDrawingPlan.totalStepCount > 0;
  const finalDrawingPlanLineSegments = useMemo(
    () =>
      isFinalDrawingPlanRenderable
        ? buildFinalPlanLineSegments(
            finalDrawingPlan.steps,
            nails,
            tasChordByKey,
            finalStringTrimPercent,
          )
        : [],
    [
      finalDrawingPlan,
      finalStringTrimPercent,
      isFinalDrawingPlanRenderable,
      nails,
      tasChordByKey,
    ],
  );
  const selectedConnectorPreviewSegments = useMemo(() => {
    if (
      !isTasPlannerActive ||
      (selectedChainChordKeys.length === 0 && selectedConnectorChordKeys.length === 0)
    ) {
      return [];
    }

    const selectedChainChordKeySet = new Set(selectedChainChordKeys);
    const selectedChordKeySet = new Set(selectedConnectorChordKeys);
    return (tasNetwork?.chords ?? [])
      .filter((chord) => selectedChainChordKeySet.has(chord.key) || selectedChordKeySet.has(chord.key))
      .map((chord) => ({
        key: `selected-connector-${chord.key}`,
        chordKey: chord.key,
        isChainChord: selectedChainChordKeySet.has(chord.key),
        isConnectorChord: selectedChordKeySet.has(chord.key),
        x1: chord.x1,
        y1: chord.y1,
        x2: chord.x2,
        y2: chord.y2,
      }));
  }, [isTasPlannerActive, selectedChainChordKeys, selectedConnectorChordKeys, tasNetwork]);
  useEffect(() => {
    if (!selectedTasChordKey) {
      return;
    }

    const currentRows = allTasPaletteFit?.sortedRows ?? tasPaletteFit?.sortedRows ?? [];
    if (!currentRows.some((row) => row.chordKey === selectedTasChordKey)) {
      setSelectedTasChordKey(null);
    }
  }, [allTasPaletteFit, selectedTasChordKey, tasPaletteFit]);

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
  const shouldComputeAlgorithmView = !isArtMode && hasLoadedImage;
  const shouldComputeAverageDarkness =
    !shouldDeferMulticolorStepVisuals &&
    !isArtMode &&
    hasLoadedImage &&
    lineStart &&
    lineEnd;
  const shouldComputeNextNail =
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
  if (canUseActiveColorMaskForLineScoring) {
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
      activeMulticolorRemainingLineCount > 0 && activeColorExperimentScoringImageData
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
      multicolorExperimentalSteppingMode === 'round-robin'
        ? eligibleMulticolorStepBuckets.length > 0
        : activeMulticolorRemainingLineCount > 0 && activeColorExperimentNextNailNumber !== null
    );
  const darkestNailsKey = darkestNails.map((point) => point.nail).join(',');

  useEffect(() => {
    setIsMinimumDarknessExpanded(false);
  }, [minimumDarkness, darkestNailsKey]);

  const monochromeArtLineSegments = buildArtLineSegments(savedNailSequence, nails);
  const renderedExperimentalLines = useMemo(() => {
    const visibleBucketsByColorId = new Map(
      multicolorLineBuckets
        .filter((bucket) => bucket.visible && bucket.lines.length > 0)
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

      const lineSlices = splitWholeUnits(bucket.lines.length, occurrenceCount);
      let lineOffset = 0;
      let occurrenceIndex = 1;

      for (const lineSliceCount of lineSlices) {
        const lineSlice = bucket.lines.slice(lineOffset, lineOffset + lineSliceCount);
        slicedLinesByEntryId.set(
          `${colorId}-pass-${occurrenceIndex}`,
          lineSlice.map((line, index) => ({
            ...line,
            colorId: bucket.colorId,
            label: bucket.label,
            hex: bucket.hex,
            visible: bucket.visible,
            key:
              `${bucket.colorId}-pass-${occurrenceIndex}-line-${index}` +
              `-${line.startNailNumber}-${line.endNailNumber}`,
          })),
        );
        lineOffset += lineSliceCount;
        occurrenceIndex += 1;
      }
    }

    return activeInterleaveEntries.flatMap(
      (entry) => slicedLinesByEntryId.get(entry.id) ?? [],
    );
  }, [multicolorInterleaveOrder, multicolorLineBuckets]);
  const experimentalArtLineSegments = buildManualArtLineSegments(
    renderedExperimentalLines
      .map((line) => ({
        startNailNumber: line.startNailNumber,
        endNailNumber: line.endNailNumber,
        stroke: line.hex,
      })),
    nails,
    'experimental-art-line',
  );
  const sharedResidualArtLineSegments = buildManualArtLineSegments(
    [...sharedResidualLines]
      .reverse()
      .map((line) => ({
        startNailNumber: line.startNailNumber,
        endNailNumber: line.endNailNumber,
        stroke: line.hex,
        className: 'art-line shared-residual-line',
      })),
    nails,
    'shared-residual-line',
  );
  const isGreyscalePlannerMode = plannerMode === 'greyscale';
  const isResidualPlannerVisible = plannerMode === 'residual';
  const isResidualFocusedMode = plannerMode === 'residual';
  const artLineSegments = isArtMode
    ? isResidualPlannerVisible
      ? sharedResidualArtLineSegments
      : isFinalDrawingPlanRenderable
      ? finalDrawingPlanLineSegments
      : (
          isExperimentalColorLinesOnlyPreviewEnabled
            ? experimentalArtLineSegments
            : [...monochromeArtLineSegments, ...experimentalArtLineSegments]
        )
    : [];
  const artSourceLabel = isResidualPlannerVisible
    ? `Shared residual: ${sharedResidualLines.length.toLocaleString()} lines`
    : isFinalDrawingPlanRenderable
    ? `Final TAS plan: ${finalDrawingPlan.totalStepCount.toLocaleString()} rows, ${finalDrawingPlan.connectorCount.toLocaleString()} connectors, ${finalDrawingPlan.unresolvedGapCount.toLocaleString()} gaps`
    : isExperimentalColorLinesOnlyPreviewEnabled
      ? 'Manual multicolor lines only'
      : 'Manual/algorithm lines';
  const shouldHideTasInspectionOverlaysInPreview =
    !isArtMode || isResidualPlannerVisible || (isArtMode && isFinalDrawingPlanRenderable);
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
    setIsExperimentalColorLinesOnlyPreviewEnabled(false);
    setMulticolorExperimentalSteppingMode('single-color');
    setMulticolorRoundRobinNextColorId(null);
    setIsStepLoopPaused(false);
    setHiddenPreviewLineKey(currentPreviewLineKey);
    setHoveredPixel(null);
  };

  const handleRefreshMulticolorPreviews = () => {
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
            lines: [],
          }
        : bucket,
    );
    setMulticolorLineBuckets(nextBuckets);
    setIsExperimentalColorLinesOnlyPreviewEnabled(
      nextBuckets.some((bucket) => bucket.lines.length > 0) &&
      isExperimentalColorLinesOnlyPreviewEnabled,
    );
    rebuildCanvasFromStoredLineState(savedNailSequence, nextBuckets, activePaletteColorId);
  };

  const handleResetAllMulticolorState = () => {
    const nextBuckets = multicolorLineBuckets.map((bucket) => ({
      ...bucket,
      lastNailNumber: null,
      lines: [],
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
    const fileBaseName = imageName
      ? imageName.replace(/\.[^.]+$/, '')
      : 'string-art';
    const multicolorSession = {
      version: 3,
      palettePresetId: multicolorPalettePresetId,
      paletteColors: multicolorPaletteColors,
      activePaletteColorId,
      isMulticolorLabEnabled,
      isPalettePreviewEnabled,
      isPaletteDitheringEnabled,
      multicolorDebugView,
      maskBlurRadius,
      multicolorTargetTotalLines,
      multicolorLockedLineOverride,
      multicolorExperimentalSteppingMode,
      multicolorRoundRobinNextColorId,
      multicolorUsedLineExclusionMode,
      multicolorLineStrengthMode,
      multicolorMinDistanceMode,
      multicolorInterleaveEntryIds,
      isExperimentalColorLinesOnlyPreviewEnabled,
      lineBuckets: multicolorLineBuckets,
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
                  lines: Array.isArray(bucket?.lines)
                    ? bucket.lines
                        .map((line) => ({
                          startNailNumber:
                            Number.isInteger(line?.startNailNumber) ? line.startNailNumber : null,
                          endNailNumber:
                            Number.isInteger(line?.endNailNumber) ? line.endNailNumber : null,
                        }))
                        .filter(
                          (line) =>
                            Number.isInteger(line.startNailNumber) &&
                            Number.isInteger(line.endNailNumber) &&
                            line.startNailNumber > 0 &&
                            line.endNailNumber > 0,
                        )
                    : [],
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
          lines: importedBucket?.lines ?? [],
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
      setMulticolorLockedLineOverride(nextLockedLineOverride);
      setMulticolorExperimentalSteppingMode(
        rawSession?.multicolorExperimentalSteppingMode === 'round-robin'
          ? 'round-robin'
          : 'single-color',
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
      setMulticolorInterleaveEntryIds(
        Array.isArray(rawSession?.multicolorInterleaveEntryIds)
          ? rawSession.multicolorInterleaveEntryIds.filter((entryId) => typeof entryId === 'string')
          : [],
      );
      setIsExperimentalColorLinesOnlyPreviewEnabled(
        Boolean(rawSession?.isExperimentalColorLinesOnlyPreviewEnabled) &&
        nextBuckets.some((bucket) => bucket.lines.length > 0),
      );
      setMulticolorLineBuckets(nextBuckets);
      setHiddenPreviewLineKey(null);
      rebuildCanvasFromStoredLineState(savedNailSequence, nextBuckets, nextActivePaletteColorId);
    } catch (error) {
      window.alert('Could not import the multicolor session JSON.');
    }
  };

  const handleExportNailList = () => {
    const nailListContent = isResidualPlannerVisible
      ? [
          'step\tcolor\tfrom\tto\tscore',
          ...sharedResidualLines.map((line, index) => [
            index + 1,
            line.label,
            line.startNailNumber,
            line.endNailNumber,
            Math.round(line.score),
          ].join('\t')),
        ].join('\n')
      : isFinalDrawingPlanRenderable
      ? [
          'step\tcolor\tfrom\tto\tD\ttype\tchord',
          ...finalDrawingPlan.steps.map((step) => [
            step.stepNumber,
            step.colorLabel,
            step.drawFromNailNumber,
            step.drawToNailNumber,
            `D${step.regionIndex}`,
            step.rowType,
            step.chordKey,
          ].join('\t')),
        ].join('\n')
      : [1, ...savedNailSequence].join('\n');
    const fileBaseName = imageName
      ? imageName.replace(/\.[^.]+$/, '')
      : 'string-art';
    const exportUrl = URL.createObjectURL(new Blob([nailListContent], { type: 'text/plain' }));
    const downloadLink = document.createElement('a');
    downloadLink.href = exportUrl;
    downloadLink.download = isResidualPlannerVisible
      ? `${fileBaseName}-shared-residual-lines.tsv`
      : isFinalDrawingPlanRenderable
      ? `${fileBaseName}-final-winding-plan.tsv`
      : `${fileBaseName}-nail-list.txt`;
    downloadLink.click();
    URL.revokeObjectURL(exportUrl);
  };

  const handleGenerateAutomaticPalette = (colorCount) => {
    if (!imageCanvasRef.current || !imageSize || previewSize <= 0) {
      return;
    }

    const context = imageCanvasRef.current.getContext('2d', {
      willReadFrequently: true,
    });
    const sourceImageData = context?.getImageData(0, 0, imageSize.width, imageSize.height);
    if (!sourceImageData) {
      return;
    }

    const nextPaletteColors = createAutomaticPaletteColors({
      colorCount,
      imageCenter,
      imageScale,
      previewSize,
      sourceImageData,
    });
    if (nextPaletteColors.length === 0) {
      return;
    }

    setMulticolorPalettePresetId('auto-generated');
    setMulticolorPaletteColors(nextPaletteColors);
    setActivePaletteColorId(nextPaletteColors[0]?.id ?? null);
    setIsPalettePreviewEnabled(true);
    setIsTasPaletteFitPreviewEnabled(true);
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
          {!isResidualFocusedMode && (
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
          )}
        </div>

        <div className="planner-mode-panel">
          <span className="multicolor-lab-label">Planner</span>
          <div className="multicolor-debug-toggle-group" role="radiogroup" aria-label="Planner mode">
            <button
              className={[
                'multicolor-debug-toggle',
                plannerMode === 'residual' ? 'is-active' : '',
              ].filter(Boolean).join(' ')}
              type="button"
              role="radio"
              aria-checked={plannerMode === 'residual'}
              onClick={() => {
                setPlannerMode('residual');
                setIsArtMode(true);
              }}
            >
              residual
            </button>
            <button
              className={[
                'multicolor-debug-toggle',
                plannerMode === 'greyscale' ? 'is-active' : '',
              ].filter(Boolean).join(' ')}
              type="button"
              role="radio"
              aria-checked={plannerMode === 'greyscale'}
              onClick={() => {
                setPlannerMode('greyscale');
                setIsArtMode(true);
              }}
            >
              greyscale
            </button>
            <button
              className={[
                'multicolor-debug-toggle',
                plannerMode === 'tas' ? 'is-active' : '',
              ].filter(Boolean).join(' ')}
              type="button"
              role="radio"
              aria-checked={plannerMode === 'tas'}
              onClick={() => setPlannerMode('tas')}
            >
              TAS legacy
            </button>
          </div>
        </div>

        <div className="panel">
          <div className="nail-controls">
            <label className="slider-control slider-control-wide">
              <span>Nails: {nailsCount}</span>
              <input
                type="range"
                min="0"
                max="300"
                step="10"
                value={nailsCount}
                onChange={(event) => {
                  setNailsCount(clamp(Number(event.target.value), 0, 300));
                }}
              />
            </label>

            <div className="line-inputs">
              {!isResidualFocusedMode && (
                <>
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
                </>
              )}
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
            {!isResidualFocusedMode && (
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
            )}
          </div>
          {!isResidualFocusedMode && (
          <>
          <p className="line-darkness">
            Average darkness: {averageLineDarknessDisplay}
          </p>
          <p className="line-darkness-source">
            Scoring source: {lineScoringModeLabel}
          </p>
          {isArtMode && (
            <p className="line-darkness-source">
              Art source: {artSourceLabel}
            </p>
          )}
          {isArtMode && plannerMode === 'tas' && isFinalDrawingPlanRenderable && (
            <label className="slider-control slider-control-wide final-string-trim-control">
              <span>Trim strings toward TAS: {finalStringTrimPercent}%</span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={finalStringTrimPercent}
                onChange={(event) =>
                  setFinalStringTrimPercent(
                    clamp(Number(event.target.value), 0, 100),
                  )
                }
              />
            </label>
          )}
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
              disabled={
                isResidualPlannerVisible
                  ? sharedResidualLines.length === 0
                  : !isFinalDrawingPlanRenderable && savedNailSequence.length === 0
              }
            >
              {isResidualPlannerVisible
                ? 'export residual lines'
                : isFinalDrawingPlanRenderable
                  ? 'export final winding'
                  : 'export nail list'}
            </button>
          </div>
          </>
          )}
          {SHOW_BRUSH_TOOLS && (
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
          {isResidualPlannerVisible && (
            <section className="multicolor-lab-section residual-lab-section">
              <div className="multicolor-lab-section-head">
                <h3>Shared residual solver</h3>
                <p>All enabled thread colors compete against one shared board image.</p>
              </div>
              <div className="multicolor-lab-section-card">
                <div className="multicolor-inline-stats">
                  <span className="multicolor-inline-stat">
                    Lines {sharedResidualLines.length.toLocaleString()}
                  </span>
                  <span className="multicolor-inline-stat">
                    Colors {enabledPalettePreviewColors.length.toLocaleString()}
                  </span>
                  <span className="multicolor-inline-stat">
                    Opacity {Math.round(clamp(getLineDarknessStep() / 100, 0.01, 0.95) * 100)}%
                  </span>
                  <span className="multicolor-inline-stat">
                    Thickness {residualStringThickness}%
                  </span>
                  <span className="multicolor-inline-stat">
                    Target {residualImagePreviewMode}
                  </span>
                  <span className="multicolor-inline-stat">
                    Error OKLab
                  </span>
                </div>
                <div className="multicolor-inline-controls">
                  <span className="multicolor-lab-label">Preview</span>
                  <div
                    className="multicolor-debug-toggle-group"
                    role="radiogroup"
                    aria-label="Residual preview source"
                  >
                    <button
                      className={[
                        'multicolor-debug-toggle',
                        residualPreviewMode === 'original' ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      role="radio"
                      aria-checked={residualPreviewMode === 'original'}
                      onClick={() => setResidualPreviewMode('original')}
                    >
                      original
                    </button>
                    <button
                      className={[
                        'multicolor-debug-toggle',
                        residualPreviewMode === 'palette' ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      role="radio"
                      aria-checked={residualPreviewMode === 'palette'}
                      onClick={() => setResidualPreviewMode('palette')}
                      disabled={enabledPalettePreviewColors.length === 0}
                    >
                      palette
                    </button>
                    <button
                      className={[
                        'multicolor-debug-toggle',
                        residualPreviewMode === 'dithered' ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      role="radio"
                      aria-checked={residualPreviewMode === 'dithered'}
                      onClick={() => setResidualPreviewMode('dithered')}
                      disabled={enabledPalettePreviewColors.length === 0}
                    >
                      dithered
                    </button>
                    <button
                      className={[
                        'multicolor-debug-toggle',
                        residualPreviewMode === 'strings' ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      role="radio"
                      aria-checked={residualPreviewMode === 'strings'}
                      onClick={() => setResidualPreviewMode('strings')}
                    >
                      strings
                    </button>
                  </div>
                </div>
                <label className="slider-control slider-control-wide">
                  <span>
                    String thickness: {residualStringThickness}% · keeps{' '}
                    {Math.round(residualCoveredPixelWeight * 100)}% every{' '}
                    {residualOcclusionPixelStride}px
                  </span>
                  <input
                    type="range"
                    min={MIN_RESIDUAL_STRING_THICKNESS}
                    max={MAX_RESIDUAL_STRING_THICKNESS}
                    step="1"
                    value={residualStringThickness}
                    onChange={(event) =>
                      handleResidualStringThicknessChange(Number(event.target.value))
                    }
                    disabled={isPerformingSteps}
                  />
                </label>
                <div className="automatic-palette-panel">
                  <label className="slider-control automatic-palette-count">
                    <span>Automatic colors: {automaticPaletteColorCount}</span>
                    <input
                      type="range"
                      min="2"
                      max="12"
                      step="1"
                      value={automaticPaletteColorCount}
                      onChange={(event) =>
                        setAutomaticPaletteColorCount(Number.parseInt(event.target.value, 10))
                      }
                    />
                  </label>
                  <button
                    className="action-button action-button-secondary automatic-palette-button"
                    type="button"
                    disabled={!hasLoadedImage}
                    onClick={() => handleGenerateAutomaticPalette(automaticPaletteColorCount)}
                  >
                    find palette
                  </button>
                  <p className="multicolor-mini-note">
                    Finds thread colors from the image inside the circle using OKLab clustering.
                  </p>
                </div>
                <div className="multicolor-palette-list">
                  {multicolorPaletteColors.map((color) => (
                    <div
                      key={color.id}
                      className={[
                        'multicolor-palette-row',
                        color.enabled ? '' : 'is-disabled',
                        color.id === activePaletteColorId ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                    >
                      <input
                        type="checkbox"
                        checked={color.enabled}
                        onChange={(event) => {
                          setMulticolorPaletteColors((currentColors) =>
                            currentColors.map((currentColor) =>
                              currentColor.id === color.id
                                ? { ...currentColor, enabled: event.target.checked }
                                : currentColor,
                            ),
                          );
                        }}
                      />
                      <button
                        className={[
                          'multicolor-palette-swatch-button',
                          color.id === activePaletteColorId ? 'is-active' : '',
                        ].filter(Boolean).join(' ')}
                        type="button"
                        onClick={() => setActivePaletteColorId(color.id)}
                        aria-label={`Set active palette color ${color.label}`}
                        title={`Active color: ${color.label}`}
                      >
                        <span
                          className="multicolor-palette-swatch"
                          style={{ backgroundColor: color.hex }}
                        />
                      </button>
                      <span className="multicolor-palette-name">{color.label}</span>
                      <span className="multicolor-palette-count-value">
                        <span>
                          {hasLoadedImage
                            ? `${(multicolorPalettePixelCountMap.get(color.id) ?? 0).toLocaleString()} px`
                            : '-'}
                        </span>
                        <span>
                          {(sharedResidualLineCountMap.get(color.id) ?? 0).toLocaleString()} strings
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
                {sharedResidualLastStep && (
                  <p className="multicolor-mini-note">
                    {sharedResidualLastStep.status}
                    {sharedResidualLastStep.colorLabel
                      ? ` ${sharedResidualLastStep.colorLabel} ${sharedResidualLastStep.startNailNumber}-${sharedResidualLastStep.endNailNumber}`
                      : ''}
                    {Number.isFinite(sharedResidualLastStep.score)
                      ? `, score ${Math.round(sharedResidualLastStep.score).toLocaleString()}`
                      : ''}
                  </p>
                )}
                <div className="residual-action-grid">
                  <button
                    className="action-button"
                    type="button"
                    onClick={handleApplySharedResidualStep}
                    disabled={
                      isPerformingSteps ||
                      !hasLoadedImage ||
                      enabledPalettePreviewColors.length === 0
                    }
                  >
                    apply one residual step
                  </button>
                  <button
                    className="action-button action-button-secondary"
                    type="button"
                    onClick={handleLoopSharedResidualSteps}
                    disabled={
                      !isPerformingSteps &&
                      (!hasLoadedImage || enabledPalettePreviewColors.length === 0)
                    }
                  >
                    {isPerformingSteps
                      ? `pause at ${sharedResidualLines.length.toLocaleString()}`
                      : isStepLoopPaused
                        ? `continue (${sharedResidualLines.length.toLocaleString()})`
                        : 'loop steps'}
                  </button>
                  <button
                    className="action-button action-button-secondary"
                    type="button"
                    onClick={resetSharedResidualExperiment}
                    disabled={
                      isPerformingSteps ||
                      (!hasLoadedImage && sharedResidualLines.length === 0)
                    }
                  >
                    reset residual
                  </button>
                </div>
                <p className="multicolor-mini-note">
                  Board starts white. Each candidate colored line is alpha-blended onto the shared
                  board and scored against the selected target. Palette targets only give positive
                  credit to the matching thread color, with a balance penalty for overused colors.
                  Thickness controls how strongly earlier strings claim pixels for future scoring.
                </p>
              </div>
            </section>
          )}
          {plannerMode === 'tas' && (
          <Profiler id="MulticolorLab" onRender={handleReactProfile}>
            <MulticolorLab
              activePaletteColor={activePaletteColor}
              activePaletteColorId={activePaletteColorId}
              ditheredComparisonCanvasRef={ditheredComparisonCanvasRef}
              hasOriginalImage={Boolean(originalImageDataRef.current)}
              allTasPaletteFit={allTasPaletteFit}
              isBlackAndWhite={isBlackAndWhite}
              isMulticolorLabEnabled={isMulticolorLabEnabled}
              isPaletteDitheringEnabled={isPaletteDitheringEnabled}
              isPalettePreviewEnabled={isPalettePreviewEnabled}
              isTasOwnershipPreviewEnabled={isTasOwnershipPreviewEnabled}
              isTasPaletteFitPreviewEnabled={isTasPaletteFitPreviewEnabled}
              isTasPaletteFitLimitedToPalette={isTasPaletteFitLimitedToPalette}
              isTasPreviewEnabled={isTasPreviewEnabled}
              isSelectedTasRegionEnabled={isSelectedTasRegionEnabled}
              isTasSameColorFocusEnabled={isTasSameColorFocusEnabled}
              disabledTasRegionCount={disabledTasRegionCount}
              maxEnabledTasRegionIndex={maxEnabledTasRegionIndex}
              multicolorPaletteColors={multicolorPaletteColors}
              multicolorPaletteCoverage={multicolorPaletteCoverage}
              multicolorPaletteCoverageWithLineAllocation={multicolorPaletteCoverageWithLineAllocation}
              multicolorPaletteCoverageWithSuggestions={multicolorPaletteCoverageWithSuggestions}
              multicolorLockedLineOverride={multicolorLockedLineOverride}
              multicolorPalettePixelCountMap={multicolorPalettePixelCountMap}
              multicolorPalettePreset={multicolorPalettePreset}
              multicolorTargetTotalLines={multicolorTargetTotalLines}
              normalizedSelectedTasRegionIndex={normalizedSelectedTasRegionIndex}
              originalComparisonCanvasRef={originalComparisonCanvasRef}
              paletteComparisonCanvasRef={paletteComparisonCanvasRef}
              selectedTasRegion={selectedTasRegion}
              selectedTasChordKey={selectedTasChordKey}
              selectedConnectorGapChordKey={selectedConnectorGapChordKey}
              selectedChainChordKeys={selectedChainChordKeys}
              selectedConnectorChordKeys={selectedConnectorChordKeys}
              shouldShowPaletteComparison={shouldShowPaletteComparison}
              activeLimitedTasCount={activeLimitedTasCount}
              tasRegionChordLimitPercent={tasRegionChordLimitPercent}
              tasOwnershipPreview={tasOwnershipPreview}
              tasPaletteFit={tasPaletteFit}
              tasNetwork={tasNetwork}
              tasMinDistance={tasMinDistance}
              tasViewScope={tasViewScope}
              totalAllocatedSuggestedLines={totalAllocatedSuggestedLines}
              totalPaletteCoverageTenths={totalPaletteCoverageTenths}
              onGenerateAutomaticPalette={handleGenerateAutomaticPalette}
              onDiagnosticRender={handleDiagnosticRender}
              setActivePaletteColorId={setActivePaletteColorId}
              setIsBlackAndWhite={setIsBlackAndWhite}
              setIsMulticolorLabEnabled={setIsMulticolorLabEnabled}
              setIsPaletteDitheringEnabled={setIsPaletteDitheringEnabled}
              setIsPalettePreviewEnabled={setIsPalettePreviewEnabled}
              setIsTasOwnershipPreviewEnabled={setIsTasOwnershipPreviewEnabled}
              setIsTasPaletteFitLimitedToPalette={setIsTasPaletteFitLimitedToPalette}
              setIsTasPaletteFitPreviewEnabled={setIsTasPaletteFitPreviewEnabled}
              setIsTasPreviewEnabled={setIsTasPreviewEnabled}
              setIsTasSameColorFocusEnabled={setIsTasSameColorFocusEnabled}
              setMulticolorLockedLineOverride={setMulticolorLockedLineOverride}
              setMulticolorPaletteColors={setMulticolorPaletteColors}
              setMulticolorPalettePresetId={setMulticolorPalettePresetId}
              setMulticolorTargetTotalLines={setMulticolorTargetTotalLines}
              setSelectedTasRegionIndex={setSelectedTasRegionIndex}
              setSelectedTasChordKey={setSelectedTasChordKey}
              setSelectedChainChordKeys={setSelectedChainChordKeys}
              setSelectedConnectorGapChordKey={setSelectedConnectorGapChordKey}
              setSelectedConnectorChordKeys={setSelectedConnectorChordKeys}
              setTasRegionChordLimitPercent={setTasRegionChordLimitPercent}
              setTasViewScope={setTasViewScope}
            />
          </Profiler>
          )}
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
        selectedTasChordKey={selectedTasChordKey}
        selectedChainChordKeys={selectedChainChordKeys}
        selectedConnectorChordKeys={selectedConnectorChordKeys}
        selectedConnectorPreviewSegments={selectedConnectorPreviewSegments}
        shouldShowPreviewLine={shouldShowPreviewLine}
        showNailNumbers={showNailNumbers}
        selectedTasRegionIndex={normalizedSelectedTasRegionIndex}
        tasPaletteFitSegments={
          shouldHideTasInspectionOverlaysInPreview ? [] : visibleTasPaletteFitSegments
        }
        tasOwnershipPreviewImageData={
          shouldHideTasInspectionOverlaysInPreview ? null : tasOwnershipPreview?.imageData ?? null
        }
        tasPreviewSegments={shouldHideTasInspectionOverlaysInPreview ? [] : tasPreviewSegments}
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
