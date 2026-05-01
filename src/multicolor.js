export const MULTICOLOR_DEBUG_VIEWS = [
  { id: 'original', label: 'original' },
  { id: 'current-grayscale', label: 'current grayscale' },
  { id: 'shared-residual', label: 'shared residual' },
  { id: 'palette-preview', label: 'palette preview' },
  { id: 'color-mask', label: 'color mask' },
];

export const MULTICOLOR_PALETTE_PRESETS = [
  {
    id: 'warmup-preset',
    name: 'Warmup preset',
    colors: [
      { id: 'warm-black', label: 'black', hex: '#111111', enabled: true },
      { id: 'warm-ivory', label: 'ivory', hex: '#f3ede2', enabled: true },
      { id: 'warm-coral', label: 'coral', hex: '#d96b4f', enabled: true },
      { id: 'warm-olive', label: 'olive', hex: '#76835d', enabled: true },
    ],
  },
  {
    id: 'cool-study-preset',
    name: 'Cool study preset',
    colors: [
      { id: 'cool-midnight', label: 'midnight', hex: '#102a43', enabled: true },
      { id: 'cool-mist', label: 'mist', hex: '#d9e2ec', enabled: true },
      { id: 'cool-teal', label: 'teal', hex: '#2a9d8f', enabled: true },
      { id: 'cool-gold', label: 'gold', hex: '#e9c46a', enabled: true },
    ],
  },
];

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampColorValue(value) {
  return Math.max(0, Math.min(255, value));
}

function srgbChannelToLinear(value) {
  const normalizedValue = clampColorValue(value) / 255;
  return normalizedValue <= 0.04045
    ? normalizedValue / 12.92
    : ((normalizedValue + 0.055) / 1.055) ** 2.4;
}

function linearChannelToSrgb(value) {
  const clampedValue = Math.max(0, Math.min(1, value));
  const normalizedValue = clampedValue <= 0.0031308
    ? 12.92 * clampedValue
    : 1.055 * (clampedValue ** (1 / 2.4)) - 0.055;
  return clampByte(normalizedValue * 255);
}

export function rgbToOklab(red, green, blue) {
  const linearRed = srgbChannelToLinear(red);
  const linearGreen = srgbChannelToLinear(green);
  const linearBlue = srgbChannelToLinear(blue);

  const l = 0.4122214708 * linearRed + 0.5363325363 * linearGreen + 0.0514459929 * linearBlue;
  const m = 0.2119034982 * linearRed + 0.6806995451 * linearGreen + 0.1073969566 * linearBlue;
  const s = 0.0883024619 * linearRed + 0.2817188376 * linearGreen + 0.6299787005 * linearBlue;

  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);

  return {
    l: 0.2104542553 * lRoot + 0.7936177850 * mRoot - 0.0040720468 * sRoot,
    a: 1.9779984951 * lRoot - 2.4285922050 * mRoot + 0.4505937099 * sRoot,
    b: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.8086757660 * sRoot,
  };
}

export function oklabToRgb(lab) {
  const lRoot = lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const mRoot = lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const sRoot = lab.l - 0.0894841775 * lab.a - 1.2914855480 * lab.b;

  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;

  return {
    r: linearChannelToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearChannelToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearChannelToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  };
}

export function rgbToHex(red, green, blue) {
  return `#${[red, green, blue]
    .map((value) => clampByte(value).toString(16).padStart(2, '0'))
    .join('')}`;
}

function getPaletteColorOklab(color) {
  if (color.oklab) {
    return color.oklab;
  }

  return color.rgb
    ? rgbToOklab(color.rgb.r, color.rgb.g, color.rgb.b)
    : null;
}

export function hexToRgb(hex) {
  const normalizedHex = hex.replace('#', '');
  if (normalizedHex.length !== 6) {
    return null;
  }

  const red = Number.parseInt(normalizedHex.slice(0, 2), 16);
  const green = Number.parseInt(normalizedHex.slice(2, 4), 16);
  const blue = Number.parseInt(normalizedHex.slice(4, 6), 16);
  if ([red, green, blue].some((value) => Number.isNaN(value))) {
    return null;
  }

  return { r: red, g: green, b: blue };
}

