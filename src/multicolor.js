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

function channelToHex(value) {
  return Math.round(clampColorChannel(value)).toString(16).padStart(2, '0');
}

export function rgbToHex(red, green, blue) {
  return `#${channelToHex(red)}${channelToHex(green)}${channelToHex(blue)}`;
}

export function clonePalettePreset(preset) {
  return {
    ...preset,
    colors: preset.colors.map((color) => ({ ...color })),
  };
}

export const COLOR_ERROR_SPACE_LABEL = 'OKLab';

const OKLAB_ERROR_SCALE = 100000;
const paletteOklabCache = new WeakMap();

function clampColorChannel(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(255, Math.max(0, value));
}

function srgbByteToLinear(value) {
  const normalizedValue = clampColorChannel(value) / 255;
  if (normalizedValue <= 0.04045) {
    return normalizedValue / 12.92;
  }

  return ((normalizedValue + 0.055) / 1.055) ** 2.4;
}

export function rgbToOklab(red, green, blue) {
  const linearRed = srgbByteToLinear(red);
  const linearGreen = srgbByteToLinear(green);
  const linearBlue = srgbByteToLinear(blue);

  const long = Math.cbrt(
    0.4122214708 * linearRed +
      0.5363325363 * linearGreen +
      0.0514459929 * linearBlue,
  );
  const medium = Math.cbrt(
    0.2119034982 * linearRed +
      0.6806995451 * linearGreen +
      0.1073969566 * linearBlue,
  );
  const short = Math.cbrt(
    0.0883024619 * linearRed +
      0.2817188376 * linearGreen +
      0.6299787005 * linearBlue,
  );

  return {
    l: 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    a: 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    b: 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  };
}

function getPaletteColorOklab(color) {
  if (!color?.rgb) {
    return null;
  }

  const cacheKey = `${color.rgb.r}-${color.rgb.g}-${color.rgb.b}`;
  const cachedColor = paletteOklabCache.get(color);
  if (cachedColor?.cacheKey === cacheKey) {
    return cachedColor.oklab;
  }

  const oklab = rgbToOklab(color.rgb.r, color.rgb.g, color.rgb.b);
  paletteOklabCache.set(color, { cacheKey, oklab });
  return oklab;
}

export function getOklabColorError(red, green, blue, color) {
  return getOklabColorErrorFromOklab(rgbToOklab(red, green, blue), color);
}

function getOklabColorErrorFromOklab(sourceOklab, color) {
  const colorOklab = getPaletteColorOklab(color);
  if (!colorOklab) {
    return Infinity;
  }

  const lightnessDelta = sourceOklab.l - colorOklab.l;
  const greenRedDelta = sourceOklab.a - colorOklab.a;
  const blueYellowDelta = sourceOklab.b - colorOklab.b;
  return (
    (lightnessDelta * lightnessDelta +
      greenRedDelta * greenRedDelta +
      blueYellowDelta * blueYellowDelta) *
    OKLAB_ERROR_SCALE
  );
}

export function getNearestPaletteFit(red, green, blue, paletteColors) {
  let closestColor = null;
  let minimumDistance = Infinity;
  const sourceOklab = rgbToOklab(red, green, blue);

  for (const color of paletteColors) {
    if (!color.rgb) {
      continue;
    }

    const distance = getOklabColorErrorFromOklab(sourceOklab, color);

    if (distance < minimumDistance) {
      minimumDistance = distance;
      closestColor = color;
    }
  }

  return closestColor
    ? {
        color: closestColor,
        error: minimumDistance,
      }
    : null;
}

export function getNearestPaletteMatch(red, green, blue, paletteColors) {
  return getNearestPaletteFit(red, green, blue, paletteColors)?.color ?? null;
}

