import { useCallback, useEffect, useRef, useState } from 'react';
import BrushPanel from './components/BrushPanel';
import HoveredPixelOverlay from './components/HoveredPixelOverlay';
import MulticolorLab from './components/MulticolorLab';
import PreviewWorkspace from './components/PreviewWorkspace';
import {
  buildArtLineSegments,
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
  allocateWholeUnitsByWeight,
  blurMaskImageData,
  clonePalettePreset,
  countPixelsByCurrentPaletteSource,
  countPixelsByNearestPaletteColor,
  createPaletteMaskImageData,
  createPalettePreviewImageData,
  drawImageDataToCanvas,
  hexToRgb,
  isImagePixelInsidePreviewCircle,
  MULTICOLOR_PALETTE_PRESETS,
} from './multicolor';

const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
const MIN_PREVIEW_SCALE = 50;
const MAX_PREVIEW_SCALE = 1000;
const INITIAL_PREVIEW_SCALE = 150;
const INITIAL_IMAGE_SCALE_MULTIPLIER = 1;
const DEFAULT_LINE_STRENGTH = 30;
const MIN_HIGHLIGHT_DISTANCE = 0;
const MAX_HIGHLIGHT_DISTANCE = 50;
const MIN_LINE_STRENGTH = 1;
const MAX_LINE_STRENGTH = 50;
const MIN_CONTRAST = 0;
const MAX_CONTRAST = 100;
const DEFAULT_CONTRAST = 100;
const MIN_BRUSH_RADIUS = 1;
const MAX_BRUSH_RADIUS = 40;
const MIN_GROUP_VALUE = 0;
const MAX_GROUP_VALUE = 10;
const GROUP_VALUE_STEP = 0.05;
const GROUP_COLORS = [
  '#0ea5e9',
  '#f97316',
  '#22c55e',
  '#e11d48',
  '#8b5cf6',
  '#facc15',
];

