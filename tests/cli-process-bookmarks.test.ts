import { describe, expect, it, vi } from 'vitest';

describe('process-bookmarks CLI', () => {
  it('runs a processing cycle and exits cleanly', async () => {
    const parseProcessingArgs = vi.fn(() => ({ dryRun: true }));
    const runProcessingCycle = vi.fn(async () => ({ success: true, results: [] }));

    vi.resetModules();
    vi.doMock('../src/env.js', () => ({}));
    vi.doMock('../src/pipeline-runner.js', () => ({
      parseProcessingArgs,
      runProcessingCycle,
    }));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      return undefined as never;
    });

    const originalArgv = process.argv;
    process.argv = ['node', 'process-bookmarks', '--dry-run'];

    await import('../src/process-bookmarks.js');

    expect(parseProcessingArgs).toHaveBeenCalledWith(process.argv);
    expect(runProcessingCycle).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);

    process.argv = originalArgv;
    exitSpy.mockRestore();
  });
});
