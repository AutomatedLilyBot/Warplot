/**
 * Simulation time: integer milliseconds since the scenario epoch.
 * Integers keep event ordering exact and replay deterministic.
 */
export type SimTime = number;

export const seconds = (s: number): SimTime => Math.round(s * 1000);
export const toSeconds = (t: SimTime): number => t / 1000;

/** Format as HH:MM:SS(.mmm) relative to an epoch offset given in seconds-of-day. */
export function formatClock(t: SimTime, epochSecondsOfDay = 0): string {
  const totalMs = Math.round(t + epochSecondsOfDay * 1000);
  const ms = ((totalMs % 1000) + 1000) % 1000;
  const total = Math.floor(totalMs / 1000);
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return ms ? `${base}.${String(ms).padStart(3, '0')}` : base;
}

/** Parse "HH:MM:SS" into seconds-of-day. */
export function parseClock(s: string): number {
  const [h = 0, m = 0, sec = 0] = s.split(':').map(Number);
  return h * 3600 + m * 60 + sec;
}
