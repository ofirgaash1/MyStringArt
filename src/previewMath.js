export function getPreviewFramePoint(previewElement, previewSize, clientX, clientY) {
  const previewRect = previewElement?.getBoundingClientRect();
  if (!previewElement || !previewRect || previewSize <= 0) {
    return null;
  }

  const offsetWidth = previewElement.offsetWidth;
  const offsetHeight = previewElement.offsetHeight;
  const clientWidth = previewElement.clientWidth;
  const clientHeight = previewElement.clientHeight;
  if (offsetWidth <= 0 || offsetHeight <= 0 || clientWidth <= 0 || clientHeight <= 0) {
    return null;
  }

  const scaleX = previewRect.width / offsetWidth;
  const scaleY = previewRect.height / offsetHeight;
  const contentRect = {
    left: previewRect.left + previewElement.clientLeft * scaleX,
    top: previewRect.top + previewElement.clientTop * scaleY,
    width: clientWidth * scaleX,
    height: clientHeight * scaleY,
  };

  return {
    previewRect,
    contentRect,
    x: ((clientX - contentRect.left) / contentRect.width) * previewSize,
    y: ((clientY - contentRect.top) / contentRect.height) * previewSize,
  };
}

export function isPreviewPointInsideCircle(previewPoint, previewSize) {
  if (!previewPoint) {
    return false;
  }

  const centerX = previewSize / 2;
  const centerY = previewSize / 2;
  const radius = previewSize / 2;
  return (
    Math.hypot(previewPoint.x - centerX, previewPoint.y - centerY) <= radius
  );
}

export function getImagePointFromPreviewPoint(
  previewPoint,
  imageSize,
  imageScale,
  imageCenter,
  previewSize,
) {
  if (!previewPoint || !imageSize || imageScale <= 0) {
    return null;
  }

  const imageX =
    imageCenter.x + (previewPoint.x - previewSize / 2) / imageScale;
  const imageY =
    imageCenter.y + (previewPoint.y - previewSize / 2) / imageScale;

  if (
    imageX < 0 ||
    imageY < 0 ||
    imageX >= imageSize.width ||
    imageY >= imageSize.height
  ) {
    return null;
  }

  return {
    contentRect: previewPoint.contentRect,
    imageX,
    imageY,
    pixelColumn: Math.floor(imageX),
    pixelRow: Math.floor(imageY),
  };
}

export function getPreviewCoordinatesForPixel(
  pixelX,
  pixelY,
  imageSize,
  previewSize,
  imageCenter,
  imageScale,
) {
  if (!imageSize || previewSize <= 0) {
    return null;
  }

  return {
    x: previewSize / 2 + ((pixelX + 0.5) - imageCenter.x) * imageScale,
    y: previewSize / 2 + ((pixelY + 0.5) - imageCenter.y) * imageScale,
  };
}

export function getDraggedPreviewOffset(startOffset, pointerStart, clientX, clientY) {
  return {
    x: startOffset.x + clientX - pointerStart.x,
    y: startOffset.y + clientY - pointerStart.y,
  };
}

export function getDraggedImageCenter(
  startCenter,
  pointerStart,
  clientX,
  clientY,
  previewScale,
  imageScale,
) {
  return {
    x:
      startCenter.x -
      (clientX - pointerStart.x) /
        ((previewScale / 100) * imageScale),
    y:
      startCenter.y -
      (clientY - pointerStart.y) /
        ((previewScale / 100) * imageScale),
  };
}

export function getZoomFactor(deltaY) {
  return Math.exp(-deltaY * 0.0015);
}

export function getZoomedPreviewState(
  currentPreviewScale,
  previewOffset,
  clientX,
  clientY,
  previewRect,
  zoomFactor,
  minPreviewScale,
) {
  const nextPreviewScale = Math.max(
    Math.round(currentPreviewScale * zoomFactor),
    minPreviewScale,
  );
  const previewRatio = nextPreviewScale / currentPreviewScale;
  const previewCenterX = previewRect.left + previewRect.width / 2;
  const previewCenterY = previewRect.top + previewRect.height / 2;

  return {
    previewOffset: {
      x:
        previewOffset.x +
        (1 - previewRatio) * (clientX - previewCenterX),
      y:
        previewOffset.y +
        (1 - previewRatio) * (clientY - previewCenterY),
    },
    previewScale: nextPreviewScale,
  };
}

export function getZoomedImageState(
  currentImageScale,
  currentImageCenter,
  previewPoint,
  previewSize,
  zoomFactor,
  minScale,
  maxScale,
  clamp,
) {
  const nextImageScale = clamp(currentImageScale * zoomFactor, minScale, maxScale);
  const anchorImageX =
    currentImageCenter.x + (previewPoint.x - previewSize / 2) / currentImageScale;
  const anchorImageY =
    currentImageCenter.y + (previewPoint.y - previewSize / 2) / currentImageScale;

  return {
    imageCenter: {
      x: anchorImageX - (previewPoint.x - previewSize / 2) / nextImageScale,
      y: anchorImageY - (previewPoint.y - previewSize / 2) / nextImageScale,
    },
    imageScale: nextImageScale,
  };
}

export function buildNails(nailsCount, inversePreviewScale) {
  const nailRadius = 0.8 * inversePreviewScale;
  const nailOrbitRadius = 50 - nailRadius;
  const nailLabelRadius = 50 + 2.6 * inversePreviewScale;
  const nailFontSize = 2.2 * inversePreviewScale;

  return {
    nailFontSize,
    nailRadius,
    nails: Array.from({ length: nailsCount }, (_, index) => {
      const angle = (index / nailsCount) * Math.PI * 2 - Math.PI / 2;

      return {
        key: `nail-${index}`,
        cx: 50 + Math.cos(angle) * nailOrbitRadius,
        cy: 50 + Math.sin(angle) * nailOrbitRadius,
        labelX: 50 + Math.cos(angle) * nailLabelRadius,
        labelY: 50 + Math.sin(angle) * nailLabelRadius,
        number: index + 1,
      };
    }),
  };
}

export function buildArtLineSegments(savedNailSequence, nails) {
  return savedNailSequence.reduce((segments, nailNumber, index) => {
    const startNailNumber = index === 0 ? 1 : savedNailSequence[index - 1];
    const startNail = nails[startNailNumber - 1];
    const endNail = nails[nailNumber - 1];

    if (startNail && endNail) {
      segments.push({
        key: `art-line-${index}-${startNailNumber}-${nailNumber}`,
        x1: startNail.cx,
        y1: startNail.cy,
        x2: endNail.cx,
        y2: endNail.cy,
      });
    }

    return segments;
  }, []);
}

export function buildManualArtLineSegments(lines, nails, keyPrefix = 'manual-art-line') {
  return lines.reduce((segments, line, index) => {
    const startNail = nails[line.startNailNumber - 1];
    const endNail = nails[line.endNailNumber - 1];

    if (startNail && endNail) {
      segments.push({
        key: `${keyPrefix}-${index}-${line.startNailNumber}-${line.endNailNumber}`,
        x1: startNail.cx,
        y1: startNail.cy,
        x2: endNail.cx,
        y2: endNail.cy,
        stroke: line.stroke ?? null,
      });
    }

    return segments;
  }, []);
}
