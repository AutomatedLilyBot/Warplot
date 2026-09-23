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

export const QUALITY_ZH: Record<string, string> = {
  NONE: '无',
  DETECTED: '发现',
  BEARING_ONLY: '纯方位',
  LOCALIZED: '定位',
  CLASSIFIED: '识别',
  WEAPON_SUPPORT: '武器级',
  FIRE_CONTROL: '火控级',
};

export const STATUS_ZH: Record<string, string> = { active: '正常', damaged: '受损', disabled: '失能', destroyed: '被毁' };
