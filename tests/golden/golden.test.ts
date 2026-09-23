import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadScript, runScript } from './runner.js';
import { replay } from '../../src/events/engine.js';

const dir = fileURLToPath(new URL('./scripts/', import.meta.url));
const scripts = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

describe('golden scenarios', () => {
  test('there are golden scripts', () => expect(scripts.length).toBeGreaterThan(0));

  for (const file of scripts) {
    test(file, async () => {
      const script = loadScript(file);
      const { text, session, ctx } = runScript(script);
      // Every branch must replay to the same state from its command list alone.
      for (const b of session.branches()) {
        session.switchBranch(b.id);
        expect(JSON.stringify(replay(ctx, session.commands()))).toBe(JSON.stringify(session.state));
      }
      // Update with: npx vitest run tests/golden -u
      await expect(text).toMatchFileSnapshot(`./__golden__/${file.replace(/\.json$/, '.txt')}`);
    });
  }
});
