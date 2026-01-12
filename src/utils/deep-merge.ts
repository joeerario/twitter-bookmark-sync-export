/**
 * Deep Merge Utility
 *
 * Recursively merges objects, preserving nested defaults.
 * Arrays are replaced (not merged element-by-element).
 */

/**
 * Check if a value is a plain object (not null, array, or other types)
 */
function isPlainObject(obj: unknown): obj is Record<string, unknown> {
  return obj !== null && typeof obj === 'object' && !Array.isArray(obj);
}

/**
 * Deep merge two objects.
 * - Plain objects are recursively merged
 * - Arrays and primitives from override replace base
 * - Explicit null in override replaces base value
 */
export function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result = { ...base };

  for (const key of Object.keys(override) as (keyof T)[]) {
    const overrideValue = override[key];
    const baseValue = base[key];

    // Explicit null should replace the base value
    if (overrideValue === null) {
      (result as Record<string, unknown>)[key as string] = null;
    } else if (isPlainObject(overrideValue) && isPlainObject(baseValue)) {
      // Recursively merge plain objects
      (result as Record<string, unknown>)[key as string] = deepMerge(
        baseValue as Record<string, unknown>,
        overrideValue as Record<string, unknown>
      );
    } else if (overrideValue !== undefined) {
      // Override arrays and primitives directly
      (result as Record<string, unknown>)[key as string] = overrideValue;
    }
  }

  return result;
}
