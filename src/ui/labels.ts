/**
 * Display-name layer. The core keeps simple ids (blue-T1, red-MG3); the UI
 * shows what a reader expects (track 7001, 导弹群 3). Pure functions.
 */
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
