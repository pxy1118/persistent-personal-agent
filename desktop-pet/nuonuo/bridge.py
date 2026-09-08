"""Asynchronous JSON-lines transport. Never waits for a model on the Qt thread."""
import json
import logging
import os
import shutil
from PySide6.QtCore import QObject, QProcess, QProcessEnvironment, Signal, QTimer

log = logging.getLogger(__name__)

class Bridge(QObject):
    event = Signal(str, object)
    ended = Signal()

    def __init__(self, root, data, parent=None):
        super().__init__(parent)
        self.root, self.data = root, data
        self.process = QProcess(self)
        self.process.setWorkingDirectory(str(root))
        env = QProcessEnvironment.systemEnvironment()
        env.insert('PPA_DATA_DIR', str(data))
        self.process.setProcessEnvironment(env)
        self.process.readyReadStandardOutput.connect(self.read)
        self.process.readyReadStandardError.connect(self.errors)
        self.process.finished.connect(self.finished)
        self.process.errorOccurred.connect(lambda e:self.event.emit('error', self.process.errorString()))
        self.buffer = bytearray()
        self.pending = {}
        self.sequence = 0
        self.closing = False

    def start(self):
        self.closing = False
        self.process.start(os.environ.get('PPA_NODE') or shutil.which('node') or 'node', ['--import','tsx',str(self.root/'src/pet-bridge.ts')])

    def request(self, method, params=None, callback=None):
        if self.process.state() != QProcess.ProcessState.Running:
            self.event.emit('error', '后台未连接。请使用重新连接。')
            if callback: callback(None, '后台未连接')
            return
        if len(self.pending) >= 32 or self.process.bytesToWrite() > 2*1024*1024:
            self.event.emit('error', '操作过于频繁，请稍候。')
            if callback: callback(None, '操作过于频繁')
            return
        self.sequence += 1
        key = str(self.sequence)
        timer = QTimer(self)
        timer.setSingleShot(True)
        def timeout():
            item = self.pending.pop(key, None)
            timer.deleteLater()
            if item:
                self.event.emit('error', '后台操作超时；不会自动重发。')
                if callback: callback(None, '后台操作超时')
        timer.timeout.connect(timeout)
        timer.start(120000)
        self.pending[key] = (callback, timer)
        self.process.write((json.dumps({'id':key,'method':method,'params':params or {}},ensure_ascii=False)+'\n').encode('utf-8'))

    def read(self):
        self.buffer.extend(bytes(self.process.readAllStandardOutput()))
        if len(self.buffer) > 16*1024*1024:
            self.event.emit('error', '后台消息超过上限。')
            self.shutdown()
            return
        # Yield between batches so bursts cannot monopolize animation/input.
        for _ in range(64):
            end = self.buffer.find(b'\n')
            if end < 0: break
            line = bytes(self.buffer[:end]); del self.buffer[:end+1]
            try:
                value = json.loads(line)
                if 'event' in value: self.event.emit(value['event'], value.get('data'))
                else:
                    callback, timer = self.pending.pop(value.get('id'), (None,None))
                    if timer: timer.stop(); timer.deleteLater()
                    if value.get('error'): self.event.emit('error', value['error'])
                    if callback: callback(value.get('result'),value.get('error'))
            except (ValueError, TypeError):
                log.exception('Invalid bridge message')
                self.event.emit('error','后台消息格式错误。')
        if b'\n' in self.buffer: QTimer.singleShot(0,self.read)

    def errors(self):
        log.warning('%s', bytes(self.process.readAllStandardError()).decode('utf-8',errors='replace').strip())

    def finished(self, *args):
        for callback, timer in list(self.pending.values()):
            timer.stop(); timer.deleteLater()
            if callback: callback(None,'后台已退出')
        self.pending.clear()
        self.buffer.clear()
        self.event.emit('disconnected', None)
        self.ended.emit()

    def shutdown(self):
        if self.closing: return
        self.closing = True
        if self.process.state() == QProcess.ProcessState.NotRunning:
            self.ended.emit()
            return
        self.request('shutdown')
        self.process.closeWriteChannel()
