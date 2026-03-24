export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function getCircularNailDistance(firstNail, secondNail, totalNails) {
  if (totalNails <= 0) {
    return 0;
  }

  const directDistance = Math.abs(firstNail - secondNail);
  return Math.min(directDistance, totalNails - directDistance);
}

export function rasterizeLinePixels(startX, startY, endX, endY, width, height) {
  const pixels = [];
  const x0 = Math.round(startX);
  const y0 = Math.round(startY);
  const x1 = Math.round(endX);
  const y1 = Math.round(endY);
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx - dy;
  let x = x0;
  let y = y0;

  while (true) {
    if (x >= 0 && x < width && y >= 0 && y < height) {
      pixels.push({ key: `${x}-${y}`, x, y });
    }

    if (x === x1 && y === y1) {
      break;
    }

    const doubledError = error * 2;
    if (doubledError > -dy) {
      error -= dy;
      x += sx;
    }
    if (doubledError < dx) {
      error += dx;
      y += sy;
    }
  }

  return pixels;
}

export function getPixelDarkness(imageData, width, x, y) {
  const index = (y * width + x) * 4;
  return (
    (imageData[index] + imageData[index + 1] + imageData[index + 2]) / 3
  );
}

export function getLinearPixelIndex(width, x, y) {
  return y * width + x;
}

export function createPixelGroup(groupNumber, groupColors) {
  return {
    id: `group-${groupNumber}`,
    groupNumber,
    name: `group${groupNumber}`,
    value: 0,
    pixelCount: 0,
    color: groupColors[(groupNumber - 1) % groupColors.length],
  };
}

export function getNormalizedLineKey(firstNail, secondNail) {
  if (!Number.isInteger(firstNail) || !Number.isInteger(secondNail)) {
    return null;
  }

  const start = Math.min(firstNail, secondNail);
  const end = Math.max(firstNail, secondNail);
  return `${start}-${end}`;
}

export function writeProcessedImageData(
  context,
  sourceImageData,
  width,
  height,
  contrastPercent,
  lineBoostMap,
  minContrast,
  maxContrast,
  defaultContrast,
) {
  const nextImage = context.createImageData(width, height);
  const sourceData = sourceImageData.data;
  const nextData = nextImage.data;
  const contrastFactor = clamp(
    Number.isFinite(contrastPercent) ? contrastPercent : defaultContrast,
    minContrast,
    maxContrast,
  ) / 100;

  for (let pixelIndex = 0, offset = 0; offset < sourceData.length; offset += 4, pixelIndex += 1) {
    const lineBoost = lineBoostMap?.[pixelIndex] ?? 0;
    nextData[offset] = clamp(
      Math.round((sourceData[offset] - 128) * contrastFactor + 128) + lineBoost,
      0,
      255,
    );
    nextData[offset + 1] = clamp(
      Math.round((sourceData[offset + 1] - 128) * contrastFactor + 128) + lineBoost,
      0,
      255,
    );
    nextData[offset + 2] = clamp(
      Math.round((sourceData[offset + 2] - 128) * contrastFactor + 128) + lineBoost,
      0,
      255,
    );
    nextData[offset + 3] = sourceData[offset + 3];
  }

  context.putImageData(nextImage, 0, 0);
}
