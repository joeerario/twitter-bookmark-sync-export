import { readFile, rm, writeFile } from 'node:fs/promises';

export async function withFileSnapshot<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  let previous: string | null = null;
  let hadFile = true;

  try {
    previous = await readFile(filePath, 'utf-8');
  } catch {
    hadFile = false;
  }

  try {
    return await fn();
  } finally {
    if (hadFile && previous !== null) {
      await writeFile(filePath, previous);
    } else {
      await rm(filePath, { force: true });
    }
  }
}
