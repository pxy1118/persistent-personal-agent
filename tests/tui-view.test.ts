import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'ppa-ink';
import { TuiView, editInput, shortModel, hasUnsavedEditor, type TuiState } from '../src/tui-view.js';

const base:TuiState={entries:[],name:'糯糯',model:'openai-compatible/Ornith-1.5',busy:false,task:'',stream:'',online:true,modelReady:true,mode:'standard',closing:false};
const actions={submit:()=>{},stop:()=>{},quit:()=>{},dismiss:()=>{},save:()=>{},cycleMode:()=>{}};
function screen(state:TuiState,columns=80){return renderToString(createElement(TuiView,{initial:state,subscribe:()=>()=>{},actions}),{columns});}
test('TUI renders branded header, framed input and persistent model status',()=>{
  const text=screen(base);assert.match(text,/PPA/);assert.match(text,/糯糯/);assert.match(text,/Ornith-1.5/);assert.match(text,/标准审批/);assert.match(text,/Shift\+Tab 切换权限/);assert.match(text,/─{10}/);assert.ok(!text.includes('Letta Code'));
});
test('TUI status shows the actual permission mode instead of a hardcoded label',()=>{
  assert.match(screen({...base,mode:'acceptEdits'}),/自动批准文件编辑/);
  assert.match(screen({...base,mode:'unrestricted'}),/全部自动批准/);
  assert.match(screen({...base,mode:'strict'}),/严格审批/);
});
test('TUI keeps permission switching visible while the model is thinking',()=>{
  assert.match(screen({...base,busy:true,task:'正在思考'}),/Tab \/ Shift\+Tab 仍可切换权限/);
});
test('TUI has distinct model menu and approval panels',()=>{
  const menu=screen({...base,menu:{title:'选择模型',items:[{label:'ornith',detail:'本地模型',command:'/model ornith'}]}});
  assert.match(menu,/选择模型/);assert.match(menu,/↑ ↓/);
  const approval=screen({...base,approval:{id:'a',tool:'写入文件',args:'file.txt'}});
  assert.match(approval,/需要你的确认/);assert.match(approval,/❯ 拒绝/);assert.match(approval,/允许本次/);
});
test('Chinese cursor insertion, deletion, paste and multiline navigation preserve content',()=>{
  assert.deepEqual(editInput('你好🙂',1,'很',{}),{value:'你很好🙂',cursor:2});
  assert.deepEqual(editInput('你好🙂',3,'',{backspace:true}),{value:'你好',cursor:2});
  assert.deepEqual(editInput('你好',1,'甲\r\n乙',{}),{value:'你甲\n乙好',cursor:4});
  assert.equal(editInput('甲乙\n丙丁',5,'',{upArrow:true}).cursor,2);
  assert.equal(editInput('甲乙\n丙丁',1,'',{downArrow:true}).cursor,4);
  assert.equal(shortModel('openai-compatible/D:\\models\\中文模型.gguf'),'中文模型');
});
test('cursor home/end and ctrl commands edit without corrupting Chinese',()=>{
  assert.equal(editInput('你好世界',2,'',{home:true}).cursor,0);
  assert.equal(editInput('你好世界',2,'',{end:true}).cursor,4);
  assert.equal(editInput('你好世界',2,'e',{ctrl:true}).cursor,4);
  assert.deepEqual(editInput('你好世界',2,'u',{ctrl:true}),{value:'世界',cursor:0});
  assert.deepEqual(editInput('你好',1,'',{delete:true}),{value:'你',cursor:1});
});
test('unsaved editor detection gates Ctrl+C quit confirmation',()=>{
  assert.equal(hasUnsavedEditor('原文','原文'),false);
  assert.equal(hasUnsavedEditor('原文','原文已改'),true);
  assert.equal(hasUnsavedEditor('原文',''),true);
});
test('TUI renders editor panel with save hint and keeps save/discard semantics visible',()=>{
  const editor=screen({...base,editor:{path:'system/persona.md',text:'你叫糯糯。'}});
  assert.match(editor,/编辑 · system\/persona\.md/);
  assert.match(editor,/Ctrl\+S 保存 · Esc 放弃 · Enter 换行/);
  assert.match(editor,/未保存时 Ctrl\+C 需确认/);
});
