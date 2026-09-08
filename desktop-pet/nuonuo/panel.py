import html
import json
import re
from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QKeySequence, QShortcut, QTextCursor
from PySide6.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QTextBrowser,
    QPlainTextEdit, QFileDialog, QComboBox, QDialog, QListWidget, QMessageBox)

STYLE = '''
QWidget { background:#fffaf5; color:#493d43; font:10pt "Microsoft YaHei UI"; }
QTextBrowser,QPlainTextEdit,QListWidget { background:#ffffff; border:1px solid #ebddd7; border-radius:10px; padding:10px; selection-background-color:#e9cad0; }
QPushButton,QComboBox { background:#f4e9e4; border:0; border-radius:8px; padding:7px 11px; }
QPushButton:hover { background:#ead5d3; } QPushButton:disabled { color:#ad9d9d; }
QPushButton#primary { background:#805865; color:white; } QLabel#subtitle { color:#88747b; }
'''

class Input(QPlainTextEdit):
    submitted = Signal()
    def keyPressEvent(self, e):
        if e.key() in (Qt.Key.Key_Return,Qt.Key.Key_Enter) and not e.modifiers() & Qt.KeyboardModifier.ShiftModifier:
            self.submitted.emit(); e.accept()
        else: super().keyPressEvent(e)

class MemoryEditor(QDialog):
    def __init__(self, panel, doc):
        super().__init__(panel)
        self.panel, self.doc = panel, doc
        self.setWindowTitle('编辑 · '+doc['path']); self.resize(640,520)
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel(doc['path']))
        self.editor = QPlainTextEdit()
        self.original = re.sub(r'^---\r?\n[\s\S]*?\r?\n---\r?\n','',doc['content']).rstrip()
        self.editor.setPlainText(self.original)
        layout.addWidget(self.editor)
        self.save_button = QPushButton('保存 · Ctrl+S')
        self.save_button.clicked.connect(self.save)
        layout.addWidget(self.save_button)
        QShortcut(QKeySequence('Ctrl+S'), self, activated=self.save)
        self.saving = False

    def save(self):
        if self.saving: return
        text = self.editor.toPlainText()
        if not text.strip(): return
        self.saving = True; self.save_button.setEnabled(False)
        self.panel.bridge.request('writeMemory',{'path':self.doc['path'],'hash':self.doc['hash'],'content':text},self.saved)

    def saved(self, result, error):
        self.saving = False; self.save_button.setEnabled(True)
        if not error:
            self.original = self.editor.toPlainText()
            self.panel.line('提示','记忆已保存。')
            self.accept()
        else: QMessageBox.warning(self,'保存失败',error)

    def reject(self):
        if self.saving: return
        if self.editor.toPlainText() != self.original and QMessageBox.question(self,'未保存的修改','放弃本次修改？',QMessageBox.StandardButton.Discard|QMessageBox.StandardButton.Cancel,QMessageBox.StandardButton.Cancel) != QMessageBox.StandardButton.Discard: return
        super().reject()