function App() {
  const [imageName, setImageName] = useState('');
  const [imageSize, setImageSize] = useState(null);
  const [cropToCircle, setCropToCircle] = useState(true);
  const [isBlackAndWhite, setIsBlackAndWhite] = useState(true);
  const [showNailNumbers, setShowNailNumbers] = useState(true);
  const [nailsCount, setNailsCount] = useState(300);
  const [lineFrom, setLineFrom] = useState('1');
  const [lineTo, setLineTo] = useState('1');
  const [highlightRange, setHighlightRange] = useState('15');
  const [lineStrength, setLineStrength] = useState(String(DEFAULT_LINE_STRENGTH));
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
  const [isPaletteDitheringEnabled, setIsPaletteDitheringEnabled] = useState(false);
  const [multicolorPalettePixelCounts, setMulticolorPalettePixelCounts] = useState([]);
  const [multicolorPaletteCoverage, setMulticolorPaletteCoverage] = useState([]);
  const [activePaletteColorId, setActivePaletteColorId] = useState(
    MULTICOLOR_PALETTE_PRESETS[0].colors[0].id,
  );
  const [isActivePaletteColorOnlyEnabled, setIsActivePaletteColorOnlyEnabled] = useState(false);
  const [maskBlurRadius, setMaskBlurRadius] = useState(0);

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
  const originalImageDataRef = useRef(null);
  const sourceUrlRef = useRef(null);
  const animationFrameRef = useRef(null);
  const isMountedRef = useRef(true);
  const pauseRequestedRef = useRef(false);
  const pixelWeightMapRef = useRef(null);
  const linePixelsCacheRef = useRef(new Map());
  const lineBoostMapRef = useRef(null);
  const usedLineKeysRef = useRef(new Set());
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
  ) ?? MULTICOLOR_PALETTE_PRESETS[0];
  const enabledPaletteColors = multicolorPaletteColors.filter((color) => color.enabled);
  const enabledPalettePreviewColors = enabledPaletteColors
    .map((color) => ({
      ...color,
      rgb: hexToRgb(color.hex),
    }))
    .filter((color) => color.rgb);
  const activePaletteColor = multicolorPaletteColors.find((color) => color.id === activePaletteColorId) ?? null;
  const activePalettePreviewColor = enabledPalettePreviewColors.find(
    (color) => color.id === activePaletteColorId,
  ) ?? null;
  const multicolorPalettePixelCountMap = new Map(
    multicolorPalettePixelCounts.map((color) => [color.id, color.pixelCount]),
  );
  const totalPaletteCoverageTenths = multicolorPaletteCoverage.reduce(
    (sum, color) => sum + color.percentageTenths,
    0,
  );
  const totalSuggestedMulticolorLines = savedNailSequence.length;
  const multicolorPaletteCoverageWithSuggestions = allocateWholeUnitsByWeight(
    multicolorPaletteCoverage,
    totalSuggestedMulticolorLines,
    (color) => color.pixelCount,
  );
  const totalAllocatedSuggestedLines = multicolorPaletteCoverageWithSuggestions.reduce(
    (sum, color) => sum + color.allocatedUnits,
    0,
  );
  const isActiveColorOnlyControlVisible = multicolorDebugView === 'palette-preview';
  const shouldShowOriginalDebugView =
    isMulticolorLabEnabled && multicolorDebugView === 'original';
  const shouldShowCurrentGrayscaleDebugView =
    isMulticolorLabEnabled && multicolorDebugView === 'current-grayscale';
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
  const palettePreviewModeLabel = isPaletteDitheringEnabled
    ? 'Floyd-Steinberg dithered preview'
    : 'Nearest-palette preview';
  const shouldShowPaletteComparison =
    isPalettePreviewVisible &&
    Boolean(originalImageDataRef.current);

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
    originalImageDataRef.current = null;
    linePixelsCacheRef.current.clear();
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

  const getNextNailForImageData = (originIndex, sourceImageData) => {
    if (
      !imageSize ||
      !sourceImageData ||
      !Number.isInteger(originIndex) ||
      originIndex < 1 ||
      originIndex > nailsCount
    ) {
      return null;
    }

    let minimumDarkness = Infinity;
    let selectedNail = null;

    for (const targetNail of nails) {
      if (usedLineKeysRef.current.has(getNormalizedLineKey(originIndex, targetNail.number))) {
        continue;
      }

      if (
        hasHighlightDistance &&
        getCircularNailDistance(targetNail.number, originIndex, nailsCount) <= highlightDistance
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

  const getLineDarknessStep = () => {
    const parsedLineStrength = Number.parseInt(lineStrength, 10);
    return Number.isFinite(parsedLineStrength)
      ? clamp(parsedLineStrength, MIN_LINE_STRENGTH, MAX_LINE_STRENGTH)
      : DEFAULT_LINE_STRENGTH;
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

  const handleMakeLinePermanent = (startIndex = fromIndex, endIndex = toIndex) => {
    const lineKey = getNormalizedLineKey(startIndex, endIndex);
    const targetLinePixels = getLinePixelsForIndexes(startIndex, endIndex);
    if (
      !lineKey ||
      usedLineKeysRef.current.has(lineKey) ||
      !imageCanvasRef.current ||
      !imageSize ||
      targetLinePixels.length === 0
    ) {
      return false;
    }

    const lineDarknessStep = getLineDarknessStep();
    const context = imageCanvasRef.current.getContext('2d', {
      willReadFrequently: true,
    });
    if (!context) {
      return false;
    }

    const canvasImage = context.getImageData(0, 0, imageSize.width, imageSize.height);
    applyLineToImageData(
      canvasImage.data,
      startIndex,
      endIndex,
      lineDarknessStep,
      lineBoostMapRef.current,
    );
    usedLineKeysRef.current.add(lineKey);

    context.putImageData(canvasImage, 0, 0);
    syncVisibleCanvas();
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
          const nextNail = getNextNailForImageData(currentFromIndex, canvasImage.data);
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

          usedLineKeysRef.current.add(getNormalizedLineKey(currentFromIndex, nextNail));
          frameNails.push(nextNail);
          currentFromIndex = nextNail;
          stepIndex += 1;
        }

        if (frameNails.length > 0 && isMountedRef.current) {
          const latestNail = frameNails[frameNails.length - 1];
          if (!document.hidden) {
            context.putImageData(canvasImage, 0, 0);
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
  } = buildNails(nailsCount, inversePreviewScale);

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
  const shouldComputeAlgorithmView = !isArtMode && hasLoadedImage;
  const shouldComputeAverageDarkness = !isArtMode && hasLoadedImage && lineStart && lineEnd;
  const shouldComputeNextNail = hasLoadedImage && hasValidFromIndex && Boolean(imageSize);
  const needsImageData = shouldComputeAverageDarkness || shouldComputeNextNail;
  const imageData =
    needsImageData && imageCanvasRef.current && imageSize
      ? imageCanvasRef.current
          .getContext('2d', { willReadFrequently: true })
          ?.getImageData(0, 0, imageSize.width, imageSize.height).data ?? null
      : null;

  const linePixels = shouldComputeAverageDarkness
    ? getLinePixelsForIndexes(fromIndex, toIndex)
    : [];
  const hasRenderableLine = linePixels.length > 1;
  const currentPreviewLineKey =
    hasValidLine ? getNormalizedLineKey(fromIndex, toIndex) : null;
  const isCurrentLineUsed =
    currentPreviewLineKey !== null && usedLineKeysRef.current.has(currentPreviewLineKey);
  const shouldShowPreviewLine =
    lineStart &&
    lineEnd &&
    currentPreviewLineKey !== hiddenPreviewLineKey &&
    !isCurrentLineUsed;

  let averageLineDarkness = null;
  if (linePixels.length > 0 && imageData && imageSize) {
    const weightedDarkness = getWeightedAverageDarkness(imageData, linePixels);
    averageLineDarkness =
      weightedDarkness === null ? null : Math.round(weightedDarkness);
  }

  let darknessSeries = [];
  if (shouldComputeNextNail && imageData) {
    darknessSeries = nails.map((targetNail) => {
      const isUsedLine = usedLineKeysRef.current.has(
        getNormalizedLineKey(fromIndex, targetNail.number),
      );
      const pixels = getLinePixelsForIndexes(fromIndex, targetNail.number);
      const weightedDarkness = getWeightedAverageDarkness(imageData, pixels);

      return {
        nail: targetNail.number,
        darkness: isUsedLine ? 255 : weightedDarkness ?? 255,
        isUsedLine,
      };
    });
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
    shouldComputeNextNail && imageData
      ? darkestNails[0]?.nail ?? null
      : null;
  const darkestNailsKey = darkestNails.map((point) => point.nail).join(',');

  useEffect(() => {
    setIsMinimumDarknessExpanded(false);
  }, [minimumDarkness, darkestNailsKey]);

  const artLineSegments = isArtMode
    ? buildArtLineSegments(savedNailSequence, nails)
    : [];
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
    syncVisibleCanvas();
    setSavedNailSequence([]);
    setIsStepLoopPaused(false);
    setHiddenPreviewLineKey(currentPreviewLineKey);
    setHoveredPixel(null);
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
    <div className="app-shell">
      <aside className="sidebar">
        <label className="upload-field">
          <span>Choose image</span>
          <input
            type="file"
            accept="image/*"
            onChange={handleFileChange}
          />
        </label>

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
          <MulticolorLab
            activePaletteColor={activePaletteColor}
            activePaletteColorId={activePaletteColorId}
            ditheredComparisonCanvasRef={ditheredComparisonCanvasRef}
            enabledPalettePreviewColors={enabledPalettePreviewColors}
            hasOriginalImage={Boolean(originalImageDataRef.current)}
            isActiveColorOnlyControlVisible={isActiveColorOnlyControlVisible}
            isActivePaletteColorOnlyEnabled={isActivePaletteColorOnlyEnabled}
            isMulticolorLabEnabled={isMulticolorLabEnabled}
            isPaletteDitheringEnabled={isPaletteDitheringEnabled}
            isPaletteMaskVisible={isPaletteMaskVisible}
            isPalettePreviewEnabled={isPalettePreviewEnabled}
            maskBlurRadius={maskBlurRadius}
            multicolorDebugView={multicolorDebugView}
            multicolorPaletteColors={multicolorPaletteColors}
            multicolorPaletteCoverage={multicolorPaletteCoverage}
            multicolorPaletteCoverageWithSuggestions={multicolorPaletteCoverageWithSuggestions}
            multicolorPalettePixelCountMap={multicolorPalettePixelCountMap}
            multicolorPalettePreset={multicolorPalettePreset}
            originalComparisonCanvasRef={originalComparisonCanvasRef}
            paletteComparisonCanvasRef={paletteComparisonCanvasRef}
            palettePreviewModeLabel={palettePreviewModeLabel}
            setActivePaletteColorId={setActivePaletteColorId}
            setIsActivePaletteColorOnlyEnabled={setIsActivePaletteColorOnlyEnabled}
            setIsMulticolorLabEnabled={setIsMulticolorLabEnabled}
            setIsPaletteDitheringEnabled={setIsPaletteDitheringEnabled}
            setIsPalettePreviewEnabled={setIsPalettePreviewEnabled}
            setMaskBlurRadius={setMaskBlurRadius}
            setMulticolorDebugView={setMulticolorDebugView}
            setMulticolorPaletteColors={setMulticolorPaletteColors}
            setMulticolorPalettePresetId={setMulticolorPalettePresetId}
            shouldShowPaletteComparison={shouldShowPaletteComparison}
            totalAllocatedSuggestedLines={totalAllocatedSuggestedLines}
            totalPaletteCoverageTenths={totalPaletteCoverageTenths}
            totalSuggestedMulticolorLines={totalSuggestedMulticolorLines}
          />
        </div>

      </aside>

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
      <HoveredPixelOverlay
        hoveredPixel={hoveredPixel}
        isArtMode={isArtMode}
        isBlackAndWhite={isBlackAndWhite}
        isBrushMode={isBrushMode}
      />
    </div>
  );
}

export default App;
