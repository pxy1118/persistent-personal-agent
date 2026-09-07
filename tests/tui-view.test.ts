import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'ppa-ink';
import { TuiView, editInput, shortModel, type TuiState } from '../src/tui-view.js';

const base:TuiState={entries:[],name:'糯糯',model:'openai-compatible/Ornith-1.5',busy:false,task:'',stream:'',online:true,modelReady:true,closing:false};
const actions={submit:()=>{},stop:()=>{},quit:()=>{},dismiss:()=>{},save:()=>{}};
function screen(state:TuiState,columns=80){return renderToString(createElement(TuiView,{initial:state,subscribe:()=>()=>{},actions}),{columns});}
test('TUI renders branded header, framed input and persistent model status',()=>{
  const text=screen(base);assert.match(text,/PPA/);assert.match(text,/糯糯/);assert.match(text,/Ornith-1.5/);assert.match(text,/标准审批/);assert.match(text,/─{10}/);assert.ok(!text.includes('Letta Code'));
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
