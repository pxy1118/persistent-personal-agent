import test from 'node:test';
import assert from 'node:assert/strict';
import { safeTerminal, imageMediaType, splitImageArgs } from '../src/ppa-terminal.js';
import { displayText } from '../src/ppa-session.js';
import { permissionModes, permissionModeLabel, permissionModeDetail, cyclePermissionMode } from '../src/permission-modes.js';

test('terminal output strips ANSI/OSC control injection but keeps Chinese and text layout',()=>{
  assert.equal(safeTerminal('\x1b[2J你好\n\x1b]0;fake-title\x07世界\tok'),'你好\n世界\tok');
});
test('history projection hides generated environment reminders and keeps conversation text',()=>{
  assert.equal(displayText([{type:'text',text:'<system-reminder>private environment</system-reminder>'},{type:'text',text:'你好，这是我的消息。'}]),'你好，这是我的消息。');
  assert.equal(displayText([{type:'reasoning',reasoning:'private'},{type:'text',text:'正文'}]),'正文');
});
test('image media types map supported formats and reject others',()=>{
  assert.equal(imageMediaType('D:\\pic\\照片.png'),'image/png');
  assert.equal(imageMediaType('photo.JPG'),'image/jpeg');
  assert.equal(imageMediaType('shot.jpeg'),'image/jpeg');
  assert.equal(imageMediaType('clip.gif'),'image/gif');
  assert.equal(imageMediaType('pic.webp'),'image/webp');
  assert.equal(imageMediaType('a.txt'),undefined);
  assert.equal(imageMediaType('noext'),undefined);
});
test('image args split quoted paths, spaced paths and questions correctly',()=>{
  const exists = (p: string) => p === 'D:\\my photo.png' || p === 'plain.png' || p === 'C:\\目录\\图 片.png';
  assert.deepEqual(splitImageArgs('D:\\my photo.png 这是什么颜色？', exists), { path: 'D:\\my photo.png', question: '这是什么颜色？' });
  assert.deepEqual(splitImageArgs('"D:\\my photo.png" 这是什么颜色？', exists), { path: 'D:\\my photo.png', question: '这是什么颜色？' });
  assert.deepEqual(splitImageArgs('plain.png', exists), { path: 'plain.png', question: '' });
  assert.deepEqual(splitImageArgs('C:\\目录\\图 片.png', exists), { path: 'C:\\目录\\图 片.png', question: '' });
  assert.deepEqual(splitImageArgs('"missing.png" 问题', exists), { path: 'missing.png', question: '问题' });
  assert.deepEqual(splitImageArgs('missing.png 问题', exists), { question: '' });
  assert.deepEqual(splitImageArgs('', exists), { question: '' });
});
test('all native permission modes have Chinese labels and details',()=>{
  assert.deepEqual(permissionModes, ['standard','acceptEdits','unrestricted','strict']);
  for (const mode of permissionModes) {
    assert.equal(permissionModeLabel(mode).length > 0, true);
    assert.ok(permissionModeDetail(mode).length > 0);
  }
  assert.equal(permissionModeLabel('future-mode'), 'future-mode');
});
test('permission mode cycling wraps both directions like Claude Code Tab / Shift+Tab',()=>{
  assert.equal(cyclePermissionMode('standard',1),'acceptEdits');
  assert.equal(cyclePermissionMode('acceptEdits',1),'unrestricted');
  assert.equal(cyclePermissionMode('unrestricted',1),'strict');
  assert.equal(cyclePermissionMode('strict',1),'standard');
  assert.equal(cyclePermissionMode('standard',-1),'strict');
  assert.equal(cyclePermissionMode('strict',-1),'unrestricted');
  assert.equal(cyclePermissionMode('unknown',1),'acceptEdits');
});
