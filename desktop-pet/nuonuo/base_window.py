from __future__ import annotations

from collections import OrderedDict
from dataclasses import asdict
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import math
import os
from pathlib import Path
import queue
import sys
import time

from PySide6.QtCore import Qt, QTimer, QRectF, QPoint, QUrl, QLockFile, QFileInfo
from PySide6.QtGui import QPainter, QColor, QPixmap, QIcon, QFont, QAction, QDesktopServices
from PySide6.QtWidgets import QApplication, QWidget, QMenu, QSystemTrayIcon, QWidgetAction, QSlider, QLabel, QVBoxLayout, QFileIconProvider, QMessageBox
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from .model import Store, Settings, LifeState, Meal, clamp, ghost_anchor
from .engine import PetEngine, smooth
from .services import Dialogue, Voice
from . import windows

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT.parent / 'nuonuo_dev_assets/assets'
log = logging.getLogger(__name__)


class Ghost(QWidget):
    def __init__(self, meal, fallback):
        super().__init__(None, Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.WindowTransparentForInput | Qt.WindowType.WindowDoesNotAcceptFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.resize(112, 96)
        self.meal = meal
        self.icon = meal.icon if meal.icon is not None and not meal.icon.isNull() else fallback
        self.amount = self.opacity = 1.
        self.angle = 0.
        self.show()

    def place(self, x, y, amount=1., opacity=1., angle=0.):
        self.amount, self.opacity, self.angle = amount, opacity, angle
        factor = self.devicePixelRatioF()
        if windows.IS_WINDOWS: windows.place_window(int(self.winId()), x - 56 * factor, y - 38 * factor)
        else: self.move(round(x - 56), round(y - 38))
        self.update()

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        p.setOpacity(self.opacity * .9)
        p.translate(56, 38)
        p.rotate(self.angle)
        p.scale(self.amount, self.amount)
        p.drawPixmap(QRectF(-20, -20, 40, 40), self.icon, QRectF(self.icon.rect()))
        if self.amount > .8:
            p.setFont(QFont('Microsoft YaHei UI', 8))
            label = p.fontMetrics().elidedText('小点心' if self.meal.source == 'virtual' else self.meal.name, Qt.TextElideMode.ElideMiddle, 106)
            p.setPen(QColor('#17212b'))
            p.fillRect(QRectF(-54, 24, 108, 22), QColor(255, 255, 255, 205))
            p.drawText(QRectF(-54, 24, 108, 22), Qt.AlignmentFlag.AlignCenter, label)


class PetWindow(QWidget):
    def __init__(self, store, options):
        super().__init__(None, Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.WindowDoesNotAcceptFocus)
        self.setWindowTitle('糯糯 · Python 桌宠')
        self.setObjectName('NuonuoPythonPet')
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.setMouseTracking(True)
        self.store, self.options = store, options
        self.settings = store.load('settings.json', Settings)
        self.life = store.load('life-state.json', LifeState)
        self.life.advance(max(0, time.time() - self.life.last_updated_utc))
        if options.mute: self.settings.sound_enabled = False
        if options.quiet: self.settings.quiet_mode = True
        self.engine = PetEngine(ROOT / 'data/animation_clips.json', self.settings, self.life, options.seed)
        self.dialogue = Dialogue(ROOT / 'data/dialogue.json', options.seed)
        self.voice = Voice(ASSETS / 'audio/voice', ROOT / 'data/voices.json', self.settings, self)
        self.images = OrderedDict()
        # Decode the finite sprite set once, before starting the animation timer.
        for folder in (ASSETS / 'sprites/runtime').iterdir():
            if folder.is_dir():
                for path in folder.glob('frame_*.png'):
                    key = path.relative_to(ASSETS).as_posix()
                    self.images[key] = QPixmap(str(path))
        self.speech, self.speech_until = '', 0.
        self.ghosts = {}
        self.stats = dict(ticks=0, states={}, frames=set(), errors=[])
        self.last_tick = time.monotonic()
        self.next_world = self.next_icons = self.next_save = 0.
        self.closed = False
        self.menu_open = False
        self.active_screen = None
        self.default_icon = QFileIconProvider().icon(QFileIconProvider.IconType.File).pixmap(40, 40)
        self.resize_pet()
        self.tray = None
        self.make_menu()
        self.show()
        self.refresh_world()
        self.engine.home(windows.cursor())
        self.engine.emit('Startup', 'Neutral', 0, 12)
        self.position_window()
        self.timer = QTimer(self)
        self.timer.setTimerType(Qt.TimerType.PreciseTimer)
        self.timer.timeout.connect(self.tick)
        self.timer.start(16)
        QApplication.instance().screenAdded.connect(lambda s: self.refresh_world())
        QApplication.instance().screenRemoved.connect(lambda s: self.refresh_world())
        for screen in QApplication.screens():
            screen.availableGeometryChanged.connect(lambda r: self.refresh_world())

    def frame_image(self):
        key = self.engine.animator.path
        image = self.images.pop(key, None)
        if image is None:
            image = QPixmap(str(ASSETS / key))
            if image.isNull(): raise RuntimeError(f'Cannot load sprite: {key}')
        self.images[key] = image
        while len(self.images) > 288: self.images.popitem(last=False)
        return image

    def resize_pet(self):
        size = self.settings.pet_size
        if self.engine.monitors:
            m = self.engine.monitor_at(self.engine.x, self.engine.y)
            size = max(96, min(size, min(m.work.width, m.work.height) * .78 / m.scale))
        self.draw_size = size
        self.engine.render_size = size
        self.resize(round(size + 40), round(size + 86))

    def position_window(self):
        engine = self.engine
        if engine.monitors:
            m = engine.monitor_at(engine.x, engine.y)
            # Select the target Qt screen first; native position still uses physical pixels.
            screen = next((s for s in QApplication.screens() if s.name() == m.name), None)
            if screen and screen != self.active_screen:
                self.windowHandle().setScreen(screen)
                self.active_screen = screen
                self.resize_pet()
            engine.scale = m.scale
        scale = self.devicePixelRatioF() if windows.IS_WINDOWS else 1.
        ax, ay = (20 + self.draw_size / 2) * scale, (50 + self.draw_size * 374 / 384) * scale
        if windows.IS_WINDOWS: windows.place_window(int(self.winId()), engine.x - ax, engine.y - ay)
        else: self.move(round(engine.x - ax), round(engine.y - ay))

    def refresh_world(self):
        now = time.monotonic()
        dt = now - getattr(self, 'last_world', now - .06)
        self.last_world = now
        monitors = windows.monitors()
        if not monitors: return
        bodies = windows.window_bodies()
        self.engine.set_world(monitors, windows.surfaces(monitors, bodies), bodies, max(.004, min(dt, .5)))

    def make_menu(self):
        self.menu = QMenu()
        self.actions = {}
        self.size_label = QLabel()

    def allow_local_cue(self, event):
        return False

    def change_size(self, value):
        self.settings.pet_size = value * 2.2
        self.size_label.setText(f'大小 {value}%')
        self.resize_pet()
        self.position_window()
        self.save()

    def show_life(self):
        l = self.life
        QMessageBox.information(self, '桌宠的生活状态', f'饥饿：{l.hunger:.1f}\n饱腹：{l.fullness:.1f}\n困倦：{l.sleepiness:.1f}\n好奇：{l.curiosity:.1f}\n累计进食：{l.total_meals}\n待吃点心：{len(self.engine.meals.pending)}')

    def treat(self):
        x, y = self.engine.anchor(45, 267)
        self.engine.accept_meal(Meal('treat.snack', x - 90, y, 'virtual', icon=self.default_icon))

    def demo_clip(self, name):
        self.engine.demo = True
        self.engine.meals.clear()
        self.engine.animator.play(name)
        self.engine.facing = 1
        self.engine.stretch_x = self.engine.stretch_y = 1
        self.engine.lean = 0
        self.speech, self.speech_until = name, time.monotonic() + 3

    def end_demo(self):
        self.engine.demo = False
        self.engine.idle()

    def tick(self):
        if self.closed: return
        try:
            now = time.monotonic()
            elapsed, self.last_tick = now - self.last_tick, now
            if now >= self.next_world and not self.engine.demo:
                self.refresh_world()
                self.next_world = now + .06
            pointer = windows.cursor()
            if self.engine.state == 'drag': self.engine.drag_to(*pointer)
            # Menus must remain still under the pointer while the user operates them.
            if not self.menu_open:
                self.engine.tick(elapsed, pointer)
            self.position_window()
            for event in self.engine.events:
                if 'state' in event:
                    log.debug('State %s -> %s', event['previous'], event['state'])
                if 'consumed' in event: log.info('Meal consumed: %s', Path(event['consumed']).name)
                text = event.get('text') or (self.dialogue.say(event['cue'], event.get('item')) if event.get('cue') else '')
                if text and self.allow_local_cue(event): self.speech, self.speech_until = text, now + 2.5
                if event.get('voice') and self.allow_local_cue(event): self.voice.play(event['voice'], event.get('priority', 1), event.get('cooldown', 8))
            self.engine.events.clear()
            self.sync_ghosts()
            self.update()
            self.stats['ticks'] += 1
            state = self.engine.state
            self.stats['states'][state] = self.stats['states'].get(state, 0) + 1
            self.stats['frames'].add((self.engine.animator.name, self.engine.animator.frame))
            if now >= self.next_save:
                self.save()
                self.next_save = now + 60
        except Exception as exc:
            log.exception('Main loop error')
            self.stats['errors'].append(str(exc))
            if len(self.stats['errors']) >= 3:
                self.shutdown()

    def sync_ghosts(self):
        engine = self.engine
        meals = list(engine.meals.pending)
        if engine.meals.active and not engine.meals.active.consumed: meals.append(engine.meals.active)
        active_ids = {id(m) for m in meals}
        for key in list(self.ghosts):
            if key not in active_ids: self.ghosts.pop(key).close()
        for meal in meals:
            key = id(meal)
            if key not in self.ghosts: self.ghosts[key] = Ghost(meal, self.default_icon)
            x, y, amount, opacity, angle = meal.x, meal.y, 1., 1., 0.
            if meal is engine.meals.active and engine.state == 'chomp':
                t = engine.elapsed
                if t <= .55:
                    x += math.sin(t / .55 * math.pi * 5) * 3 * engine.scale
                else:
                    u = smooth((t - .55) / .79)
                    tx, ty = engine.anchor(191, 304)
                    x += (tx - x) * u
                    y += (ty - y) * u
                    amount, opacity, angle = 1 - .96 * u, 1 - u ** 4, -12 * math.sin(u * math.pi)
            self.ghosts[key].place(x, y, amount, opacity, angle)

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        e, size = self.engine, self.draw_size
        foot = 50 + size * 374 / 384
        if e.support and e.state not in {'drag', 'fall', 'climb', 'slide'}:
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(40, 40, 45, 24))
            p.drawEllipse(QRectF(20 + size * .3, foot - size * .025, size * .4, size * .04))
        p.save()
        p.translate(20 + size / 2, foot)
        p.rotate(e.lean)
        p.scale(e.facing * e.stretch_x, e.stretch_y)
        image = self.frame_image()
        p.drawPixmap(QRectF(-size / 2, -size * 374 / 384, size, size), image, QRectF(image.rect()))
        p.restore()
        if getattr(self, 'draw_inline_bubble', True) and time.monotonic() < self.speech_until:
            p.setFont(QFont('Microsoft YaHei UI', 10))
            text_width = min(self.width() - 16, p.fontMetrics().horizontalAdvance(self.speech) + 28)
            bubble = QRectF((self.width() - text_width) / 2, 9, text_width, 30)
            p.setPen(QColor('#dfc9c9'))
            p.setBrush(QColor(255, 251, 248, 238))
            p.drawRoundedRect(bubble, 12, 12)
            p.setPen(QColor('#634a50'))
            p.drawText(bubble, Qt.AlignmentFlag.AlignCenter, self.speech)
        if not self.settings.fasting_mode:
            hunger = self.life.hunger
            color = '#89a78b' if hunger < 50 else '#d6a66e' if hunger < 75 else '#c77880'
            bar = QRectF(20 + size / 2 - 38, foot + 7, 76, 4)
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(255, 255, 255, 180))
            p.drawRoundedRect(bar, 2, 2)
            p.setBrush(QColor(color))
            p.drawRoundedRect(QRectF(bar.left(), bar.top(), bar.width() * hunger / 100, 4), 2, 2)
            p.setFont(QFont('Microsoft YaHei UI', 8))
            p.setPen(QColor(color))
            p.drawText(QRectF(bar.left() - 8, foot + 14, 92, 17), Qt.AlignmentFlag.AlignCenter, f'饥饿 {hunger:.0f}')
            self.setToolTip(f'饥饿 {hunger:.0f}/100 · 已吃 {self.life.total_meals} 份\n左键拖动，右键菜单')

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.engine.pick_up(*windows.cursor())
            self.grabMouse()
            event.accept()
        else: super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self.engine.state == 'drag': self.engine.drag_to(*windows.cursor())

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self.engine.state == 'drag':
            self.releaseMouse()
            self.engine.release(*windows.cursor())
            event.accept()
        elif event.button() == Qt.MouseButton.RightButton:
            self.menu.popup(event.globalPosition().toPoint())
            event.accept()

    def closeEvent(self, event):
        if not self.closed:
            self.shutdown()
        event.accept()

