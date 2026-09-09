import test from 'node:test';
import assert from 'node:assert/strict';
import { activateCapabilityToolDefinition, parseCapabilityActivation, toolsForCapabilities } from '../src/capability-routing.js';

test('capability directory stays small while naming every real group', () => {
  assert.equal(activateCapabilityToolDefinition.name, 'activate_capability');
  assert.match(activateCapabilityToolDefinition.description, /DO exist/i);
  assert.match(activateCapabilityToolDefinition.description, /instead of saying that you cannot/i);
  assert.ok(JSON.stringify(activateCapabilityToolDefinition).length < 3000);
});

test('capability activation validates groups and expands only selected tools', () => {
  const parsed = parseCapabilityActivation({ capabilities: ['files_read', 'screen'], reason: 'inspect supplied evidence' });
  const tools = toolsForCapabilities(parsed.capabilities);
  assert.ok(tools.includes('Read'));
  assert.ok(tools.includes('capture_screen'));
  assert.ok(!tools.includes('Write'));
  assert.ok(!tools.includes('Bash'));
  assert.throws(() => parseCapabilityActivation({ capabilities: ['unknown'], reason: 'x' }), /capabilities/);
  assert.throws(() => parseCapabilityActivation({ capabilities: ['screen', 'screen'], reason: 'x' }), /capabilities/);
});
