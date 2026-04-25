export function getTasRegionCount(nailsCount) {
  if (!Number.isInteger(nailsCount) || nailsCount < 2) {
    return 0;
  }

  return Math.floor(nailsCount / 2);
}

export function getTasRegionIndex(firstNailNumber, secondNailNumber, nailsCount) {
  if (
    !Number.isInteger(firstNailNumber) ||
    !Number.isInteger(secondNailNumber) ||
    !Number.isInteger(nailsCount) ||
    nailsCount < 2 ||
    firstNailNumber === secondNailNumber
  ) {
    return null;
  }

  const directDistance = Math.abs(firstNailNumber - secondNailNumber);
  const circularDistance = Math.min(directDistance, nailsCount - directDistance);
  if (circularDistance <= 0) {
    return null;
  }

  return getTasRegionCount(nailsCount) - circularDistance;
}

function getProjectedPointOnSegment(point, segmentStart, segmentEnd) {
  const dx = segmentEnd.cx - segmentStart.cx;
  const dy = segmentEnd.cy - segmentStart.cy;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared <= 0) {
    return {
      x: segmentStart.cx,
      y: segmentStart.cy,
      t: 0,
    };
  }

  const t = (
    ((point.x - segmentStart.cx) * dx) +
    ((point.y - segmentStart.cy) * dy)
  ) / lengthSquared;

  return {
    x: segmentStart.cx + dx * t,
    y: segmentStart.cy + dy * t,
    t,
  };
}

export function buildTasChordNetwork(nails) {
  if (!Array.isArray(nails) || nails.length < 2) {
    return {
      chords: [],
      regions: [],
      regionCount: 0,
      totalChords: 0,
    };
  }

  const nailsCount = nails.length;
  const regionCount = getTasRegionCount(nailsCount);
  const center = { x: 50, y: 50 };
  const previewRadius = Math.hypot(nails[0].cx - center.x, nails[0].cy - center.y) || 50;
  const radiiByRegion = Array.from({ length: regionCount }, (_, regionIndex) => {
    const circularDistance = regionCount - regionIndex;
    return Math.abs(previewRadius * Math.cos((circularDistance * Math.PI) / nailsCount));
  });
  const regions = Array.from({ length: regionCount }, (_, regionIndex) => ({
    index: regionIndex,
    chordCount: 0,
    minRadius: regionIndex === 0 ? 0 : null,
    maxRadius: regionIndex === regionCount - 1 ? previewRadius : null,
  }));

  const chords = [];

  for (let firstIndex = 0; firstIndex < nailsCount - 1; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < nailsCount; secondIndex += 1) {
      const startNail = nails[firstIndex];
      const endNail = nails[secondIndex];
      const regionIndex = getTasRegionIndex(firstIndex + 1, secondIndex + 1, nailsCount);
      if (regionIndex === null || !regions[regionIndex]) {
        continue;
      }

      const projectedCenter = getProjectedPointOnSegment(center, startNail, endNail);
      const chordVectorX = endNail.cx - startNail.cx;
      const chordVectorY = endNail.cy - startNail.cy;
      const chordLength = Math.hypot(chordVectorX, chordVectorY);
      const halfChordLength = chordLength / 2;
      const tangentRadius = Math.hypot(projectedCenter.x - center.x, projectedCenter.y - center.y);
      const outerRadius =
        regionIndex + 1 < radiiByRegion.length
          ? radiiByRegion[regionIndex + 1]
          : previewRadius;
      const tasHalfLength = Math.min(
        halfChordLength,
        Math.sqrt(Math.max(0, outerRadius * outerRadius - tangentRadius * tangentRadius)),
      );
      const unitX = chordLength > 0 ? chordVectorX / chordLength : 0;
      const unitY = chordLength > 0 ? chordVectorY / chordLength : 0;
      const tasStart = {
        x: projectedCenter.x - unitX * tasHalfLength,
        y: projectedCenter.y - unitY * tasHalfLength,
      };
      const tasEnd = {
        x: projectedCenter.x + unitX * tasHalfLength,
        y: projectedCenter.y + unitY * tasHalfLength,
      };

      regions[regionIndex].chordCount += 1;
      chords.push({
        key: `${firstIndex + 1}-${secondIndex + 1}`,
        startNailNumber: firstIndex + 1,
        endNailNumber: secondIndex + 1,
        regionIndex,
        chordLength,
        tangentRadius,
        x1: startNail.cx,
        y1: startNail.cy,
        x2: endNail.cx,
        y2: endNail.cy,
        tasX1: tasStart.x,
        tasY1: tasStart.y,
        tasX2: tasEnd.x,
        tasY2: tasEnd.y,
      });
    }
  }

  for (let regionIndex = 0; regionIndex < regions.length; regionIndex += 1) {
    regions[regionIndex].minRadius = radiiByRegion[regionIndex] ?? 0;
    regions[regionIndex].maxRadius =
      regionIndex + 1 < radiiByRegion.length
        ? radiiByRegion[regionIndex + 1] ?? previewRadius
        : previewRadius;
  }

  return {
    chords,
    regions,
    regionCount,
    totalChords: chords.length,
  };
}

