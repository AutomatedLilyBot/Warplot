import { describe, expect, test } from 'vitest';
import { Session } from '../src/events/session.js';
import { ddg, detectAll, miniCtx, must, pending } from './helpers.js';
import type { UnitSetup } from '../src/state/defs.js';

const uav = (id: string, side: string, position: [number, number, number]): UnitSetup => ({
  id,
  name: id,
  side,
  classId: 'uav',
  position,
  sensorsOn: ['uav-radar'],
  loadout: {},
});

/** Red DDG 200 km out: beyond the blue DDG's radar, but a blue UAV near it can see it. */
function scene() {
  const ctx = miniCtx(
    [ddg('b1', 'blue', [0, 0, 0], { sensorsOn: [] }), uav('bu', 'blue', [120_000, 0, 5000]), ddg('r1', 'red', [200_000, 0, 0], { sensorsOn: [] })],
    { datalinks: [{ id: 'L16', name: 'link', side: 'blue', members: ['b1', 'bu'], latencyS: 2 }] },
  );
  const s = new Session(ctx);
  must(s, { type: 'ADVANCE', until: 1000 });
  detectAll(s); // UAV detects r1 → blue-T1 on the UAV only
  return { ctx, s };
}

describe('knowledge propagation', () => {
  test('a detection is known only to the detecting platform', () => {
    const { s } = scene();
    expect(Object.keys(s.state.knowledge['bu']!)).toEqual(['blue-T1']);
    expect(s.state.knowledge['b1']).toEqual({});
  });

  test('DDG cannot fire before the datalink message arrives; can after', () => {
    const { s } = scene();
    const launch = { type: 'LAUNCH', unitId: 'b1', mountId: 'vls', weaponId: 'asm-x', count: 4, trackId: 'blue-T1' } as const;

    const v0 = s.check(launch);
    expect(v0.ok).toBe(false);
    expect(JSON.stringify(v0.checks)).toContain('本平台没有航迹');

    const t0 = s.state.time;
    const tx = must(s, { type: 'TRANSMIT', linkId: 'L16', from: 'bu', to: 'b1', trackId: 'blue-T1' });
    const msg = s.state.messages[0]!;
    // latency 2 s + ~120.1 km at c
    const d = Math.hypot(120_000, 0, 5000);
    expect(msg.deliverAt).toBe(t0 + Math.ceil((2 + d / 299792458) * 1000));

    const v1 = s.check(launch);
    expect(v1.ok).toBe(false);
    expect(v1.earliest).toBe(msg.deliverAt);
    expect(s.state.knowledge['b1']).toEqual({});

    // Advance one millisecond short of delivery: still unknown.
    must(s, { type: 'ADVANCE', until: msg.deliverAt - 1 });
    expect(s.state.knowledge['b1']).toEqual({});
    expect(s.check(launch).ok).toBe(false);

    must(s, { type: 'ADVANCE', until: msg.deliverAt, stopAtNotable: true });
    expect(s.state.time).toBe(msg.deliverAt);
    const tr = s.state.knowledge['b1']!['blue-T1']!;
    expect(tr.quality).toBe('WEAPON_SUPPORT');
    expect(tr.holds).toEqual({});
    const r = must(s, launch);

    // Causal chain: LAUNCH ← DELIVERY ← TRANSMIT ← DETECTION ← DETECTION_OPPORTUNITY
    const byId = new Map(s.state.log.map((e) => [e.id, e]));
    const launchEv = r.events.find((e) => e.kind === 'LAUNCH')!;
    const seen = new Set<string>();
    const walk = (id: string) => {
      const e = byId.get(id)!;
      seen.add(e.kind);
      e.causedBy.forEach(walk);
    };
    launchEv.causedBy.forEach(walk);
    expect([...seen]).toEqual(expect.arrayContaining(['DELIVERY', 'TRANSMIT', 'DETECTION', 'DETECTION_OPPORTUNITY']));
    expect(tx.events[0]!.kind).toBe('TRANSMIT');
  });

  test('transmitted track is a snapshot: it ages on the receiver while the sender keeps it fresh', () => {
    const { s } = scene();
    must(s, { type: 'TRANSMIT', linkId: 'L16', from: 'bu', to: 'b1', trackId: 'blue-T1' });
    must(s, { type: 'ADVANCE', until: 60_000 });
    while (pending(s).length) {
      detectAll(s);
      must(s, { type: 'ADVANCE', until: 60_000 });
    }
    const sender = s.state.knowledge['bu']!['blue-T1']!;
    const receiver = s.state.knowledge['b1']!['blue-T1']!;
    expect(sender.lastUpdate).toBe(60_000);
    expect(receiver.lastUpdate).toBeLessThan(2000);
  });

  test('cannot transmit on a link the platform is not a member of', () => {
    const { s } = scene();
    const v = s.check({ type: 'TRANSMIT', linkId: 'L16', from: 'bu', to: 'r1', trackId: 'blue-T1' });
    expect(v.ok).toBe(false);
  });
});
