export const MULTICOLOR_DEBUG_VIEWS = [
  { id: 'original', label: 'original' },
  { id: 'current-grayscale', label: 'current grayscale' },
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

  for (const color of paletteColors) {
    if (!color.rgb) {
      continue;
    }

    const distance =
      (red - color.rgb.r) * (red - color.rgb.r) +
      (green - color.rgb.g) * (green - color.rgb.g) +
      (blue - color.rgb.b) * (blue - color.rgb.b);

    if (distance < minimumDistance) {
      minimumDistance = distance;
      closestColor = color;
    }
  }

  return closestColor;
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
      const nearestColor = getNearestPaletteMatch(
        workingData[offset],
        workingData[offset + 1],
        workingData[offset + 2],
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

      const redError = workingData[offset] - nearestColor.rgb.r;
      const greenError = workingData[offset + 1] - nearestColor.rgb.g;
      const blueError = workingData[offset + 2] - nearestColor.rgb.b;

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
  const activeColor = paletteColors.find((color) => color.id === activeColorId);
  if (!quantizedImageData || !activeColor?.rgb) {
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

export function drawImageDataToCanvas(canvas, imageData) {
  if (!canvas || !imageData) {
    return;
  }

  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext('2d');
  context?.putImageData(imageData, 0, 0);
}