export function buildTasPreviewSegments(tasNetwork) {
  if (!tasNetwork) {
    return [];
  }

  return tasNetwork.chords
    .map((chord) => ({
      key: `tas-${chord.key}`,
      regionIndex: chord.regionIndex,
      x1: chord.tasX1,
      y1: chord.tasY1,
      x2: chord.tasX2,
      y2: chord.tasY2,
    }));
}

function getSquaredDistanceToSegment(pointX, pointY, segment) {
  const dx = segment.tasX2 - segment.tasX1;
  const dy = segment.tasY2 - segment.tasY1;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared <= 0) {
    const endpointDx = pointX - segment.tasX1;
    const endpointDy = pointY - segment.tasY1;
    return endpointDx * endpointDx + endpointDy * endpointDy;
  }

  const unclampedT = (
    ((pointX - segment.tasX1) * dx) +
    ((pointY - segment.tasY1) * dy)
  ) / lengthSquared;
  const t = Math.min(1, Math.max(0, unclampedT));
  const projectedX = segment.tasX1 + dx * t;
  const projectedY = segment.tasY1 + dy * t;
  const projectedDx = pointX - projectedX;
  const projectedDy = pointY - projectedY;
  return projectedDx * projectedDx + projectedDy * projectedDy;
}

function getOwnerColor(ownerIndex) {
  const hue = (ownerIndex * 137.508) % 360;
  const chroma = 0.58;
  const lightness = ownerIndex % 2 === 0 ? 0.48 : 0.62;
  const section = hue / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;

  if (section < 1) {
    red = chroma;
    green = x;
  } else if (section < 2) {
    red = x;
    green = chroma;
  } else if (section < 3) {
    green = chroma;
    blue = x;
  } else if (section < 4) {
    green = x;
    blue = chroma;
  } else if (section < 5) {
    red = x;
    blue = chroma;
  } else {
    red = chroma;
    blue = x;
  }

  const m = lightness - chroma / 2;
  return {
    r: Math.round((red + m) * 255),
    g: Math.round((green + m) * 255),
    b: Math.round((blue + m) * 255),
  };
}

function getRegionIndexForRadius(radius, regions) {
  if (!Array.isArray(regions) || regions.length === 0) {
    return null;
  }

  for (const region of regions) {
    if (radius >= region.minRadius && radius <= region.maxRadius) {
      return region.index;
    }
  }

  return radius < regions[0].minRadius ? 0 : regions.length - 1;
}

function buildChordsByRegion(tasNetwork) {
  const chordsByRegion = Array.from({ length: tasNetwork.regionCount }, () => []);
  for (const chord of tasNetwork.chords) {
    chordsByRegion[chord.regionIndex]?.push(chord);
  }
  return chordsByRegion;
}

