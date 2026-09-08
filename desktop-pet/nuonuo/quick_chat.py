"""Small, non-modal desktop chat controls anchored to the pet."""
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QKeyEvent
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QLineEdit, QPushButton, QVBoxLayout, QWidget


class QuickLineEdit(QLineEdit):
    cancelled = Signal()

    def keyPressEvent(self, event: QKeyEvent):
        if event.key() == Qt.Key.Key_Escape:
            self.cancelled.emit()
            event.accept()
            return
        super().keyPressEvent(event)


class QuickInput(QWidget):
    submitted = Signal(str)

    def __init__(self, parent=None):
        super().__init__(None, Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setWindowTitle('和桌宠说话')
        self.setFixedWidth(350)
        frame = QFrame(self)
        frame.setObjectName('quickFrame')
        frame.setStyleSheet('''
            QFrame#quickFrame { background: rgba(255,250,245,248); border: 1px solid #dfc9c9; border-radius: 15px; }
            QLineEdit { background: transparent; border: 0; color: #493d43; font: 10pt "Microsoft YaHei UI"; padding: 7px 5px; }
            QPushButton { background: #805865; color: white; border: 0; border-radius: 9px; padding: 7px 12px; font: 9pt "Microsoft YaHei UI"; }
            QPushButton:hover { background: #936b77; }
        ''')
        row = QHBoxLayout(frame)
        row.setContentsMargins(11, 7, 8, 7)
        row.setSpacing(5)
        self.input = QuickLineEdit()
        self.input.setPlaceholderText('直接和我说话…')
        self.send_button = QPushButton('发送')
        row.addWidget(self.input, 1)
        row.addWidget(self.send_button)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(frame)
        self.input.returnPressed.connect(self.submit)
        self.input.cancelled.connect(self.hide)
        self.send_button.clicked.connect(self.submit)
        self.adjustSize()

    def open(self, initial=''):
        if initial:
            self.input.setText(initial)
        self.show()
        self.raise_()
        self.activateWindow()
        self.input.setFocus()
        self.input.selectAll()

    def submit(self):
        text = self.input.text().strip()
        if not text:
            return
        self.input.clear()
        self.hide()
        self.submitted.emit(text)


class HeadBubble(QWidget):
    def __init__(self, parent=None):
        super().__init__(None, Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.WindowDoesNotAcceptFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        frame = QFrame(self)
        frame.setObjectName('bubbleFrame')
        frame.setStyleSheet('QFrame#bubbleFrame { background: rgba(255,251,248,246); border: 1px solid #dfc9c9; border-radius: 14px; }')
        layout = QVBoxLayout(frame)
        layout.setContentsMargins(14, 10, 14, 10)
        self.label = QLabel()
        self.label.setTextFormat(Qt.TextFormat.PlainText)
        self.label.setWordWrap(True)
        self.label.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        self.label.setStyleSheet('color: #57454d; font: 10pt "Microsoft YaHei UI"; background: transparent; border: 0;')
        self.label.setMinimumWidth(90)
        self.label.setMaximumWidth(310)
        layout.addWidget(self.label)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(frame)

    @staticmethod
    def compact(text):
        text = str(text).strip()
        if len(text) <= 300:
            return text
        return text[:125].rstrip() + '\n…\n' + text[-155:].lstrip()

    def show_text(self, text):
        text = self.compact(text)
        if not text:
            self.hide()
            return
        self.label.setText(text)
        self.label.setFixedWidth(min(310, max(90, self.label.fontMetrics().horizontalAdvance(max(text.splitlines(), key=len, default='')) + 8)))
        self.label.adjustSize()
        self.adjustSize()
        self.show()
        self.raise_()
