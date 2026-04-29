export function getTasRegionAreaWeight(region) {
  if (!region) {
    return 0;
  }

  const minRadius = Number.isFinite(region.minRadius) ? Math.max(0, region.minRadius) : 0;
  const maxRadius = Number.isFinite(region.maxRadius) ? Math.max(0, region.maxRadius) : 0;
  return Math.max(0, (maxRadius * maxRadius) - (minRadius * minRadius));
}

function normalizeLimitPercent(limitPercent) {
  return Math.min(
    100,
    Math.max(0, Number.isFinite(limitPercent) ? limitPercent : 0),
  );
}

function getEnabledRegionEntries(regions, maxRegionIndex) {
  if (!Array.isArray(regions) || regions.length === 0 || maxRegionIndex < 0) {
    return [];
  }

  return regions
    .filter((region) => (
      Number.isInteger(region?.index) &&
      region.index <= maxRegionIndex &&
      region.chordCount > 0
    ))
    .map((region) => ({
      regionIndex: region.index,
      capacity: Math.max(0, Math.round(region.chordCount)),
      weight: getTasRegionAreaWeight(region),
    }))
    .filter((entry) => entry.capacity > 0);
}

function allocateCappedWeightedCounts(entries, budget) {
  const counts = new Map(entries.map((entry) => [entry.regionIndex, 0]));
  const totalCapacity = entries.reduce((sum, entry) => sum + entry.capacity, 0);
  let remainingBudget = Math.min(Math.max(0, Math.round(budget)), totalCapacity);
  let remainingEntries = entries.map((entry) => ({
    ...entry,
    weight: entry.weight > 0 ? entry.weight : entry.capacity,
  }));

  while (remainingBudget > 0 && remainingEntries.length > 0) {
    const totalWeight = remainingEntries.reduce((sum, entry) => sum + entry.weight, 0);
    if (totalWeight <= 0) {
      break;
    }

    const cappedEntries = remainingEntries.filter((entry) => (
      (remainingBudget * entry.weight) / totalWeight >= entry.capacity
    ));
    if (cappedEntries.length === 0) {
      break;
    }

    for (const entry of cappedEntries) {
      counts.set(entry.regionIndex, entry.capacity);
      remainingBudget -= entry.capacity;
    }
    const cappedRegionIndexes = new Set(cappedEntries.map((entry) => entry.regionIndex));
    remainingEntries = remainingEntries.filter(
      (entry) => !cappedRegionIndexes.has(entry.regionIndex),
    );
  }

  if (remainingBudget <= 0 || remainingEntries.length === 0) {
    return counts;
  }

  const totalWeight = remainingEntries.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) {
    return counts;
  }

  const allocations = remainingEntries.map((entry) => {
    const exactCount = (remainingBudget * entry.weight) / totalWeight;
    const baseCount = Math.min(entry.capacity, Math.floor(exactCount));
    return {
      ...entry,
      assignedCount: baseCount,
      remainder: exactCount - baseCount,
    };
  });

  let leftover = remainingBudget - allocations.reduce(
    (sum, allocation) => sum + allocation.assignedCount,
    0,
  );

  allocations
    .sort((first, second) => {
      if (second.remainder !== first.remainder) {
        return second.remainder - first.remainder;
      }
      if (second.weight !== first.weight) {
        return second.weight - first.weight;
      }
      return first.regionIndex - second.regionIndex;
    })
    .forEach((allocation) => {
      if (leftover <= 0 || allocation.assignedCount >= allocation.capacity) {
        return;
      }

      allocation.assignedCount += 1;
      leftover -= 1;
    });

  for (const allocation of allocations) {
    counts.set(allocation.regionIndex, allocation.assignedCount);
  }

  return counts;
}

export function getAreaWeightedTasRegionLimitCounts({
  regions,
  limitPercent,
  maxRegionIndex,
}) {
  const normalizedPercent = normalizeLimitPercent(limitPercent);
  const normalizedMaxRegionIndex = Math.max(
    -1,
    Math.round(Number.isFinite(maxRegionIndex) ? maxRegionIndex : -1),
  );
  const entries = getEnabledRegionEntries(regions, normalizedMaxRegionIndex);
  const counts = new Map(entries.map((entry) => [entry.regionIndex, 0]));

  if (entries.length === 0 || normalizedPercent <= 0) {
    return counts;
  }

  if (normalizedPercent >= 100) {
    for (const entry of entries) {
      counts.set(entry.regionIndex, entry.capacity);
    }
    return counts;
  }

  const totalCapacity = entries.reduce((sum, entry) => sum + entry.capacity, 0);
  const budget = Math.max(1, Math.round((totalCapacity * normalizedPercent) / 100));
  return allocateCappedWeightedCounts(entries, budget);
}
