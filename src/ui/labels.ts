/**
 * Display-name layer. The core keeps simple ids (blue-T1, red-MG3); the UI
 * shows what a reader expects (track 7001, 导弹群 3). Pure functions.
 */
import type { Command } from '../events/types.js';

export const TRACK_NUMBER_BASE = 7000;

/** "blue-T12" → "7012". Unknown formats pass through unchanged. */
export function trackNumber(trackId: string): string {
  const m = /-T(\d+)$/.exec(trackId);
  return m ? String(TRACK_NUMBER_BASE + Number(m[1])) : trackId;
}

/** "red-MG3" → "MG3". */
export function groupLabel(groupId: string): string {
  const m = /-(MG\d+)$/.exec(groupId);
  return m ? m[1]! : groupId;
}

export const SPATIAL_ZH: Record<string, string> = { BEARING_ONLY: '纯方位', LOCALIZED: '定位' };

export const IDENTITY_ZH: Record<string, string> = { hostile: '敌对', neutral: '中立', friendly: '友方', unknown: '敌我不明' };

export const CATEGORY_ZH: Record<string, string> = { ship: '舰船', uav: '无人机', aew: '预警机', missile: '导弹' };

export const STATUS_ZH: Record<string, string> = { active: '正常', damaged: '受损', disabled: '失能', destroyed: '被毁' };

/** One-line Chinese summary of a command for history lists. `name` maps unit ids to display names. */
export function commandSummary(c: Command, name: (unitId: string) => string = (id) => id): string {
  switch (c.type) {
    case 'ADVANCE':
      return c.until !== undefined ? '推进时间（到指定时刻）' : c.stopAtNotable ? '推进到下一事件' : '推进到下一机会';
    case 'SET_ROUTE':
      return `${name(c.unitId)} 新航路 ${c.waypoints.length} 点`;
    case 'SET_SENSOR':
      return `${name(c.unitId)} ${c.sensorId} ${c.on ? '开机' : '关机'}`;
    case 'TRANSMIT':
      return `${name(c.from)} → ${name(c.to)} 发送 ${trackNumber(c.trackId)}`;
    case 'LAUNCH':
      return `${name(c.unitId)} 发射 ${c.count} × ${c.weaponId} → ${trackNumber(c.trackId)}`;
    case 'ENGAGE':
      return `${name(c.unitId)} ${c.weaponId} 拦截 ${trackNumber(c.trackId)}`;
    case 'ALIGN':
      return `${name(c.unitId)} ${c.mountId} 对准 ${trackNumber(c.trackId)}`;
    case 'MANEUVER':
      return `${name(c.unitId)} 机动 ${c.label} ${c.durationS} s`;
    case 'RELEASE_CLAIM':
      return `${name(c.unitId)} 释放 ${c.claimId}`;
    case 'RESOLVE': {
      const d = c.decision;
      const what =
        d.kind === 'detection' ? (d.detected ? '探测到' : '未探测到') : d.kind === 'intercept' ? `拦截 ${d.intercepted}` : `命中 ${d.hits}`;
      return `裁定 ${c.opportunityId}：${what}`;
    }
    case 'CLASSIFY':
      return `${name(c.unitId)} 分类 ${trackNumber(c.trackId)}`;
    case 'SET_UNIT_STATUS':
      return `${name(c.unitId)} 状态 → ${STATUS_ZH[c.status] ?? c.status}`;
    case 'NOTE':
      return `备注：${c.text}`;
  }
}