class Panel(QWidget):
    visibility = Signal(bool)
    submitted = Signal(str)
    def __init__(self, bridge, parent=None):
        super().__init__(None, Qt.WindowType.Window)
        self.bridge = bridge
        self.setWindowTitle('PPA · 桌宠'); self.resize(560,690); self.setMinimumSize(420,480)
        self.setStyleSheet(STYLE)
        self.status = {}; self.image_path = None; self.entries = []; self.stream = ''; self.pending = []; self.sending = False
        layout = QVBoxLayout(self); layout.setContentsMargins(20,18,20,16); layout.setSpacing(12)
        self.heading = QLabel('PPA'); self.heading.setStyleSheet('font-size:19pt;font-weight:600;')
        self.connection = QLabel('正在连接你的助手…'); self.connection.setObjectName('subtitle')
        layout.addWidget(self.heading); layout.addWidget(self.connection)
        row = QHBoxLayout()
        for label, action in [('会话',self.sessions),('新对话',lambda:self.bridge.request('open',callback=self.history_result)),('记忆 / 人格',self.memories),('模型',self.models),('重连',self.reconnect)]:
            button = QPushButton(label); button.clicked.connect(action); row.addWidget(button)
        layout.addLayout(row)
        self.history = QTextBrowser(); self.history.setOpenExternalLinks(False); self.history.document().setMaximumBlockCount(2500)
        layout.addWidget(self.history,1)
        self.approval = QWidget(); approval_layout = QVBoxLayout(self.approval); approval_layout.setContentsMargins(0,0,0,0)
        self.approval_title = QLabel('等待你确认'); approval_layout.addWidget(self.approval_title)
        self.arguments = QPlainTextEdit(); self.arguments.setReadOnly(True); self.arguments.setMaximumHeight(130); approval_layout.addWidget(self.arguments)
        buttons = QHBoxLayout()
        for label, allow in [('允许本次',True),('拒绝',False)]:
            b=QPushButton(label); b.clicked.connect(lambda checked=False,a=allow:self.approve(a)); buttons.addWidget(b)
        approval_layout.addLayout(buttons); layout.addWidget(self.approval); self.approval.hide()
        self.attachment = QPushButton(''); self.attachment.clicked.connect(self.clear_image); self.attachment.hide(); layout.addWidget(self.attachment)
        self.input = Input(); self.input.setPlaceholderText('说点什么，或试试“跳一下”\nEnter 发送 · Shift+Enter 换行'); self.input.setMaximumHeight(100)
        self.input.submitted.connect(self.send); layout.addWidget(self.input)
        row=QHBoxLayout()
        picture=QPushButton('添加图片'); picture.clicked.connect(self.attach); row.addWidget(picture)
        self.mode=QComboBox()
        for label,value in [('标准审批','standard'),('自动批准编辑','acceptEdits'),('全部免确认','unrestricted'),('严格审批','strict')]: self.mode.addItem(label,value)
        self.mode.activated.connect(lambda i:self.bridge.request('mode',{'mode':self.mode.itemData(i)})); row.addWidget(self.mode)
        row.addStretch()
        stop=QPushButton('停止'); stop.clicked.connect(lambda:self.bridge.request('stop')); row.addWidget(stop)
        self.send_button=QPushButton('发送'); self.send_button.setObjectName('primary'); self.send_button.clicked.connect(self.send); row.addWidget(self.send_button)
        layout.addLayout(row)
        QShortcut(QKeySequence('Escape'),self,activated=self.escape)
        self.render_timer=QTimer(self); self.render_timer.setSingleShot(True); self.render_timer.timeout.connect(self.render)

    def escape(self):
        if self.status.get('busy'): self.bridge.request('stop')
        else: self.close()

    def showEvent(self,event):
        self.visibility.emit(True); super().showEvent(event)

    def closeEvent(self,event):
        self.hide(); self.visibility.emit(False); event.ignore()

    def line(self,role,text):
        self.flush()
        self.entries.append((role,str(text))); self.entries=self.entries[-200:]; self.schedule()

    def flush(self):
        if self.stream:
            self.entries.append((self.status.get('name','助手'),self.stream)); self.stream=''

    def schedule(self):
        if not self.render_timer.isActive(): self.render_timer.start(40)

    def render(self):
        bar=self.history.verticalScrollBar(); bottom=bar.value() >= bar.maximum()-20; old=bar.value()
        rows=self.entries[-200:]+([(self.status.get('name','助手'),self.stream)] if self.stream else [])
        if not rows: rows=[('今天想一起做点什么？','聊聊想法、处理事情，或者发张图片给我看看。\n\n也可以对我说“跳一下”“回来”或“睡觉”。')]
        self.history.setHtml(''.join('<p style="color:#987d87;margin-bottom:4px">'+html.escape(role)+'</p><p style="white-space:pre-wrap;margin-top:0;margin-bottom:18px">'+html.escape(text)+'</p>' for role,text in rows))
        bar.setValue(bar.maximum() if bottom else old)

    def receive(self,event,data):
        if event in ('ready','status'):
            self.status=data or {}; self.heading.setText(self.status.get('name','PPA'))
            state='正在回应' if self.status.get('busy') else '随时可以聊聊' if self.status.get('modelReady') else '模型离线 · 可重连'
            if not self.status.get('online'): state='后台未连接'
            self.connection.setText(state+'  ·  '+self.status.get('model',''))
            self.mode.setCurrentIndex(max(0,self.mode.findData(self.status.get('mode','standard'))))
            self.mode.setEnabled(bool(self.status.get('online')))
            self.pending=self.status.get('pending',[]); self.show_approval()
            self.send_button.setEnabled(not self.status.get('busy') and not self.sending)
            if event=='ready': self.bridge.request('history',callback=self.history_result)
        elif event=='text': self.stream+=str(data); self.schedule()
        elif event=='mode':
            self.status['mode']=str(data)
            self.mode.setCurrentIndex(max(0,self.mode.findData(str(data))))
        elif event=='thinking': self.connection.setText('正在思考…')
        elif event=='connecting': self.connection.setText('正在接入当前会话…')
        elif event=='tool':
            self.flush(); self.connection.setText('正在执行：'+str(data.get('name') or '工具') if data.get('status')=='running' else '正在继续…'); self.schedule()
        elif event=='approval':
            if not any(a['id']==data['id'] for a in self.pending): self.pending.append(data)
            self.show_approval()
        elif event=='done':
            self.flush(); self.pending=[]; self.show_approval(); self.schedule()
            if data and data.get('error'): self.line('错误',data['error'])
            elif data and re.search('interrupt|cancel|abort',str(data.get('reason',''))): self.line('提示','已停止，不会自动重发。')
        elif event in ('error','notice'): self.line('提示',data)
        elif event=='disconnected':
            self.flush(); self.status.update(online=False,busy=False); self.pending=[]; self.show_approval(); self.connection.setText('后台已退出 · 点击重连'); self.send_button.setEnabled(True); self.schedule()

    def show_approval(self):
        self.approval.setVisible(bool(self.pending))
        if self.pending:
            a=self.pending[0]; self.approval_title.setText('等待确认 · '+a['tool'])
            self.arguments.setPlainText(json.dumps(a['args'],ensure_ascii=False,indent=2))

    def approve(self,allow):
        if not self.pending:return
        a=self.pending[0]
        self.bridge.request('approve',{'id':a['id'],'allow':allow})

    def attach(self):
        path,_=QFileDialog.getOpenFileName(self,'选择图片','','图片 (*.png *.jpg *.jpeg *.gif *.webp *.bmp *.heic *.heif)')
        if path:
            self.image_path=path; self.attachment.setText('图片：'+path+'  ×'); self.attachment.show()

    def clear_image(self): self.image_path=None; self.attachment.hide()

    def send(self):
        text=self.input.toPlainText().strip()
        if (not text and not self.image_path) or self.sending:return
        if self.status.get('busy'):
            self.line('提示','正在回复。请等待或停止，输入不会排队。'); return
        from .companion import local_command
        if not self.image_path and local_command(text):
            self.input.clear(); self.submitted.emit(local_command(text)); self.line('你',text); return
        payload={'text':text}
        if self.image_path: payload['image']=self.image_path
        self.line('你',text+('\n📎 '+self.image_path if self.image_path else ''))
        self.input.clear(); self.clear_image(); self.sending=True; self.send_button.setEnabled(False)
        def sent(result,error):
            self.sending=False; self.send_button.setEnabled(not self.status.get('busy'))
            if error and not self.input.toPlainText(): self.input.setPlainText(text)
        self.bridge.request('send',payload,sent)

    def history_result(self,result,error):
        if error:return
        self.stream=''; self.entries=[('你' if m['role']=='user' else self.status.get('name','助手'),m['text']) for m in result]; self.schedule()

    def choose(self,title,items,action):
        dialog=QDialog(self); dialog.setWindowTitle(title); dialog.resize(530,360)
        layout=QVBoxLayout(dialog); listing=QListWidget(); layout.addWidget(listing)
        for label,value in items: listing.addItem(label)
        button=QPushButton('打开'); layout.addWidget(button)
        def select():
            i=listing.currentRow()
            if i>=0: dialog.accept(); action(items[i][1])
        button.clicked.connect(select); listing.itemDoubleClicked.connect(select)
        dialog.open(); self.choice=dialog

    def sessions(self):
        self.bridge.request('sessions',callback=lambda rows,error:None if error else self.choose('会话',[(str(x.get('summary') or x.get('description') or '未命名对话')+'\n'+x['id'],x['id']) for x in rows],lambda value:self.bridge.request('open',{'id':value},self.history_result)))

    def memories(self):
        def received(rows,error):
            if error:return
            def edit(doc):
                self.memory_editor=MemoryEditor(self,doc); self.memory_editor.open()
            self.choose('人格与记忆',[(x['path']+' · '+x.get('description',''),x) for x in rows],edit)
        self.bridge.request('memories',callback=received)

    def models(self):
        self.bridge.request('models',callback=lambda rows,error:None if error else self.choose('模型配置',[(name+' · '+value['modelBaseUrl'],name) for name,value in rows.items()],lambda name:self.bridge.request('model',{'name':name})))

    def reconnect(self):
        from PySide6.QtCore import QProcess
        if self.bridge.process.state()==QProcess.ProcessState.NotRunning:self.bridge.start()
        else:self.bridge.request('reconnect')
