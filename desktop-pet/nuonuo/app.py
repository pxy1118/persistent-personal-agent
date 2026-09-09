from __future__ import annotations
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import sys
import time
from PySide6.QtCore import Qt, QTimer, QLockFile
from PySide6.QtGui import QIcon
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon, QLabel, QSlider, QWidgetAction, QWidget, QVBoxLayout, QMessageBox
from .base_window import PetWindow as BaseWindow, ROOT, ASSETS
from .model import Store
from .bridge import Bridge
from .panel import Panel
from .quick_chat import HeadBubble, QuickInput
from .companion import ActionQueue, Initiative, is_drag
from . import windows

log=logging.getLogger(__name__)

class PetWindow(BaseWindow):
    def __init__(self,store,options):
        self.writer=ThreadPoolExecutor(max_workers=1,thread_name_prefix='pet-save')
        self.save_future=None; self.shutting_down=False
        self.panel=None; self.bridge=None; self.actions_queue=ActionQueue()
        self.state={}; self.press=None; self.user_until=0.; self.protected_until=0.; self.feedback_until=0.
        self.tool_failed=False
        self.reply_stream=''; self.quick_turn=False; self.mirrored_speech=''
        self.frame_times=deque(maxlen=120000); self.samples=deque(maxlen=120); self.next_sample=0.
        self.started=time.monotonic(); self.last_metrics=self.started; self.next_initiative=0.
        self.pref=self.read_json(store.directory/'preferences.json',{})
        self.initiative=Initiative(self.pref.get('initiative'))
        super().__init__(store,options)
        self.draw_inline_bubble=False
        self.setWindowTitle('PPA · 桌宠'); self.setObjectName('PpaPet')
        self.settings.react_to_deletes=True # Virtual meal state machine only; no OS watchers exist.
        self.settings.watched_folders=[]
        self.position_saved=self.read_json(store.directory/'position.json',{})
        if self.position_saved:
            try:
                import math
                x=float(self.position_saved['x']); y=float(self.position_saved['y'])
                if not math.isfinite(x) or not math.isfinite(y):raise ValueError('Invalid position')
                self.engine.x=x; self.engine.y=y
                self.engine.fall(); self.refresh_world(); self.position_window()
            except (KeyError,ValueError,TypeError): self.engine.home(windows.cursor())
        self.bridge=Bridge(ROOT.parent,store.directory.parent,self)
        self.panel=Panel(self.bridge)
        self.quick_input=QuickInput()
        self.head_bubble=HeadBubble()
        self.quick_input.submitted.connect(self.quick_send)
        self.panel.visibility.connect(self.panel_visible)
        self.panel.submitted.connect(self.command)
        self.bridge.event.connect(self.receive)
        self.bridge.ended.connect(self.bridge_ended)
        if not options.no_backend:self.bridge.start()
        if options.chat:self.show_panel()

    @staticmethod
    def read_json(path,default):
        try:
            value=json.loads(path.read_text(encoding='utf-8'))
            return value if isinstance(value,dict) else default
        except (OSError,ValueError):return default

    def make_menu(self):
        self.menu=QMenu(); self.menu.aboutToShow.connect(self.sync_menu)
        self.menu.aboutToHide.connect(lambda:setattr(self,'menu_open',False))
        self.menu.addAction('快速说句话',self.show_quick_input)
        self.menu.addAction('打开完整聊天',self.show_panel)
        self.menu.addAction('回到我身边',lambda:self.command('home'))
        for label,cmd in [('喂一颗点心','feed'),('抱抱鼠标','hug'),('跳一下','hop'),('睡觉','sleep'),('醒醒','wake')]:
            self.menu.addAction(label,lambda checked=False,c=cmd:self.command(c))
        self.menu.addSeparator(); self.actions={}
        for label,key in [('专注模式 · 暂停走动与搭话','quiet_mode'),('关闭素材声音','mute'),('关闭主动搭话','initiative_off')]:
            a=self.menu.addAction(label); a.setCheckable(True); a.triggered.connect(lambda checked,k=key:self.toggle(k,checked)); self.actions[key]=a
        holder=QWidget(); layout=QVBoxLayout(holder); self.size_label=QLabel(); layout.addWidget(self.size_label)
        self.size_slider=QSlider(Qt.Orientation.Horizontal); self.size_slider.setRange(60,200); self.size_slider.setValue(round(self.settings.pet_size/2.2)); layout.addWidget(self.size_slider)
        self.size_slider.valueChanged.connect(self.change_size)
        action=QWidgetAction(self.menu); action.setDefaultWidget(holder); self.menu.addAction(action)
        self.menu.addAction('生活状态',self.show_life)
        self.menu.addSeparator(); self.menu.addAction('退出桌宠',self.shutdown)
        if not self.options.no_tray and QSystemTrayIcon.isSystemTrayAvailable():
            self.tray=QSystemTrayIcon(QIcon(str(ASSETS/'sprites/runtime/idle/frame_00.png')),self)
            self.tray.setToolTip('PPA · 点击桌宠聊天'); self.tray.setContextMenu(self.menu)
            self.tray.activated.connect(lambda reason:self.reveal() if reason==QSystemTrayIcon.ActivationReason.DoubleClick else None)
            self.tray.show()

    def sync_menu(self):
        self.menu_open=True
        self.size_label.setText(f'大小 {round(self.settings.pet_size/2.2)}%')
        self.actions['quiet_mode'].setChecked(self.settings.quiet_mode)
        self.actions['mute'].setChecked(not self.settings.sound_enabled)
        self.actions['initiative_off'].setChecked(self.pref.get('initiative_off',False))

    def toggle(self,name,checked):
        if name=='initiative_off':self.pref[name]=checked
        elif name=='mute':
            self.settings.sound_enabled=not checked
            if checked:self.voice.stop()
        else:self.engine.set_mode(name,checked)
        self.save()

    def reveal(self):
        self.command('home'); self.show_panel()

    def anchored_position(self, widget, gap=8):
        screen=self.screen().availableGeometry()
        pet=self.frameGeometry()
        x=pet.center().x()-widget.width()//2
        y=pet.top()-widget.height()-gap
        x=max(screen.left()+6,min(x,screen.right()-widget.width()-6))
        if y<screen.top()+6:
            y=min(screen.bottom()-widget.height()-6,pet.bottom()+gap)
        return x,y

    def position_overlays(self):
        if self.quick_input.isVisible():self.quick_input.move(*self.anchored_position(self.quick_input,6))
        if self.head_bubble.isVisible():
            x,y=self.anchored_position(self.head_bubble,6)
            if self.quick_input.isVisible():
                screen=self.screen().availableGeometry()
                above=self.quick_input.y()-self.head_bubble.height()-6
                if above>=screen.top()+6:y=above
            self.head_bubble.move(x,y)

    def show_quick_input(self):
        if self.shutting_down:return
        self.head_bubble.hide()
        self.speech_until=0;self.protected_until=0;self.mirrored_speech=self.speech
        self.quick_input.open()
        self.position_overlays()
        if self.engine.state not in {'drag','fall','climb','slide','sleep','wake','landing'}:self.engine.idle()

    def quick_send(self,text):
        from .companion import local_command
        command=local_command(text)
        if command:
            self.command(command)
            return
        self.quick_turn=True;self.reply_stream='';self.protected_until=0
        self.panel.line('你',text)
        def sent(result,error):
            if error:
                self.quick_turn=False
                self.quick_input.open(text)
                self.bubble('没有发出去，输入已经替你保留。',8,True)
        self.bridge.request('send',{'text':text},sent)

    def show_panel(self):
        if not self.panel:return
        screen=self.screen().availableGeometry()
        x=max(screen.left(),min(self.x()-self.panel.width()-12,screen.right()-self.panel.width()))
        y=max(screen.top(),min(self.y(),screen.bottom()-self.panel.height()))
        self.panel.move(x,y); self.panel.show(); self.panel.raise_(); self.panel.activateWindow(); self.panel.input.setFocus()

    def panel_visible(self,visible):
        if visible and self.engine.state not in {'drag','fall','climb','slide','sleep','wake','landing'}:self.engine.idle()

    def command(self,cmd):
        self.actions_queue.put('user',cmd,10)

    def apply_command(self,cmd):
        self.user_until=time.monotonic()+5
        self.engine.demo=False
        if cmd=='home':self.engine.home(windows.cursor())
        elif cmd=='sleep':self.engine.sleep()
        elif cmd=='wake':self.engine.wake()
        elif cmd=='feed':self.treat()
        elif cmd=='hug':self.engine.begin_hand('hug')
        elif cmd in {'hop','roll'}:self.engine.do_action(cmd)
        self.bubble({'home':'我回来啦。','sleep':'那我眯一会儿。','wake':'我醒啦。','feed':'谢谢你的点心！','hug':'抱住你啦。','hop':'看我跳一下！','roll':'滚一圈～'}.get(cmd,''),3)
        self.voice.play('Positive',1,8)

    def bubble(self,text,seconds=4,protect=False):
        now=time.monotonic()
        if now<self.protected_until and not protect:return
        full=str(text);self.speech=full[:26]; self.speech_until=now+seconds
        self.mirrored_speech=self.speech
        if hasattr(self,'head_bubble'):
            self.head_bubble.show_text(full)
            self.position_overlays()
        if protect:self.protected_until=now+seconds

    def receive(self,event,data):
        if self.panel:self.panel.receive(event,data)
        if event in {'ready','status'}:
            if data and data.get('busy') and not self.state.get('busy'):
                self.tool_failed=False; self.actions_queue.put('status','thinking',3)
            self.state=data or {}
            if self.tray:self.tray.setToolTip(self.state.get('name','PPA')+' · 点击桌宠聊天')
            if self.state.get('pending'):
                self.bubble('有一项操作需要你确认。',3600,True)
            elif self.protected_until>time.monotonic()+60:
                self.protected_until=0; self.speech_until=0
        elif event=='thinking':self.actions_queue.put('status','thinking',3)
        elif event=='phase':
            phase=(data or {}).get('phase')
            if phase=='thinking':self.actions_queue.put('status','thinking',3)
            elif phase=='tool':self.actions_queue.put('status','working',3)
        elif event=='text':
            self.reply_stream+=str(data)
            self.speech_until=time.monotonic()+3600
            self.protected_until=self.speech_until
            self.speech=self.reply_stream[:26];self.mirrored_speech=self.speech
            # Approval remains the highest-priority user-facing state. Preserve
            # streamed text for display as soon as the approval is resolved.
            if not self.state.get('pending'):
                self.head_bubble.show_text(self.reply_stream)
                self.position_overlays()
        elif event=='tool':
            self.actions_queue.put('status','working',3)
            if data.get('status')=='error':
                self.tool_failed=True;self.bubble('遇到一点问题，点我查看。',10,True)
        elif event=='approval':self.bubble('有一项操作需要你确认。',3600,True)
        elif event=='done':
            self.protected_until=0
            if self.tool_failed or data and (data.get('error') or any(x in str(data.get('reason','')) for x in ['error','fail'])):
                self.bubble('这次没有完成，点我看原因。',12,True)
            elif data and any(x in str(data.get('reason','')) for x in ['interrupt','abort','cancel']):self.bubble('已停下，等你下一步。',5,True)
            elif data and data.get('reason')=='end_turn':
                self.actions_queue.put('status','complete',3)
                if self.reply_stream:
                    seconds=max(7,min(22,5+len(self.reply_stream)/14))
                    self.bubble(self.reply_stream,seconds,True)
                else:self.bubble('处理好了，点我看看。',5,True)
            else:self.bubble('这一轮已结束，点我查看。',5,True)
            self.quick_turn=False;self.reply_stream=''
        elif event in {'error','notice'}:self.bubble('有个提示，点我查看。',12,True)
        elif event=='disconnected':
            self.state.update(busy=False,online=False,pending=[]); self.actions_queue.items.clear()
            self.quick_turn=False;self.reply_stream=''
            if not self.shutting_down:self.bubble('后台已断开，可以重新连接。',12,True)

    def allow_local_cue(self,event):
        return time.monotonic()<self.user_until and time.monotonic()>=self.protected_until

    def tick(self):
        now=time.monotonic()
        if self.options.report:self.frame_times.append(now-self.last_metrics)
        self.last_metrics=now
        if self.shutting_down:return
        engine=self.engine
        unsafe=engine.state in {'drag','fall','climb','slide','landing'}
        action=self.actions_queue.take(unsafe or self.menu_open)
        if action:
            kind,value=action
            if kind=='user':self.apply_command(value)
            elif now>=self.user_until and engine.state not in {'sleep','wake','chomp','satisfied','hand'}:
                if value=='complete':engine.enter('satisfied','satisfied_quick'); self.feedback_until=now+1.5
                else:engine.duration=2; engine.enter('curious','curious')
        hold=(self.panel and self.panel.isVisible()) or self.state.get('busy') or self.settings.quiet_mode
        if hold and now>=self.user_until and now>=self.feedback_until:
            engine.next_decision=engine.now+5; engine.next_name=engine.now+5
            if engine.state in {'move','roll','hand'}:engine.idle()
        if now>=self.next_initiative:
            self.next_initiative=now+1
            blocked=bool(hold or self.state.get('pending') or engine.state in {'sleep','wake','drag'} or self.pref.get('initiative_off') or now<self.protected_until)
            message=self.initiative.consider(time.time(),windows.idle_seconds(),blocked)
            if message:self.bubble(message); self.save()
        super().tick()
        if self.speech and self.speech != self.mirrored_speech and now < self.speech_until:
            self.mirrored_speech=self.speech
            self.head_bubble.show_text(self.speech)
        if now >= self.speech_until and self.head_bubble.isVisible():self.head_bubble.hide()
        self.position_overlays()
        if self.options.report and now>=self.next_sample:
            self.next_sample=now+30
            try:
                import psutil
                process=psutil.Process()
                self.samples.append({'seconds':round(now-self.started,1),'rss':process.memory_info().rss,'cpu_seconds':sum(process.cpu_times()[:2]),'ticks':self.stats['ticks']})
            except ImportError:pass
            if self.options.report:self.write_report()

    def mousePressEvent(self,event):
        if event.button()==Qt.MouseButton.LeftButton:
            self.press=windows.cursor(); self.grabMouse(); event.accept()
        else:super().mousePressEvent(event)

    def mouseMoveEvent(self,event):
        if self.press and self.engine.state!='drag' and is_drag(self.press,windows.cursor(),8*self.devicePixelRatioF()):
            self.engine.pick_up(*self.press); self.user_until=time.monotonic()+4
        if self.engine.state=='drag':self.engine.drag_to(*windows.cursor())

    def mouseReleaseEvent(self,event):
        if event.button()==Qt.MouseButton.LeftButton and self.press:
            self.releaseMouse(); self.press=None
            if self.engine.state=='drag':self.engine.release(*windows.cursor())
            else:self.show_quick_input()
            event.accept()
        else:super().mouseReleaseEvent(event)

    def save(self):
        if self.save_future and not self.save_future.done():return
        self.settings.normalize(); self.life.normalize(); self.life.last_updated_utc=time.time()
        self.pref['initiative']=self.initiative.saved
        snapshot={'settings.json':asdict(self.settings),'life-state.json':asdict(self.life),'preferences.json':json.loads(json.dumps(self.pref)),'position.json':{'x':self.engine.x,'y':self.engine.y}}
        directory=self.store.directory
        def write():
            for name,value in snapshot.items():
                path=directory/name; temporary=path.with_suffix('.tmp')
                temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8'); temporary.replace(path)
        self.save_future=self.writer.submit(write)

    def write_report(self):
        times=sorted(self.frame_times)
        report={'status':'RUNNING' if not self.closed else 'COMPLETED','seconds':time.monotonic()-self.started,'ticks':self.stats['ticks'],'errors':self.stats['errors'],'audio_errors':self.voice.errors,'states':self.stats['states'],'frames':len(self.stats['frames']),'frame_ms':{'median':times[len(times)//2]*1000 if times else 0,'p95':times[int(len(times)*.95)]*1000 if times else 0,'max':max(times,default=0)*1000},'samples':list(self.samples),'monitors':len(self.engine.monitors),'privacy':{'titles':False,'desktop_icons':False,'watchers':False,'screenshots':False}}
        path=Path(self.options.report); path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')

    def shutdown(self):
        if self.shutting_down:return
        if self.panel and getattr(self.panel,'memory_editor',None) and self.panel.memory_editor.isVisible():
            self.panel.memory_editor.reject()
            if self.panel.memory_editor.isVisible():return
        self.shutting_down=True; self.timer.stop(); self.voice.stop()
        if self.panel:self.panel.hide()
        if hasattr(self,'quick_input'):self.quick_input.hide()
        if hasattr(self,'head_bubble'):self.head_bubble.hide()
        self.bubble('正在保存并退出…',30,True)
        if self.bridge and not self.options.no_backend:
            self.bridge.shutdown()
            QTimer.singleShot(15000,self.slow_shutdown)
        else:self.finish_shutdown()

    def slow_shutdown(self):
        if not self.closed:
            self.show(); self.bubble('后台仍在退出，保留锁等待清理。',60,True)
            log.warning('Backend shutdown is taking longer than 15 seconds; retaining ownership')

    def bridge_ended(self):
        if self.shutting_down:self.finish_shutdown()

    def finish_shutdown(self):
        if self.closed:return
        if self.save_future:self.save_future.result(timeout=5)
        self.save()
        self.writer.shutdown(wait=True)
        self.closed=True
        if self.tray:self.tray.hide()
        self.quick_input.close();self.head_bubble.close()
        for ghost in self.ghosts.values():ghost.close()
        if self.options.report:self.write_report()
        self.close(); QApplication.quit()


def run(options):
    windows.enable_dpi_awareness()
    app=QApplication(sys.argv[:1]); app.setApplicationName('PPA桌宠'); app.setQuitOnLastWindowClosed(False)
    data=Path(options.data_dir or os.environ.get('PPA_DATA_DIR',str(ROOT.parent/'.ppa'))).resolve()
    store=Store(data/'pet')
    handler=RotatingFileHandler(store.directory/'pet.log',maxBytes=2_000_000,backupCount=2,encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    logging.getLogger().setLevel(logging.DEBUG if options.debug else logging.INFO); logging.getLogger().addHandler(handler)
    name='PpaPet-'+hashlib.sha256(str(data).casefold().encode()).hexdigest()[:16]
    lock=QLockFile(str(store.directory/'instance.lock')); lock.setStaleLockTime(0)
    if not lock.tryLock(50):
        client=QLocalSocket(); client.connectToServer(name)
        if client.waitForConnected(1500):
            client.write(b'show\n'); client.waitForBytesWritten(1000); return 0
        return 2
    server=QLocalServer(); server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption); QLocalServer.removeServer(name)
    if not server.listen(name):raise RuntimeError(server.errorString())
    pet=PetWindow(store,options)
    sockets=[]
    def connect():
        client=server.nextPendingConnection(); sockets.append(client)
        def read():
            if b'show' in bytes(client.readAll()):pet.reveal()
            client.disconnectFromServer()
        client.readyRead.connect(read)
        client.disconnected.connect(lambda:(sockets.remove(client) if client in sockets else None,client.deleteLater()))
        if client.bytesAvailable():read()
    server.newConnection.connect(connect)
    if options.quit_after:QTimer.singleShot(round(options.quit_after*1000),pet.shutdown)
    if options.screenshot:
        def capture():
            target=Path(options.screenshot); target.parent.mkdir(parents=True,exist_ok=True); pet.grab().save(str(target))
            if options.chat:pet.panel.grab().save(str(target.with_name(target.stem+'-chat.png')))
        QTimer.singleShot(1500,capture)
    if options.exercise:
        for delay,command in [(2,'feed'),(7,'hop'),(11,'home'),(14,'sleep'),(19,'wake'),(23,'roll')]:QTimer.singleShot(delay*1000,lambda c=command:pet.command(c))
    result=app.exec(); server.close(); lock.unlock(); return result