function getCandidateChordsForRadius(radius, tasNetwork, chordsByRegion) {
  const baseRegionIndex = getRegionIndexForRadius(radius, tasNetwork.regions);
  if (baseRegionIndex === null) {
    return tasNetwork.chords;
  }

  const candidates = [];
  for (
    let regionIndex = Math.max(0, baseRegionIndex - 1);
    regionIndex <= Math.min(tasNetwork.regionCount - 1, baseRegionIndex + 1);
    regionIndex += 1
  ) {
    candidates.push(...(chordsByRegion[regionIndex] ?? []));
  }

  return candidates.length > 0 ? candidates : tasNetwork.chords;
}

function getTasPixelOwnerAssignments({
  imageSize,
  imageCenter,
  imageScale,
  previewSize,
  tasNetwork,
  ownerRegionIndex = null,
  onPixelAssigned,
}) {
  if (
    !imageSize ||
    !Number.isFinite(imageSize.width) ||
    !Number.isFinite(imageSize.height) ||
    imageSize.width <= 0 ||
    imageSize.height <= 0 ||
    !imageCenter ||
    !Number.isFinite(imageCenter.x) ||
    !Number.isFinite(imageCenter.y) ||
    !Number.isFinite(imageScale) ||
    imageScale <= 0 ||
    !Number.isFinite(previewSize) ||
    previewSize <= 0 ||
    !tasNetwork
  ) {
    return null;
  }

  const ownerChords = Number.isInteger(ownerRegionIndex)
    ? tasNetwork.chords.filter((chord) => chord.regionIndex === ownerRegionIndex)
    : tasNetwork.chords;
  if (ownerChords.length === 0 || tasNetwork.chords.length === 0) {
    return null;
  }

  const ownerIndexByChordKey = new Map(
    ownerChords.map((chord, index) => [chord.key, index]),
  );
  const ownerCounts = new Uint32Array(ownerChords.length);
  const previewRadius = previewSize / 2;
  const chordsByRegion = buildChordsByRegion(tasNetwork);
  let assignedPixelCount = 0;

  for (let y = 0; y < imageSize.height; y += 1) {
    for (let x = 0; x < imageSize.width; x += 1) {
      const previewX = previewRadius + ((x + 0.5) - imageCenter.x) * imageScale;
      const previewY = previewRadius + ((y + 0.5) - imageCenter.y) * imageScale;
      const normalizedX = (previewX / previewSize) * 100;
      const normalizedY = (previewY / previewSize) * 100;
      const normalizedDistanceFromCenter = Math.hypot(normalizedX - 50, normalizedY - 50);

      if (Math.hypot(previewX - previewRadius, previewY - previewRadius) > previewRadius) {
        continue;
      }

      const candidateChords = getCandidateChordsForRadius(
        normalizedDistanceFromCenter,
        tasNetwork,
        chordsByRegion,
      );
      let nearestChord = candidateChords[0];
      let nearestDistance = Infinity;
      for (let chordIndex = 0; chordIndex < candidateChords.length; chordIndex += 1) {
        const distance = getSquaredDistanceToSegment(
          normalizedX,
          normalizedY,
          candidateChords[chordIndex],
        );
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestChord = candidateChords[chordIndex];
        }
      }

      const ownerIndex = ownerIndexByChordKey.get(nearestChord.key);
      if (ownerIndex === undefined) {
        continue;
      }

      ownerCounts[ownerIndex] += 1;
      assignedPixelCount += 1;
      onPixelAssigned?.({
        x,
        y,
        ownerIndex,
        chord: nearestChord,
      });
    }
  }

  return {
    assignedPixelCount,
    ownerCounts,
    ownerChords,
    usedTasCount: ownerCounts.reduce(
      (count, ownerCount) => count + (ownerCount > 0 ? 1 : 0),
      0,
    ),
  };
}

