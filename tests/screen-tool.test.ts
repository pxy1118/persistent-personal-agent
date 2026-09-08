import test from 'node:test';
import assert from 'node:assert/strict';
import { screenCaptureArgs, screenToolDefinition, screenToolResult } from '../src/screen-tool.js';

test('screen tool is narrowly described and has bounded arguments', () => {
  assert.equal(screenToolDefinition.name, 'capture_screen');
  assert.match(screenToolDefinition.description, /without an additional approval prompt/);
  assert.deepEqual(screenCaptureArgs({}), { display: 'primary', maxWidth: 1920 });
  assert.deepEqual(screenCaptureArgs({ display: 'all', max_width: 1280 }), { display: 'all', maxWidth: 1280 });
  assert.throws(() => screenCaptureArgs({ display: 'window' }), /primary/);
  assert.throws(() => screenCaptureArgs({ max_width: 500 }), /640/);
});

test('screen result carries image bytes and truthful capture metadata', () => {
  const result = screenToolResult({ mimeType: 'image/png', data: 'aGVsbG8=', width: 800, height: 600, display: 'primary' });
  assert.match(result.content[0]!.text!, /800×600/);
  assert.deepEqual(result.content[1], { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
});
