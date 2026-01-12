import path from 'node:path';

export function dataPath(...segments: string[]): string {
  return path.resolve(process.cwd(), 'data', ...segments);
}
