export const capabilityNames = ['files_read', 'files_write', 'shell', 'screen', 'memory', 'tasks', 'skills'] as const;
export type CapabilityName = (typeof capabilityNames)[number];

export const capabilityToolAllowlist: Record<CapabilityName, readonly string[]> = {
  files_read: ['Read', 'LS', 'Glob', 'Grep', 'ViewImage'],
  files_write: ['Read', 'LS', 'Glob', 'Grep', 'Write', 'Edit', 'ApplyPatch'],
  shell: ['Bash', 'BashOutput', 'KillBash'],
  screen: ['capture_screen'],
  memory: ['memory'],
  tasks: ['Agent', 'TaskOutput', 'TaskStop', 'Monitor'],
  skills: ['Skill'],
};

export const activateCapabilityToolDefinition = {
  name: 'activate_capability',
  label: '启用能力',
  description: `Activate real tools that PPA owns but keeps out of ordinary chat requests to reduce latency. The capabilities DO exist: files_read reads/searches files and images; files_write reads and edits files; shell runs and monitors commands; screen captures the user's screen; memory reads or changes durable agent memory; tasks delegates or monitors longer work; skills loads an available procedural skill. When the user's request needs any of them, call this tool instead of saying that you cannot access, inspect, edit, run, remember, delegate, or view it. Select only the capabilities needed for the current request, up to three. After activation, end this phase without claiming success; PPA automatically continues the same user turn with the selected real tools. Do not activate tools for ordinary conversation or when no action is needed.`,
  parameters: {
    type: 'object', additionalProperties: false, required: ['capabilities', 'reason'],
    properties: {
      capabilities: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'string', enum: capabilityNames } },
      reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Briefly state what real operation is needed. This is internal and is not shown as a user-facing claim.' },
    },
  },
} as const;

export function parseCapabilityActivation(input: Record<string, unknown>) {
  const values = Array.isArray(input.capabilities) ? input.capabilities : [];
  const capabilities = [...new Set(values.filter((value): value is CapabilityName => typeof value === 'string' && capabilityNames.includes(value as CapabilityName)))];
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (capabilities.length !== values.length || capabilities.length < 1 || capabilities.length > 3) throw new Error('capabilities 必须包含 1 到 3 个不重复的已知能力。');
  if (!reason || reason.length > 500) throw new Error('reason 必须是 1 到 500 字符的文本。');
  return { capabilities, reason };
}

export function toolsForCapabilities(capabilities: readonly CapabilityName[]) {
  return [...new Set(capabilities.flatMap(capability => capabilityToolAllowlist[capability]))];
}
