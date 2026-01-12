import { describe, expect, it } from 'vitest';
import { initializeFromAnalysis, loadPreferences, recordDecision, savePreferences } from '../src/preferences.js';
import type { Categorization, ProcessedBookmark } from '../src/types.js';
import { dataPath } from './helpers/data-paths.js';
import { withFileSnapshot } from './helpers/file-snapshot.js';

describe('preferences', () => {
  it('records example text from originalText when text is missing', async () => {
    const prefsPath = dataPath('preferences.json');

    await withFileSnapshot(prefsPath, async () => {
      await savePreferences({} as any);
      const bookmark: Partial<ProcessedBookmark> = {
        id: '1',
        originalText: 'Developer tips for debugging',
        author: { username: 'user', id: '1', name: 'User' },
      };
      const categorization: Categorization = {
        category: 'review',
        priority: 'low',
        contentType: 'other',
        contentFormat: 'tweet',
        summary: 'test',
        keyValue: 'test',
        quotes: [],
        tags: [],
        actionItems: [],
      };

      await recordDecision(bookmark as ProcessedBookmark, categorization, 'export');

      const prefs = await loadPreferences();
      const latest = prefs.examples.exported.at(-1);
      expect(latest?.text).toContain('Developer tips for debugging');
    });
  });

  it('initializes interests from originalText when text is missing', async () => {
    const prefsPath = dataPath('preferences.json');

    await withFileSnapshot(prefsPath, async () => {
      await savePreferences({} as any);
      await initializeFromAnalysis([{ originalText: 'Developer tips and engineering notes' }]);

      const prefs = await loadPreferences();
      expect(prefs.interestedTopics).toContain('developer');
    });
  });
});
