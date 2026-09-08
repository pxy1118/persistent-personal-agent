/** Permission modes supported by the native runtime (protocol DevicePermissionMode). */
export const permissionModes = ['standard', 'acceptEdits', 'unrestricted', 'strict'] as const;
export type PermissionMode = (typeof permissionModes)[number];
export function permissionModeLabel(mode: string, fallback = mode) {
  return ({ standard: '标准审批', acceptEdits: '自动批准文件编辑', unrestricted: '全部自动批准', strict: '严格审批' } as Record<string, string>)[mode] ?? fallback;
}
export function permissionModeDetail(mode: string) {
  return ({ standard: '常规：敏感工具逐次确认', acceptEdits: 'Write/Edit/记忆免确认；其余仍逐次确认', unrestricted: '所有工具免确认（谨慎）', strict: '更保守；无自动放行' } as Record<string, string>)[mode] ?? '';
}
/** Next (dir=1) or previous (dir=-1) mode, wrapping around — mirrors Claude Code's Tab / Shift+Tab cycling. */
export function cyclePermissionMode(current: string, dir: 1 | -1): PermissionMode {
  const i = Math.max(0, permissionModes.indexOf(current as PermissionMode));
  return permissionModes[(i + dir + permissionModes.length) % permissionModes.length];
}