export function clonePalettePreset(preset) {
  return {
    ...preset,
    colors: preset.colors.map((color) => ({ ...color })),
  };
}

export function getNearestPaletteMatch(red, green, blue, paletteColors) {
  let closestColor = null;
  let minimumDistance = Infinity;
  const sourceOklab = rgbToOklab(red, green, blue);

  for (const color of paletteColors) {
    if (!color.rgb) {
      continue;
    }

    const colorOklab = getPaletteColorOklab(color);
    if (!colorOklab) {
      continue;
    }

    const distance =
      (sourceOklab.l - colorOklab.l) * (sourceOklab.l - colorOklab.l) +
      (sourceOklab.a - colorOklab.a) * (sourceOklab.a - colorOklab.a) +
      (sourceOklab.b - colorOklab.b) * (sourceOklab.b - colorOklab.b);

    if (distance < minimumDistance) {
      minimumDistance = distance;
      closestColor = color;
    }
  }

  return closestColor;
}

export function findBestFitPaletteColors(
  sourceImageData,
  colorCount,
  imageCenter,
  imageScale,
  previewSize,
) {
  if (!sourceImageData) {
    return [];
  }

  const safeColorCount = Math.max(1, Math.min(16, Math.round(colorCount) || 1));
  const { width, height, data } = sourceImageData;
  const candidatePixels = [];
  const maximumSamples = 12000;
  const pixelCount = width * height;
  const stride = Math.max(1, Math.floor(pixelCount / maximumSamples));

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += stride) {
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (
      previewSize > 0 &&
      !isImagePixelInsidePreviewCircle(x, y, imageCenter, imageScale, previewSize)
    ) {
      continue;
    }

    const offset = pixelIndex * 4;
    if (data[offset + 3] <= 0) {
      continue;
    }

    candidatePixels.push({
      rgb: {
        r: data[offset],
        g: data[offset + 1],
        b: data[offset + 2],
      },
      oklab: rgbToOklab(data[offset], data[offset + 1], data[offset + 2]),
    });
  }

  if (candidatePixels.length === 0) {
    return [];
  }

  const centers = [];
  const sortedByLightness = [...candidatePixels].sort((firstPixel, secondPixel) =>
    firstPixel.oklab.l - secondPixel.oklab.l,
  );
  for (let index = 0; index < safeColorCount; index += 1) {
    const sortedIndex =
      safeColorCount === 1
        ? Math.floor(sortedByLightness.length / 2)
        : Math.round((index / (safeColorCount - 1)) * (sortedByLightness.length - 1));
    centers.push({ ...sortedByLightness[sortedIndex].oklab });
  }

  for (let iteration = 0; iteration < 14; iteration += 1) {
    const groups = centers.map(() => ({
      l: 0,
      a: 0,
      b: 0,
      count: 0,
    }));

    for (const pixel of candidatePixels) {
      let nearestCenterIndex = 0;
      let minimumDistance = Infinity;
      for (let centerIndex = 0; centerIndex < centers.length; centerIndex += 1) {
        const center = centers[centerIndex];
        const distance =
          (pixel.oklab.l - center.l) * (pixel.oklab.l - center.l) +
          (pixel.oklab.a - center.a) * (pixel.oklab.a - center.a) +
          (pixel.oklab.b - center.b) * (pixel.oklab.b - center.b);
        if (distance < minimumDistance) {
          minimumDistance = distance;
          nearestCenterIndex = centerIndex;
        }
      }

      const group = groups[nearestCenterIndex];
      group.l += pixel.oklab.l;
      group.a += pixel.oklab.a;
      group.b += pixel.oklab.b;
      group.count += 1;
    }

    for (let centerIndex = 0; centerIndex < centers.length; centerIndex += 1) {
      const group = groups[centerIndex];
      if (group.count === 0) {
        continue;
      }

      centers[centerIndex] = {
        l: group.l / group.count,
        a: group.a / group.count,
        b: group.b / group.count,
      };
    }
  }

  return centers
    .map((center, index) => {
      const rgb = oklabToRgb(center);
      return {
        id: `found-color-${index + 1}`,
        label: `found ${index + 1}`,
        hex: rgbToHex(rgb.r, rgb.g, rgb.b),
        enabled: true,
      };
    })
    .sort((firstColor, secondColor) => {
      const firstRgb = hexToRgb(firstColor.hex);
      const secondRgb = hexToRgb(secondColor.hex);
      return (
        rgbToOklab(firstRgb.r, firstRgb.g, firstRgb.b).l -
        rgbToOklab(secondRgb.r, secondRgb.g, secondRgb.b).l
      );
    })
    .map((color, index) => ({
      ...color,
      id: `found-color-${index + 1}`,
      label: `found ${index + 1}`,
    }));
}

