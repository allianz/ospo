const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Turns "<N> <unit>" (optionally followed by "ago") into the date that long before `now`.
 * Units: minute(s), day(s), month(s), year(s). Calculation is in UTC.
 */
export function parseRelativeDate(str, now = new Date()) {
  const match = String(str).match(/^(\d+)\s+(minutes?|days?|months?|years?)(\s+ago)?$/);
  if (!match) {
    throw new Error(`Invalid relative date: "${str}". Expected format: "<N> <unit>" (e.g. "2 years")`);
  }
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const date = new Date(now.getTime());
  if (unit.startsWith('minute')) date.setUTCMinutes(date.getUTCMinutes() - n);
  else if (unit.startsWith('day')) date.setUTCDate(date.getUTCDate() - n);
  else if (unit.startsWith('month')) date.setUTCMonth(date.getUTCMonth() - n);
  else date.setUTCFullYear(date.getUTCFullYear() - n);
  return date;
}

/** Whole days from `from` until `to`, rounded up. */
export function daysUntil(from, to) {
  return Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY);
}
