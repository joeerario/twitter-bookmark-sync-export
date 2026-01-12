/**
 * Error Handling Utilities
 *
 * Provides type-safe error handling helpers for use throughout the application.
 * TypeScript encourages `catch (e: unknown)` - these helpers prevent repeated
 * unsafe `e.message` assumptions.
 */

/**
 * Check if a value is a Node.js ErrnoException
 */
export function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e;
}

/**
 * Extract a human-readable error message from an unknown error.
 * Safe to use with `catch (e: unknown)`.
 */
export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  if (typeof e === 'string') {
    return e;
  }
  if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string') {
    return e.message;
  }
  return String(e);
}

/**
 * Extract the error stack if available
 */
export function toErrorStack(e: unknown): string | undefined {
  if (e instanceof Error) {
    return e.stack;
  }
  return undefined;
}

/**
 * Check if an error has a specific code (common for Node.js errors)
 */
export function hasErrorCode(e: unknown, code: string): boolean {
  return isNodeError(e) && e.code === code;
}

/**
 * Check if the error is a file-not-found error
 */
export function isNotFoundError(e: unknown): boolean {
  return hasErrorCode(e, 'ENOENT');
}

/**
 * Check if the error is a file-already-exists error
 */
export function isFileExistsError(e: unknown): boolean {
  return hasErrorCode(e, 'EEXIST');
}

/**
 * Check if the error is a permission denied error
 */
export function isPermissionError(e: unknown): boolean {
  return hasErrorCode(e, 'EACCES') || hasErrorCode(e, 'EPERM');
}

/**
 * Wrap an unknown error into an Error object
 */
export function ensureError(e: unknown): Error {
  if (e instanceof Error) {
    return e;
  }
  return new Error(toErrorMessage(e));
}