export function createNearestPalettePreviewImageData(
  sourceImageData,
  paletteColors,
  activeColorId = null,
  isolateActiveColorOnly = false,
) {
  if (!sourceImageData || paletteColors.length === 0) {
    return null;
  }

  const nextData = new Uint8ClampedArray(sourceImageData.data);
  for (let offset = 0; offset < nextData.length; offset += 4) {
    const nearestColor = getNearestPaletteMatch(
      nextData[offset],
      nextData[offset + 1],
      nextData[offset + 2],
      paletteColors,
    );
    if (!nearestColor) {
      continue;
    }

    if (isolateActiveColorOnly && nearestColor.id !== activeColorId) {
      nextData[offset + 3] = 0;
      continue;
    }

    nextData[offset] = nearestColor.rgb.r;
    nextData[offset + 1] = nearestColor.rgb.g;
    nextData[offset + 2] = nearestColor.rgb.b;
  }

  return new ImageData(nextData, sourceImageData.width, sourceImageData.height);
}

export function createDitheredPalettePreviewImageData(
  sourceImageData,
  paletteColors,
  activeColorId = null,
  isolateActiveColorOnly = false,
) {
  if (!sourceImageData || paletteColors.length === 0) {
    return null;
  }

  const { width, height } = sourceImageData;
  const sourceData = sourceImageData.data;
  const workingData = new Float32Array(sourceData.length);
  const nextData = new Uint8ClampedArray(sourceData);
  for (let index = 0; index < sourceData.length; index += 1) {
    workingData[index] = sourceData[index];
  }

  const diffuseError = (targetOffset, redError, greenError, blueError, factor) => {
    if (targetOffset < 0 || targetOffset >= workingData.length) {
      return;
    }

    workingData[targetOffset] += redError * factor;
    workingData[targetOffset + 1] += greenError * factor;
    workingData[targetOffset + 2] += blueError * factor;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const sourceRed = clampColorValue(workingData[offset]);
      const sourceGreen = clampColorValue(workingData[offset + 1]);
      const sourceBlue = clampColorValue(workingData[offset + 2]);
      const nearestColor = getNearestPaletteMatch(
        sourceRed,
        sourceGreen,
        sourceBlue,
        paletteColors,
      );
      if (!nearestColor) {
        continue;
      }

      nextData[offset] = nearestColor.rgb.r;
      nextData[offset + 1] = nearestColor.rgb.g;
      nextData[offset + 2] = nearestColor.rgb.b;
      if (isolateActiveColorOnly && nearestColor.id !== activeColorId) {
        nextData[offset + 3] = 0;
      }

      const redError = sourceRed - nearestColor.rgb.r;
      const greenError = sourceGreen - nearestColor.rgb.g;
      const blueError = sourceBlue - nearestColor.rgb.b;

      if (x + 1 < width) {
        diffuseError(offset + 4, redError, greenError, blueError, 7 / 16);
      }
      if (y + 1 < height) {
        const nextRowOffset = offset + width * 4;
        diffuseError(nextRowOffset, redError, greenError, blueError, 5 / 16);
        if (x > 0) {
          diffuseError(nextRowOffset - 4, redError, greenError, blueError, 3 / 16);
        }
        if (x + 1 < width) {
          diffuseError(nextRowOffset + 4, redError, greenError, blueError, 1 / 16);
        }
      }
    }
  }

  return new ImageData(nextData, width, height);
}

