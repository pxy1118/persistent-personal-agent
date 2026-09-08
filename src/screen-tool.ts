import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { root } from './letta-runtime.js';

const execFileAsync = promisify(execFile);
export type ScreenDisplay = 'primary' | 'all';
export type ScreenCapture = { mimeType: 'image/png'; data: string; width: number; height: number; display: ScreenDisplay };
export type ScreenToolResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; is_error?: boolean };

export const screenToolDefinition = {
  name: 'capture_screen',
  label: '读取屏幕',
  description: 'Capture the user\'s current screen as an image so you can understand visible apps and respond about what is on screen. Use only when the user asks you to look at the screen or when the visible screen is clearly needed for their request. PPA executes this bounded local tool directly without an additional approval prompt.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      display: { type: 'string', enum: ['primary', 'all'], description: 'Capture the primary display, or the complete virtual desktop across all displays. Defaults to primary.' },
      max_width: { type: 'integer', minimum: 640, maximum: 3840, description: 'Maximum output width in pixels. Defaults to 1920.' }
    }
  }
} as const;

export function screenCaptureArgs(input: Record<string, unknown>): { display: ScreenDisplay; maxWidth: number } {
  const display = input.display ?? 'primary';
  const maxWidth = input.max_width ?? 1920;
  if (display !== 'primary' && display !== 'all') throw new Error('display 必须是 primary 或 all。');
  if (!Number.isInteger(maxWidth) || Number(maxWidth) < 640 || Number(maxWidth) > 3840) throw new Error('max_width 必须是 640 到 3840 之间的整数。');
  return { display, maxWidth: Number(maxWidth) };
}

function pngDimensions(data: Buffer) {
  if (data.length < 24 || data.toString('ascii', 1, 4) !== 'PNG') throw new Error('屏幕捕获未返回有效 PNG。');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export async function captureScreen(input: Record<string, unknown>): Promise<ScreenCapture> {
  if (process.platform !== 'win32') throw new Error('当前版本的屏幕读取仅支持 Windows。');
  const { display, maxWidth } = screenCaptureArgs(input);
  const script = join(root, 'scripts', 'capture-screen.ps1');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Display', display, '-MaxWidth', String(maxWidth)], {
    encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 32 * 1024 * 1024
  });
  const data = stdout.trim();
  if (!data) throw new Error('屏幕捕获没有返回图像。');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > 20 * 1024 * 1024) throw new Error('屏幕图像超过 20MB，已拒绝发送。');
  const { width, height } = pngDimensions(bytes);
  return { mimeType: 'image/png', data, width, height, display };
}

export function screenToolResult(capture: ScreenCapture): ScreenToolResult {
  return {
    content: [
      { type: 'text', text: `已在用户明确授权后读取${capture.display === 'all' ? '全部显示器' : '主屏幕'}（${capture.width}×${capture.height}）。请根据图像内容直接回应用户；不要声称看到了图像之外的信息。` },
      { type: 'image', data: capture.data, mimeType: capture.mimeType }
    ]
  };
}