export function getOklabDistanceSquared(firstOklab, secondOklab) {
  const lightnessDelta = firstOklab.l - secondOklab.l;
  const greenRedDelta = firstOklab.a - secondOklab.a;
  const blueYellowDelta = firstOklab.b - secondOklab.b;
  return (
    lightnessDelta * lightnessDelta +
    greenRedDelta * greenRedDelta +
    blueYellowDelta * blueYellowDelta
  );
}

function getNearestCentroidIndex(sample, centroids) {
  let nearestIndex = 0;
  let nearestDistance = Infinity;

  for (let index = 0; index < centroids.length; index += 1) {
    const distance = getOklabDistanceSquared(sample.oklab, centroids[index]);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  return nearestIndex;
}

function getInitialPaletteCentroids(samples, colorCount) {
  const sortedSamples = [...samples].sort((firstSample, secondSample) => {
    if (firstSample.oklab.l !== secondSample.oklab.l) {
      return firstSample.oklab.l - secondSample.oklab.l;
    }

    if (firstSample.oklab.a !== secondSample.oklab.a) {
      return firstSample.oklab.a - secondSample.oklab.a;
    }

    return firstSample.oklab.b - secondSample.oklab.b;
  });

  return Array.from({ length: colorCount }, (_, index) => {
    const sampleIndex = colorCount === 1
      ? Math.floor(sortedSamples.length / 2)
      : Math.round((index / (colorCount - 1)) * (sortedSamples.length - 1));
    return { ...sortedSamples[sampleIndex].oklab };
  });
}

export function createAutomaticPaletteColors({
  colorCount,
  imageCenter,
  imageScale,
  previewSize,
  sourceImageData,
}) {
  if (
    !sourceImageData ||
    !Number.isInteger(colorCount) ||
    colorCount <= 0
  ) {
    return [];
  }

  const clampedColorCount = Math.min(12, Math.max(2, colorCount));
  const maxSampleCount = 12000;
  const totalPixels = sourceImageData.width * sourceImageData.height;
  const stride = Math.max(1, Math.floor(Math.sqrt(totalPixels / maxSampleCount)));
  const samples = [];

  for (let y = 0; y < sourceImageData.height; y += stride) {
    for (let x = 0; x < sourceImageData.width; x += stride) {
      const offset = (y * sourceImageData.width + x) * 4;
      if (sourceImageData.data[offset + 3] <= 0) {
        continue;
      }

      if (
        !isImagePixelInsidePreviewCircle(
          x,
          y,
          imageCenter,
          imageScale,
          previewSize,
        )
      ) {
        continue;
      }

      const red = sourceImageData.data[offset];
      const green = sourceImageData.data[offset + 1];
      const blue = sourceImageData.data[offset + 2];
      samples.push({
        r: red,
        g: green,
        b: blue,
        oklab: rgbToOklab(red, green, blue),
      });
    }
  }

  if (samples.length === 0) {
    return [];
  }

  const effectiveColorCount = Math.min(clampedColorCount, samples.length);
  let centroids = getInitialPaletteCentroids(samples, effectiveColorCount);
  let assignments = new Int16Array(samples.length);

  for (let iteration = 0; iteration < 10; iteration += 1) {
    const nextCentroids = Array.from({ length: effectiveColorCount }, () => ({
      l: 0,
      a: 0,
      b: 0,
      count: 0,
    }));

    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
      const centroidIndex = getNearestCentroidIndex(samples[sampleIndex], centroids);
      assignments[sampleIndex] = centroidIndex;
      nextCentroids[centroidIndex].l += samples[sampleIndex].oklab.l;
      nextCentroids[centroidIndex].a += samples[sampleIndex].oklab.a;
      nextCentroids[centroidIndex].b += samples[sampleIndex].oklab.b;
      nextCentroids[centroidIndex].count += 1;
    }

    centroids = nextCentroids.map((centroid, index) => (
      centroid.count > 0
        ? {
            l: centroid.l / centroid.count,
            a: centroid.a / centroid.count,
            b: centroid.b / centroid.count,
          }
        : centroids[index]
    ));
  }

  const clusters = Array.from({ length: effectiveColorCount }, (_, index) => ({
    index,
    count: 0,
    redSum: 0,
    greenSum: 0,
    blueSum: 0,
    oklab: centroids[index],
  }));

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const cluster = clusters[assignments[sampleIndex]];
    if (!cluster) {
      continue;
    }

    cluster.count += 1;
    cluster.redSum += samples[sampleIndex].r;
    cluster.greenSum += samples[sampleIndex].g;
    cluster.blueSum += samples[sampleIndex].b;
  }

  return clusters
    .filter((cluster) => cluster.count > 0)
    .sort((firstCluster, secondCluster) => firstCluster.oklab.l - secondCluster.oklab.l)
    .map((cluster, index) => {
      const red = cluster.redSum / cluster.count;
      const green = cluster.greenSum / cluster.count;
      const blue = cluster.blueSum / cluster.count;
      const hex = rgbToHex(red, green, blue);
      return {
        id: `auto-${index + 1}-${hex.slice(1)}`,
        label: `auto ${index + 1}`,
        hex,
        rgb: hexToRgb(hex),
        enabled: true,
      };
    });
}