export function createPalettePreviewImageData(
  sourceImageData,
  paletteColors,
  useFloydSteinbergDithering = false,
  activeColorId = null,
  isolateActiveColorOnly = false,
) {
  return useFloydSteinbergDithering
    ? createDitheredPalettePreviewImageData(
        sourceImageData,
        paletteColors,
        activeColorId,
        isolateActiveColorOnly,
      )
    : createNearestPalettePreviewImageData(
        sourceImageData,
        paletteColors,
        activeColorId,
        isolateActiveColorOnly,
      );
}

function createPaletteMaskImageDataFromQuantizedImageData(
  quantizedImageData,
  paletteColors,
  activeColorId = null,
) {
  if (!quantizedImageData || paletteColors.length === 0 || !activeColorId) {
    return null;
  }

  const activeColor = paletteColors.find((color) => color.id === activeColorId);
  if (!activeColor?.rgb) {
    return null;
  }

  const nextData = new Uint8ClampedArray(quantizedImageData.data.length);
  for (let offset = 0; offset < quantizedImageData.data.length; offset += 4) {
    const isActiveMatch =
      quantizedImageData.data[offset] === activeColor.rgb.r &&
      quantizedImageData.data[offset + 1] === activeColor.rgb.g &&
      quantizedImageData.data[offset + 2] === activeColor.rgb.b &&
      quantizedImageData.data[offset + 3] > 0;
    const value = isActiveMatch ? 0 : 255;
    nextData[offset] = value;
    nextData[offset + 1] = value;
    nextData[offset + 2] = value;
    nextData[offset + 3] = 255;
  }

  return new ImageData(nextData, quantizedImageData.width, quantizedImageData.height);
}

function buildRectanglePolygon(x1, y1, x2, y2) {
  return [[
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
    [x1, y1],
  ]];
}

function buildRectangleKey(x1, x2) {
  return `${x1}:${x2}`;
}

export function createPaletteMaskImageData(
  sourceImageData,
  paletteColors,
  useFloydSteinbergDithering = false,
  activeColorId = null,
) {
  if (!sourceImageData || paletteColors.length === 0 || !activeColorId) {
    return null;
  }

  const quantizedImageData = createPalettePreviewImageData(
    sourceImageData,
    paletteColors,
    useFloydSteinbergDithering,
    null,
    false,
  );
  return createPaletteMaskImageDataFromQuantizedImageData(
    quantizedImageData,
    paletteColors,
    activeColorId,
  );
}

export function createPaletteMaskImageCollection(
  sourceImageData,
  paletteColors,
  useFloydSteinbergDithering = false,
) {
  if (!sourceImageData || paletteColors.length === 0) {
    return [];
  }

  const quantizedImageData = createPalettePreviewImageData(
    sourceImageData,
    paletteColors,
    useFloydSteinbergDithering,
    null,
    false,
  );
  if (!quantizedImageData) {
    return [];
  }

  return paletteColors.map((color) => ({
    ...color,
    imageData: createPaletteMaskImageDataFromQuantizedImageData(
      quantizedImageData,
      paletteColors,
      color.id,
    ),
  }));
}

