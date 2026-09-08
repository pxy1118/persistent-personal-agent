"""Short-lived owned window for the native integration test."""
import json
import sys
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import QApplication, QWidget, QLabel, QVBoxLayout

app = QApplication([])
window = QWidget()
window.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
window.setWindowTitle('Nuonuo Python integration test platform')
window.resize(600, 420)
window.move(200, 300)
layout = QVBoxLayout(window)
layout.addWidget(QLabel('糯糯桌宠：自动测试用窗口，将自动关闭。'))
window.show()
app.processEvents()
print(json.dumps({'handle': int(window.winId())}), flush=True)
QTimer.singleShot(8000, app.quit)
sys.exit(app.exec())
