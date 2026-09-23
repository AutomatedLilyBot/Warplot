/**
 * Canvas-drawn sprite textures: tactical glyphs and text labels.
 * Cached by content so rebuilding the scene does not re-rasterise.
 */
import * as THREE from 'three';

export type GlyphShape = 'ship' | 'air' | 'missile' | 'contact' | 'ring' | 'dot';

const glyphCache = new Map<string, THREE.Texture>();
const labelCache = new Map<string, { tex: THREE.Texture; w: number; h: number }>();

const DPR = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * DPR);
  c.height = Math.ceil(h * DPR);
  const g = c.getContext('2d')!;
  g.scale(DPR, DPR);
  return [c, g];
}

function texture(c: HTMLCanvasElement): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

/** 32×32 logical px glyph. */
export function glyphTexture(shape: GlyphShape, color: string, dim = false): THREE.Texture {
  const key = `${shape}|${color}|${dim}`;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const S = 32;
  const [c, g] = canvas(S, S);
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = 2.5;
  g.globalAlpha = dim ? 0.45 : 1;
  const m = S / 2;
  g.beginPath();
  switch (shape) {
    case 'ship': // circle with centre dot
      g.arc(m, m, 10, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(m, m, 3, 0, Math.PI * 2);
      g.fill();
      break;
    case 'air': // open-bottom chevron
      g.moveTo(m - 11, m + 8);
      g.lineTo(m, m - 10);
      g.lineTo(m + 11, m + 8);
      g.stroke();
      g.beginPath();
      g.arc(m, m + 2, 2.5, 0, Math.PI * 2);
      g.fill();
      break;
    case 'missile': // filled diamond
      g.moveTo(m, m - 9);
      g.lineTo(m + 7, m);
      g.lineTo(m, m + 9);
      g.lineTo(m - 7, m);
      g.closePath();
      g.fill();
      break;
    case 'contact': // square outline (unidentified track)
      g.strokeRect(m - 9, m - 9, 18, 18);
      g.beginPath();
      g.arc(m, m, 2.5, 0, Math.PI * 2);
      g.fill();
      break;
    case 'ring':
      g.lineWidth = 2;
      g.arc(m, m, 14, 0, Math.PI * 2);
      g.stroke();
      break;
    case 'dot':
      g.arc(m, m, 4, 0, Math.PI * 2);
      g.fill();
      break;
  }
  const t = texture(c);
  glyphCache.set(key, t);
  return t;
}

/** Two-line label; returns texture and its logical pixel size. */
export function labelTexture(text: string, sub: string | undefined, color: string): { tex: THREE.Texture; w: number; h: number } {
  const key = `${text}|${sub ?? ''}|${color}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const font = '600 12px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  const subFont = '11px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  const [, probe] = canvas(1, 1);
  probe.font = font;
  let w = probe.measureText(text).width;
  if (sub) {
    probe.font = subFont;
    w = Math.max(w, probe.measureText(sub).width);
  }
  w = Math.ceil(w) + 8;
  const h = sub ? 30 : 17;
  const [c, g] = canvas(w, h);
  g.font = font;
  g.textBaseline = 'top';
  g.shadowColor = 'rgba(0,0,0,0.9)';
  g.shadowBlur = 3;
  g.fillStyle = color;
  g.fillText(text, 4, 2);
  if (sub) {
    g.font = subFont;
    g.fillStyle = 'rgba(200,210,225,0.85)';
    g.fillText(sub, 4, 17);
  }
  const out = { tex: texture(c), w, h };
  labelCache.set(key, out);
  return out;
}