export function createPaletteRegionGeometries(
  sourceImageData,
  paletteColors,
  useFloydSteinbergDithering = false,
) {
  if (!sourceImageData || paletteColors.length === 0) {
    return [];
  }

  const quantizedImageData = createPalettePreviewImageData(
    sourceImageData,
    paletteColors,
    useFloydSteinbergDithering,
    null,
    false,
  );
  if (!quantizedImageData) {
    return [];
  }

  const paletteRgbEntries = paletteColors
    .map((color) => ({
      color,
      rgb: color.rgb ?? hexToRgb(color.hex),
    }))
    .filter((entry) => entry.rgb);
  const rgbToColorId = new Map(
    paletteRgbEntries.map((entry) => [
      `${entry.rgb.r}-${entry.rgb.g}-${entry.rgb.b}`,
      entry.color.id,
    ]),
  );
  const regionGeometriesByColorId = new Map(
    paletteColors.map((color) => [color.id, []]),
  );
  const activeRectanglesByColorId = new Map(
    paletteColors.map((color) => [color.id, new Map()]),
  );
  const { width, height, data } = quantizedImageData;

  for (let y = 0; y < height; y += 1) {
    const rowRunsByColorId = new Map();
    let runColorId = null;
    let runStartX = 0;

    for (let x = 0; x <= width; x += 1) {
      const isRowEnd = x === width;
      let currentColorId = null;
      if (!isRowEnd) {
        const offset = (y * width + x) * 4;
        currentColorId = rgbToColorId.get(
          `${data[offset]}-${data[offset + 1]}-${data[offset + 2]}`,
        ) ?? null;
      }

      if (currentColorId !== runColorId) {
        if (runColorId !== null) {
          const rowRuns = rowRunsByColorId.get(runColorId) ?? [];
          rowRuns.push({ x1: runStartX, x2: x });
          rowRunsByColorId.set(runColorId, rowRuns);
        }
        runColorId = currentColorId;
        runStartX = x;
      }
    }

    for (const color of paletteColors) {
      const colorId = color.id;
      const activeRectangles = activeRectanglesByColorId.get(colorId);
      const nextActiveRectangles = new Map();
      const rowRuns = rowRunsByColorId.get(colorId) ?? [];

      for (const rowRun of rowRuns) {
        const key = buildRectangleKey(rowRun.x1, rowRun.x2);
        const existingRectangle = activeRectangles.get(key);
        if (existingRectangle && existingRectangle.y2 === y) {
          nextActiveRectangles.set(key, {
            ...existingRectangle,
            y2: y + 1,
          });
        } else {
          nextActiveRectangles.set(key, {
            x1: rowRun.x1,
            x2: rowRun.x2,
            y1: y,
            y2: y + 1,
          });
        }
      }

      for (const [key, rectangle] of activeRectangles.entries()) {
        if (nextActiveRectangles.has(key)) {
          continue;
        }
        regionGeometriesByColorId.get(colorId).push(
          buildRectanglePolygon(rectangle.x1, rectangle.y1, rectangle.x2, rectangle.y2),
        );
      }

      activeRectanglesByColorId.set(colorId, nextActiveRectangles);
    }
  }

  for (const color of paletteColors) {
    const activeRectangles = activeRectanglesByColorId.get(color.id) ?? new Map();
    for (const rectangle of activeRectangles.values()) {
      regionGeometriesByColorId.get(color.id).push(
        buildRectanglePolygon(rectangle.x1, rectangle.y1, rectangle.x2, rectangle.y2),
      );
    }
  }

  return paletteColors.map((color) => ({
    ...color,
    geometry: regionGeometriesByColorId.get(color.id) ?? [],
  }));
}

export function blurMaskImageData(sourceImageData, radius = 0) {
  if (!sourceImageData || radius <= 0) {
    return sourceImageData;
  }

  const { width, height, data } = sourceImageData;
  const sourceValues = new Float32Array(width * height);
  for (let index = 0, offset = 0; index < sourceValues.length; index += 1, offset += 4) {
    sourceValues[index] = data[offset];
  }

  const horizontalBlur = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let count = 0;
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        const sampleX = x + offsetX;
        if (sampleX < 0 || sampleX >= width) {
          continue;
        }
        total += sourceValues[y * width + sampleX];
        count += 1;
      }
      horizontalBlur[y * width + x] = count > 0 ? total / count : sourceValues[y * width + x];
    }
  }

  const nextData = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let count = 0;
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        const sampleY = y + offsetY;
        if (sampleY < 0 || sampleY >= height) {
          continue;
        }
        total += horizontalBlur[sampleY * width + x];
        count += 1;
      }

      const blurredValue = Math.round(count > 0 ? total / count : horizontalBlur[y * width + x]);
      const pixelOffset = (y * width + x) * 4;
      nextData[pixelOffset] = blurredValue;
      nextData[pixelOffset + 1] = blurredValue;
      nextData[pixelOffset + 2] = blurredValue;
      nextData[pixelOffset + 3] = 255;
    }
  }

  return new ImageData(nextData, width, height);
}

