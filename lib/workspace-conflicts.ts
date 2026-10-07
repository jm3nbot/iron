/** Compare only edited fields: independent edits on two devices can safely merge. */
export function conflictingFields(
  current: Record<string, unknown>,
  base: Record<string, unknown> | null,
  patch: Record<string, unknown>,
) {
  return Object.keys(patch).filter((key) => {
    if (JSON.stringify(current[key]) === JSON.stringify(patch[key])) return false;
    return !base || !(key in base) || JSON.stringify(current[key]) !== JSON.stringify(base[key]);
  });
}