export function buildTasPixelOwnershipPreview({
  imageSize,
  imageCenter,
  imageScale,
  previewSize,
  regionIndex,
  tasNetwork,
}) {
  const imageData = new ImageData(imageSize.width, imageSize.height);
  const assignments = getTasPixelOwnerAssignments({
    imageSize,
    imageCenter,
    imageScale,
    previewSize,
    tasNetwork,
    ownerRegionIndex: regionIndex,
  });

  if (!assignments) {
    return null;
  }

  const colorByChordIndex = assignments.ownerChords.map((_, index) => getOwnerColor(index));
  getTasPixelOwnerAssignments({
    imageSize,
    imageCenter,
    imageScale,
    previewSize,
    tasNetwork,
    ownerRegionIndex: regionIndex,
    onPixelAssigned: ({ x, y, ownerIndex }) => {
      const offset = (y * imageSize.width + x) * 4;
      const color = colorByChordIndex[ownerIndex];
      imageData.data[offset] = color.r;
      imageData.data[offset + 1] = color.g;
      imageData.data[offset + 2] = color.b;
      imageData.data[offset + 3] = 118;
    },
  });

  return {
    imageData,
    assignedPixelCount: assignments.assignedPixelCount,
    regionTasCount: assignments.ownerChords.length,
    usedTasCount: assignments.usedTasCount,
  };
}

function getNearestPaletteColor(red, green, blue, paletteColors) {
  let nearestColor = null;
  let nearestError = Infinity;

  for (const color of paletteColors) {
    if (!color.rgb) {
      continue;
    }

    const error =
      (red - color.rgb.r) * (red - color.rgb.r) +
      (green - color.rgb.g) * (green - color.rgb.g) +
      (blue - color.rgb.b) * (blue - color.rgb.b);
    if (error < nearestError) {
      nearestError = error;
      nearestColor = color;
    }
  }

  return nearestColor
    ? {
        color: nearestColor,
        error: nearestError,
      }
    : null;
}

export function buildTasRegionPaletteFit({
  sourceImageData,
  imageCenter,
  imageScale,
  previewSize,
  regionIndex,
  tasNetwork,
  paletteColors,
  limitToPalette = true,
}) {
  if (
    !sourceImageData ||
    (limitToPalette && (!Array.isArray(paletteColors) || paletteColors.length === 0))
  ) {
    return null;
  }

  const imageSize = {
    width: sourceImageData.width,
    height: sourceImageData.height,
  };
  const assignments = getTasPixelOwnerAssignments({
    imageSize,
    imageCenter,
    imageScale,
    previewSize,
    tasNetwork,
    ownerRegionIndex: regionIndex,
  });
  if (!assignments) {
    return null;
  }

  const redSums = new Float64Array(assignments.ownerChords.length);
  const greenSums = new Float64Array(assignments.ownerChords.length);
  const blueSums = new Float64Array(assignments.ownerChords.length);

  getTasPixelOwnerAssignments({
    imageSize,
    imageCenter,
    imageScale,
    previewSize,
    tasNetwork,
    ownerRegionIndex: regionIndex,
    onPixelAssigned: ({ x, y, ownerIndex }) => {
      const offset = (y * sourceImageData.width + x) * 4;
      redSums[ownerIndex] += sourceImageData.data[offset];
      greenSums[ownerIndex] += sourceImageData.data[offset + 1];
      blueSums[ownerIndex] += sourceImageData.data[offset + 2];
    },
  });

  let fittedTasCount = 0;
  let totalError = 0;
  const segments = [];

  for (let chordIndex = 0; chordIndex < assignments.ownerChords.length; chordIndex += 1) {
    const chord = assignments.ownerChords[chordIndex];
    const pixelCount = assignments.ownerCounts[chordIndex];
    if (pixelCount === 0) {
      continue;
    }

    const averageRed = redSums[chordIndex] / pixelCount;
    const averageGreen = greenSums[chordIndex] / pixelCount;
    const averageBlue = blueSums[chordIndex] / pixelCount;
    const nearest = limitToPalette
      ? getNearestPaletteColor(
          averageRed,
          averageGreen,
          averageBlue,
          paletteColors,
        )
      : null;
    const displayColor = limitToPalette
      ? nearest?.color?.hex ?? '#0f172a'
      : `rgb(${Math.round(averageRed)}, ${Math.round(averageGreen)}, ${Math.round(averageBlue)})`;
    const error = limitToPalette ? nearest?.error ?? null : null;
    if (limitToPalette && error !== null) {
      fittedTasCount += 1;
      totalError += error;
    } else if (!limitToPalette) {
      fittedTasCount += 1;
    }

    segments.push({
      key: `tas-fit-${chord.key}`,
      regionIndex: chord.regionIndex,
      x1: chord.tasX1,
      y1: chord.tasY1,
      x2: chord.tasX2,
      y2: chord.tasY2,
      stroke: displayColor,
      pixelCount,
      error,
    });
  }

  return {
    assignedPixelCount: assignments.assignedPixelCount,
    averageError: fittedTasCount > 0 ? totalError / fittedTasCount : null,
    fittedTasCount,
    regionTasCount: assignments.ownerChords.length,
    segments,
  };
}

