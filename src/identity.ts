import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './config.js';
import { Store, type Identity } from './store.js';

export function loadProjectIdentity(path = resolve(root, 'config/identity.json')): Omit<Identity, 'version'> {
  const profile = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: number; identity?: Partial<Identity> };
  if (profile.schemaVersion !== 1) throw new Error('不支持的项目人格配置版本。');
  const result = {} as Omit<Identity, 'version'>;
  for (const field of ['name', 'personality', 'relationship'] as const) {
    const value = profile.identity?.[field];
    if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new Error(`项目人格字段无效：${field}`);
    result[field] = value;
  }
  return result;
}

/** Host-only operation: an explicit user action, never called by a model tool or normal startup. */
export function applyProjectIdentity(store: Store, value = loadProjectIdentity()) {
  return store.transaction(() => {
    const current = store.identity();
    const same = (['name', 'personality', 'relationship'] as const).every(k => current[k] === value[k]);
    return { changed: !same, identity: same ? current : store.saveIdentity(value) };
  });
}
