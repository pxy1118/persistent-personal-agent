"""Real Qt widgets; input-method commits are simulated, not a claim of OS IME QA."""
from types import SimpleNamespace
import time
from PySide6.QtCore import Qt, QPoint
from PySide6.QtGui import QInputMethodEvent
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication
from nuonuo.app import PetWindow
from nuonuo.model import Store
from nuonuo import windows

def test_widget_input_approval_priority_and_lifecycle(tmp_path,monkeypatch):
    app=QApplication.instance() or QApplication([])
    app.setQuitOnLastWindowClosed(False)
    options=SimpleNamespace(mute=True,quiet=False,no_tray=True,debug=False,no_backend=True,chat=False,seed=3,report=None)
    pet=PetWindow(Store(tmp_path/'pet'),options)
    try:
        panel=pet.panel
        calls=[]
        def request(method,params=None,callback=None):
            calls.append((method,params))
            if callback:callback({'busy':False},None)
        monkeypatch.setattr(pet.bridge,'request',request)
        # A click opens only the compact input; a drag opens neither interface.
        pointer=[(100,100)]
        monkeypatch.setattr(windows,'cursor',lambda:pointer[0])
        QTest.mouseClick(pet,Qt.MouseButton.LeftButton,pos=QPoint(120,140))
        assert pet.quick_input.isVisible() and not panel.isVisible()
        pet.quick_input.hide(); assert not panel.isVisible() and not pet.closed
        QTest.mousePress(pet,Qt.MouseButton.LeftButton,pos=QPoint(120,140))
        pointer[0]=(150,150)
        QTest.mouseMove(pet,QPoint(150,170))
        assert pet.engine.state=='drag'
        QTest.mouseRelease(pet,Qt.MouseButton.LeftButton,pos=QPoint(150,170))
        assert not panel.isVisible() and not pet.quick_input.isVisible()
        pet.engine.home((100,100)); pet.show_panel()
        # IME commit carries Chinese as one committed event.
        committed=QInputMethodEvent(); committed.setCommitString('你好，今天一起做点什么？')
        QApplication.sendEvent(panel.input,committed)
        assert panel.input.toPlainText()=='你好，今天一起做点什么？'
        QTest.keyClick(panel.input,Qt.Key.Key_Return)
        assert calls[-1]==('send',{'text':'你好，今天一起做点什么？'})
        approval={'id':'a1','tool':'Write','args':{'file_path':'example.txt','content':'你好'}}
        pet.receive('approval',approval)
        assert panel.approval.isVisible() and 'example.txt' in panel.arguments.toPlainText()
        pet.bubble('低优先级的搭话')
        assert '确认' in pet.speech
        panel.approve(False)
        assert calls[-1]==('approve',{'id':'a1','allow':False})
        pet.receive('status',{'name':'糯糯','online':True,'modelReady':True,'model':'本地模型','busy':True,'pending':[approval],'mode':'standard'})
        assert panel.mode.isEnabled()
        pet.receive('mode','unrestricted')
        assert panel.mode.currentData()=='unrestricted'
        panel.input.setPlainText('不能排队'); panel.send()
        assert calls[-1][0]=='approve'
        pet.receive('text','你好，');pet.receive('text','已经收到。')
        QTest.qWait(60)
        assert '你好，已经收到。' in panel.history.toPlainText()
        assert pet.head_bubble.isVisible()
        assert '确认' in pet.head_bubble.label.text()
        pet.receive('done',{'reason':'cancelled'})
        assert not any(value[1]=='complete' for value in pet.actions_queue.items.values())
        pet.receive('disconnected',None)
        assert not panel.pending and not pet.state['busy']
        # Rendering continues while waiting on a model/approval.
        start=pet.stats['ticks'];QTest.qWait(200)
        assert pet.stats['ticks']-start >= 5
        assert not pet.stats['errors']
    finally:
        pet.shutdown()
    assert pet.closed
    assert (tmp_path/'pet/settings.json').exists()
    assert (tmp_path/'pet/position.json').exists()

def test_quick_chat_sends_without_opening_panel_and_preserves_failed_input(tmp_path,monkeypatch):
    app=QApplication.instance() or QApplication([])
    app.setQuitOnLastWindowClosed(False)
    options=SimpleNamespace(mute=True,quiet=False,no_tray=True,debug=False,no_backend=True,chat=False,seed=3,report=None)
    pet=PetWindow(Store(tmp_path/'pet'),options)
    calls=[]
    try:
        def request(method,params=None,callback=None):
            calls.append((method,params))
            if callback:callback(None,'模型暂时离线')
        monkeypatch.setattr(pet.bridge,'request',request)
        pet.show_quick_input()
        pet.quick_input.input.setText('在桌面上直接聊天')
        QTest.keyClick(pet.quick_input.input,Qt.Key.Key_Return)
        assert calls==[('send',{'text':'在桌面上直接聊天'})]
        assert not pet.panel.isVisible()
        assert pet.quick_input.isVisible()
        assert pet.quick_input.input.text()=='在桌面上直接聊天'
        assert '没有发出去' in pet.head_bubble.label.text()
        pet.quick_input.hide()
        pet.receive('text','这是一段很长的回复。'*40)
        assert len(pet.head_bubble.label.text()) <= 305
        assert '\n…\n' in pet.head_bubble.label.text()
    finally:pet.shutdown()