export function isImagePixelInsidePreviewCircle(
  pixelX,
  pixelY,
  imageCenter,
  imageScale,
  previewSize,
) {
  if (
    !imageCenter ||
    !Number.isFinite(imageCenter.x) ||
    !Number.isFinite(imageCenter.y) ||
    !Number.isFinite(imageScale) ||
    imageScale <= 0 ||
    !Number.isFinite(previewSize) ||
    previewSize <= 0
  ) {
    return false;
  }

  const previewRadius = previewSize / 2;
  const previewX = previewRadius + ((pixelX + 0.5) - imageCenter.x) * imageScale;
  const previewY = previewRadius + ((pixelY + 0.5) - imageCenter.y) * imageScale;
  return Math.hypot(previewX - previewRadius, previewY - previewRadius) <= previewRadius;
}

export function countPixelsByNearestPaletteColor(
  sourceImageData,
  paletteColors,
  imageCenter,
  imageScale,
  previewSize,
) {
  if (!sourceImageData || paletteColors.length === 0) {
    return [];
  }

  const colorCounts = new Map(paletteColors.map((color) => [color.id, 0]));
  const { width, height, data } = sourceImageData;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isImagePixelInsidePreviewCircle(x, y, imageCenter, imageScale, previewSize)) {
        continue;
      }

      const offset = (y * width + x) * 4;
      const nearestColor = getNearestPaletteMatch(
        data[offset],
        data[offset + 1],
        data[offset + 2],
        paletteColors,
      );
      if (!nearestColor) {
        continue;
      }

      colorCounts.set(nearestColor.id, (colorCounts.get(nearestColor.id) ?? 0) + 1);
    }
  }

  return paletteColors.map((color) => ({
    ...color,
    pixelCount: colorCounts.get(color.id) ?? 0,
  }));
}

export function countPixelsByCurrentPaletteSource(
  sourceImageData,
  paletteColors,
  useFloydSteinbergDithering = false,
  imageCenter,
  imageScale,
  previewSize,
) {
  if (!sourceImageData || paletteColors.length === 0) {
    return [];
  }

  const quantizedImageData = createPalettePreviewImageData(
    sourceImageData,
    paletteColors,
    useFloydSteinbergDithering,
    null,
    false,
  );
  if (!quantizedImageData) {
    return [];
  }

  const colorCounts = new Map(paletteColors.map((color) => [color.id, 0]));
  const rgbToColorId = new Map(
    paletteColors
      .filter((color) => color.rgb)
      .map((color) => [`${color.rgb.r}-${color.rgb.g}-${color.rgb.b}`, color.id]),
  );

  let totalPixelCount = 0;
  for (let y = 0; y < quantizedImageData.height; y += 1) {
    for (let x = 0; x < quantizedImageData.width; x += 1) {
      if (!isImagePixelInsidePreviewCircle(x, y, imageCenter, imageScale, previewSize)) {
        continue;
      }

      totalPixelCount += 1;
      const offset = (y * quantizedImageData.width + x) * 4;
      const colorId = rgbToColorId.get(
        `${quantizedImageData.data[offset]}-${quantizedImageData.data[offset + 1]}-${quantizedImageData.data[offset + 2]}`,
      );
      if (!colorId) {
        continue;
      }

      colorCounts.set(colorId, (colorCounts.get(colorId) ?? 0) + 1);
    }
  }

  const totalTenths = 1000;
  const percentageAllocations = paletteColors
    .map((color) => {
      const pixelCount = colorCounts.get(color.id) ?? 0;
      const exactTenths = totalPixelCount > 0 ? (pixelCount / totalPixelCount) * totalTenths : 0;
      const roundedTenths = Math.floor(exactTenths);
      return {
        id: color.id,
        pixelCount,
        exactTenths,
        roundedTenths,
        remainder: exactTenths - roundedTenths,
      };
    })
    .sort((firstColor, secondColor) => {
      if (secondColor.remainder !== firstColor.remainder) {
        return secondColor.remainder - firstColor.remainder;
      }

      return secondColor.pixelCount - firstColor.pixelCount;
    });

  let tenthsRemaining =
    totalTenths -
    percentageAllocations.reduce((sum, color) => sum + color.roundedTenths, 0);
  for (const color of percentageAllocations) {
    if (tenthsRemaining <= 0) {
      break;
    }

    color.roundedTenths += 1;
    tenthsRemaining -= 1;
  }

  const percentageTenthsById = new Map(
    percentageAllocations.map((color) => [color.id, color.roundedTenths]),
  );

  return paletteColors.map((color) => {
    const pixelCount = colorCounts.get(color.id) ?? 0;
    const percentageTenths = percentageTenthsById.get(color.id) ?? 0;
    return {
      ...color,
      pixelCount,
      percentageTenths,
      percentage: percentageTenths / 10,
      percentageLabel: `${(percentageTenths / 10).toFixed(1)}%`,
    };
  });
}

