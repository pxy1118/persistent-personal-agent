import assert from 'node:assert/strict';
import { captureScreen } from '../src/screen-tool.js';

// Explicit smoke command: captures the primary display in memory, validates the
// same payload used by the agent tool, and never writes a screenshot file.
const capture = await captureScreen({ display: 'primary', max_width: 800 });
assert.equal(capture.mimeType, 'image/png');
assert.ok(capture.width <= 800 && capture.width > 0 && capture.height > 0);
assert.equal(Buffer.from(capture.data, 'base64').subarray(1, 4).toString('ascii'), 'PNG');
console.log(`PASS screen capture ${capture.width}x${capture.height} PNG`);
