import test from 'node:test';
import assert from 'node:assert/strict';
import { safeTerminal } from '../src/ppa-terminal.js';
import { displayText } from '../src/ppa-session.js';

test('terminal output strips ANSI/OSC control injection but keeps Chinese and text layout',()=>{
  assert.equal(safeTerminal('\x1b[2J你好\n\x1b]0;fake-title\x07世界\tok'),'你好\n世界\tok');
});
test('history projection hides generated environment reminders and keeps conversation text',()=>{
  assert.equal(displayText([{type:'text',text:'<system-reminder>private environment</system-reminder>'},{type:'text',text:'你好，这是我的消息。'}]),'你好，这是我的消息。');
  assert.equal(displayText([{type:'reasoning',reasoning:'private'},{type:'text',text:'正文'}]),'正文');
});
