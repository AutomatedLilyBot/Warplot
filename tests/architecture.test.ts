import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const src = fileURLToPath(new URL('../src/', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('architecture', () => {
  test.each(['core', 'state', 'rules', 'events'])('src/%s has no UI / rendering / DOM dependencies', (dir) => {
    for (const f of files(join(src, dir))) {
      const code = readFileSync(f, 'utf8');
      const imports = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const i of imports) {
        expect(i, `${f} imports ${i}`).not.toMatch(/^(three|react|react-dom)(\/|$)/);
        expect(i, `${f} imports ${i}`).not.toMatch(/\/(ui|renderer)\//);
      }
      expect(code, `${f} touches the DOM`).not.toMatch(/(?<![.\w])(document|window)\./);
    }
  });

  test('the renderer does not reach into the engine (it only draws a MapModel)', () => {
    for (const f of files(join(src, 'renderer'))) {
      const imports = [...readFileSync(f, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const i of imports) expect(i, `${f} imports ${i}`).not.toMatch(/\/(events|rules|state)\//);
    }
  });

  test('React effects use block bodies (an expression body becomes the cleanup React calls)', () => {
    for (const f of files(join(src, 'ui'))) {
      const code = readFileSync(f, 'utf8');
      const bad = [...code.matchAll(/use(Layout)?Effect\(\s*\(\)\s*=>(?!\s*\{)/g)];
      expect(bad.length, `${f} has an expression-bodied effect`).toBe(0);
    }
  });
});