export function createNearestPalettePreviewImageData(
  sourceImageData,
  paletteColors,
  activeColorId = null,
  showActiveColorOnly = false,
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

    if (showActiveColorOnly && nearestColor.id !== activeColorId) {
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
  showActiveColorOnly = false,
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
    const isLeftToRight = y % 2 === 0;
    const startX = isLeftToRight ? 0 : width - 1;
    const endX = isLeftToRight ? width : -1;
    const xStep = isLeftToRight ? 1 : -1;

    for (let x = startX; x !== endX; x += xStep) {
      const offset = (y * width + x) * 4;
      const currentRed = clampColorChannel(workingData[offset]);
      const currentGreen = clampColorChannel(workingData[offset + 1]);
      const currentBlue = clampColorChannel(workingData[offset + 2]);
      const nearestColor = getNearestPaletteMatch(
        currentRed,
        currentGreen,
        currentBlue,
        paletteColors,
      );
      if (!nearestColor) {
        continue;
      }

      nextData[offset] = nearestColor.rgb.r;
      nextData[offset + 1] = nearestColor.rgb.g;
      nextData[offset + 2] = nearestColor.rgb.b;
      if (showActiveColorOnly && nearestColor.id !== activeColorId) {
        nextData[offset + 3] = 0;
      }

      const redError = currentRed - nearestColor.rgb.r;
      const greenError = currentGreen - nearestColor.rgb.g;
      const blueError = currentBlue - nearestColor.rgb.b;
      const forwardOffset = offset + xStep * 4;
      const nextRowOffset = offset + width * 4;
      const downForwardOffset = nextRowOffset + xStep * 4;
      const downBackwardOffset = nextRowOffset - xStep * 4;

      if ((isLeftToRight && x + 1 < width) || (!isLeftToRight && x > 0)) {
        diffuseError(forwardOffset, redError, greenError, blueError, 7 / 16);
      }

      if (y + 1 < height) {
        diffuseError(nextRowOffset, redError, greenError, blueError, 5 / 16);

        if ((isLeftToRight && x > 0) || (!isLeftToRight && x + 1 < width)) {
          diffuseError(downBackwardOffset, redError, greenError, blueError, 3 / 16);
        }

        if ((isLeftToRight && x + 1 < width) || (!isLeftToRight && x > 0)) {
          diffuseError(downForwardOffset, redError, greenError, blueError, 1 / 16);
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
  showActiveColorOnly = false,
) {
  return useFloydSteinbergDithering
    ? createDitheredPalettePreviewImageData(
        sourceImageData,
        paletteColors,
        activeColorId,
        showActiveColorOnly,
      )
    : createNearestPalettePreviewImageData(
        sourceImageData,
        paletteColors,
        activeColorId,
        showActiveColorOnly,
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
