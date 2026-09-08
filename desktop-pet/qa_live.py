"""Drive our own Qt widgets against the isolated live-smoke identity."""
from pathlib import Path
from types import SimpleNamespace
import json
import sys
import time
from PySide6.QtCore import QTimer, Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QPushButton
from nuonuo.app import PetWindow, ROOT
from nuonuo.model import Store
from nuonuo import windows

root=ROOT.parent
proof=json.loads((root/'.ppa/reports/pet-live.json').read_text(encoding='utf-8'))
data=Path(proof['data']).resolve()
assert data.parent==root/'.ppa' and data.name.startswith('pet-live-'), 'QA requires the isolated live-smoke directory'
report={'status':'RUNNING','data':str(data),'checks':[],'responses':[]}
report_path=root/'.ppa/reports/pet-gui-live.json'
def save():report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
def passed(name):report['checks'].append(name);save();print('PASS',name,flush=True)
windows.enable_dpi_awareness()
app=QApplication([]);app.setQuitOnLastWindowClosed(False)
options=SimpleNamespace(mute=True,quiet=False,no_tray=False,debug=False,no_backend=False,chat=False,seed=3,report=None)
pet=PetWindow(Store(data/'pet'),options)
stage=0;reply='';started=0;start_ticks=0;stopping=False
target=data/'workspace/gui-live-proof.txt'
def send(text,image=None,quick=False):
    global reply,started,start_ticks
    reply='';started=time.monotonic();start_ticks=pet.stats['ticks']
    if quick:
        pet.show_quick_input();pet.quick_input.input.setText(text)
        QTest.keyClick(pet.quick_input.input,Qt.Key.Key_Return)
    else:
        if not pet.panel.isVisible():pet.show_panel()
        pet.panel.input.setPlainText(text)
        if image:pet.panel.image_path=str(image)
        QTest.mouseClick(pet.panel.send_button,Qt.MouseButton.LeftButton)
def next_stage():
    if stage==0:send('请只回复：你好',quick=True)
    elif stage==1:send('图片里的头发是什么颜色？请简短回答。',root/'nuonuo_dev_assets/assets/sprites/runtime/idle/frame_00.png')
    elif stage==2:send(f'请用 Write 工具把 GUI_APPROVED 写入 {target}。必须实际写入，不要只回复。')
    elif stage==3:send('请写一篇非常长的中文故事，至少三千字，从第一句开始直接输出。')
def event(kind,value):
    global stage,reply,stopping
    try:
        if kind=='ready':
            passed('QProcess_ready');QTimer.singleShot(2000,next_stage)
        elif kind=='text':
            reply+=str(value)
            if stage==3 and not stopping:
                stopping=True;pet.bridge.request('stop')
        elif kind=='approval':
            approved=stage==2 and str(value['args'].get('file_path','')).replace('\\','/').casefold()==str(target).replace('\\','/').casefold()
            if not approved:pet.panel.approve(False);return
            button=next(b for b in pet.panel.approval.findChildren(QPushButton) if b.text()=='允许本次')
            QTest.mouseClick(button,Qt.MouseButton.LeftButton);passed('GUI_approval_clicked')
        elif kind=='done':
            report['responses'].append({'stage':stage,'text':reply[:500],'reason':value,'seconds':time.monotonic()-started,'animation_ticks':pet.stats['ticks']-start_ticks})
            assert pet.stats['ticks']>start_ticks+5
            assert not value.get('error'),str(value)
            if stage==0:
                assert '你好' in reply and not pet.panel.isVisible()
                assert pet.head_bubble.isVisible() and '你好' in pet.head_bubble.label.text()
                passed('GUI_quick_chat_without_panel_and_head_bubble')
            elif stage==1:assert any(x in reply for x in ['灰','白','银','绿','蓝']);passed('GUI_image_and_visual_answer')
            elif stage==2:assert target.read_text(encoding='utf-8').strip()=='GUI_APPROVED';passed('GUI_approved_file_verified')
            elif stage==3:
                assert any(x in str(value.get('reason','')) for x in ['cancel','abort','interrupt']);passed('GUI_stop_without_replay')
                report['status']='PASSED';save()
                pet.panel.grab().save(str(root/'.ppa/reports/pet-gui-live.png'))
                pet.grab().save(str(root/'.ppa/reports/pet-gui-character.png'))
                QTimer.singleShot(500,pet.shutdown);return
            stage+=1;QTimer.singleShot(1000,next_stage)
        elif kind=='error':raise RuntimeError(str(value))
    except Exception as exc:
        report['status']='FAILED';report['error']=repr(exc);save();pet.shutdown()
pet.bridge.event.connect(event)
def timeout():
    if report['status']=='RUNNING':report.update(status='FAILED',error='GUI smoke timeout');save();pet.shutdown()
QTimer.singleShot(420000,timeout)
app.exec()
raise SystemExit(0 if report['status']=='PASSED' else 1)