export function buildAllTasRegionsPaletteFit({
  sourceImageData,
  imageCenter,
  imageScale,
  previewSize,
  tasNetwork,
  paletteColors,
  limitToPalette = true,
}) {
  if (!tasNetwork || tasNetwork.regionCount <= 0) {
    return null;
  }

  if (
    !sourceImageData ||
    (limitToPalette && (!Array.isArray(paletteColors) || paletteColors.length === 0))
  ) {
    return null;
  }

  const imageSize = {
    width: sourceImageData.width,
    height: sourceImageData.height,
  };
  const assignments = getTasPixelOwnerAssignments({
    imageSize,
    imageCenter,
    imageScale,
    previewSize,
    tasNetwork,
  });
  if (!assignments) {
    return null;
  }

  const redSums = new Float64Array(assignments.ownerChords.length);
  const greenSums = new Float64Array(assignments.ownerChords.length);
  const blueSums = new Float64Array(assignments.ownerChords.length);

  getTasPixelOwnerAssignments({
    imageSize,
    imageCenter,
    imageScale,
    previewSize,
    tasNetwork,
    onPixelAssigned: ({ x, y, ownerIndex }) => {
      const offset = (y * sourceImageData.width + x) * 4;
      redSums[ownerIndex] += sourceImageData.data[offset];
      greenSums[ownerIndex] += sourceImageData.data[offset + 1];
      blueSums[ownerIndex] += sourceImageData.data[offset + 2];
    },
  });

  let fittedTasCount = 0;
  let totalError = 0;
  const segments = [];

  for (let chordIndex = 0; chordIndex < assignments.ownerChords.length; chordIndex += 1) {
    const chord = assignments.ownerChords[chordIndex];
    const pixelCount = assignments.ownerCounts[chordIndex];
    if (pixelCount === 0) {
      continue;
    }

    const averageRed = redSums[chordIndex] / pixelCount;
    const averageGreen = greenSums[chordIndex] / pixelCount;
    const averageBlue = blueSums[chordIndex] / pixelCount;
    const nearest = limitToPalette
      ? getNearestPaletteColor(
          averageRed,
          averageGreen,
          averageBlue,
          paletteColors,
        )
      : null;
    const displayColor = limitToPalette
      ? nearest?.color?.hex ?? '#0f172a'
      : `rgb(${Math.round(averageRed)}, ${Math.round(averageGreen)}, ${Math.round(averageBlue)})`;
    const error = limitToPalette ? nearest?.error ?? null : null;
    if (limitToPalette && error !== null) {
      fittedTasCount += 1;
      totalError += error;
    } else if (!limitToPalette) {
      fittedTasCount += 1;
    }

    segments.push({
      key: `all-tas-fit-${chord.key}`,
      regionIndex: chord.regionIndex,
      x1: chord.tasX1,
      y1: chord.tasY1,
      x2: chord.tasX2,
      y2: chord.tasY2,
      stroke: displayColor,
      pixelCount,
      error,
    });
  }

  return {
    assignedPixelCount: assignments.assignedPixelCount,
    averageError: fittedTasCount > 0 ? totalError / fittedTasCount : null,
    fittedTasCount,
    regionFits: [],
    regionTasCount: assignments.ownerChords.length,
    segments,
  };
}