export function allocateWholeUnitsByWeight(items, totalUnits, getWeight) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const safeTotalUnits = Math.max(
    0,
    Math.round(Number.isFinite(totalUnits) ? totalUnits : 0),
  );
  const weightedItems = items.map((item) => ({
    item,
    weight: Math.max(0, getWeight(item)),
  }));
  const totalWeight = weightedItems.reduce((sum, weightedItem) => sum + weightedItem.weight, 0);

  if (safeTotalUnits === 0 || totalWeight <= 0) {
    return items.map((item) => ({
      ...item,
      allocatedUnits: 0,
    }));
  }

  const allocations = weightedItems
    .map(({ item, weight }) => {
      const exactUnits = (weight / totalWeight) * safeTotalUnits;
      const allocatedUnits = Math.floor(exactUnits);
      return {
        id: item.id,
        weight,
        allocatedUnits,
        remainder: exactUnits - allocatedUnits,
      };
    })
    .sort((firstItem, secondItem) => {
      if (secondItem.remainder !== firstItem.remainder) {
        return secondItem.remainder - firstItem.remainder;
      }

      return secondItem.weight - firstItem.weight;
    });

  let unitsRemaining =
    safeTotalUnits -
    allocations.reduce((sum, allocation) => sum + allocation.allocatedUnits, 0);
  for (const allocation of allocations) {
    if (unitsRemaining <= 0) {
      break;
    }

    allocation.allocatedUnits += 1;
    unitsRemaining -= 1;
  }

  const allocatedUnitsById = new Map(
    allocations.map((allocation) => [allocation.id, allocation.allocatedUnits]),
  );

  return items.map((item) => ({
    ...item,
    allocatedUnits: allocatedUnitsById.get(item.id) ?? 0,
  }));
}

export function allocateWholeUnitsByWeightWithLock(
  items,
  totalUnits,
  getWeight,
  lockedAllocation = null,
) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const safeTotalUnits = Math.max(
    0,
    Math.round(Number.isFinite(totalUnits) ? totalUnits : 0),
  );
  const hasLockedAllocation =
    lockedAllocation &&
    items.some((item) => item.id === lockedAllocation.id) &&
    Number.isFinite(lockedAllocation.allocatedUnits);

  if (!hasLockedAllocation) {
    return allocateWholeUnitsByWeight(items, safeTotalUnits, getWeight).map((item) => ({
      ...item,
      isLocked: false,
    }));
  }

  const normalizedLockedUnits = Math.min(
    safeTotalUnits,
    Math.max(0, Math.round(lockedAllocation.allocatedUnits)),
  );
  const unlockedItems = items.filter((item) => item.id !== lockedAllocation.id);
  const remainingUnits = Math.max(0, safeTotalUnits - normalizedLockedUnits);
  const unlockedAllocations = allocateWholeUnitsByWeight(
    unlockedItems,
    remainingUnits,
    getWeight,
  );
  const allocatedUnitsById = new Map(
    unlockedAllocations.map((item) => [item.id, item.allocatedUnits]),
  );

  return items.map((item) => ({
    ...item,
    allocatedUnits:
      item.id === lockedAllocation.id
        ? normalizedLockedUnits
        : allocatedUnitsById.get(item.id) ?? 0,
    isLocked: item.id === lockedAllocation.id,
  }));
}

export function drawImageDataToCanvas(canvas, imageData) {
  if (!canvas) {
    return;
  }

  const context = canvas.getContext('2d');
  if (!imageData) {
    canvas.width = 1;
    canvas.height = 1;
    context?.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  canvas.width = imageData.width;
  canvas.height = imageData.height;
  context?.putImageData(imageData, 0, 0);
}
