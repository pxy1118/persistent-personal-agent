import json, logging, random, time
from pathlib import Path
from PySide6.QtCore import QObject, QUrl
from PySide6.QtMultimedia import QSoundEffect
log = logging.getLogger(__name__)

class Dialogue:
    def __init__(self, path, seed=None):
        self.lines = json.loads(Path(path).read_text(encoding='utf-8'))
        self.rng, self.previous = random.Random(seed), {}
    def say(self, cue, item=None):
        lines = self.lines.get(cue, [])
        if not lines: return ''
        fresh = [line for line in lines if line != self.previous.get(cue)] or lines
        text = self.rng.choice(fresh)
        self.previous[cue] = text
        item = item or '文件'
        if len(item) > 12: item = item[:11] + '…'
        return text.replace('{item}', item)


class Voice(QObject):
    def __init__(self, asset_dir, catalog, settings, parent=None):
        super().__init__(parent)
        self.directory, self.settings = Path(asset_dir), settings
        self.files = json.loads(Path(catalog).read_text(encoding='utf-8'))
        self.player = QSoundEffect(self)
        self.player.setLoopCount(1)
        self.last_cue, self.last_file, self.previous = {}, {}, {}
        self.previous_any, self.priority = None, 0
        self.errors = []
        self.player.statusChanged.connect(self.status_changed)

    def status_changed(self):
        if self.player.status() == QSoundEffect.Status.Error:
            message = f'Could not play {self.player.source().toLocalFile()}'
            self.errors.append(message)
            log.warning(message)

    def play(self, cue, priority=1, cooldown=8):
        if not self.settings.sound_enabled: return False
        now = time.monotonic()
        if now - self.last_cue.get(cue, -1000) < cooldown: return False
        if self.player.isPlaying() and priority != 3 and priority <= self.priority and (priority != self.priority or priority < 2): return False
        candidates = [f for f in self.files.get(cue, []) if (self.directory / f).is_file() and now - self.last_file.get(f, -1000) >= 12]
        if not candidates: return False
        fresh = [f for f in candidates if f != self.previous.get(cue)] or candidates
        fresh = [f for f in fresh if f != self.previous_any] or fresh
        file = random.choice(fresh)
        self.player.stop()
        self.player.setVolume(self.settings.voice_volume)
        self.player.setSource(QUrl.fromLocalFile(str((self.directory / file).resolve())))
        self.player.play()
        self.priority = priority
        self.last_cue[cue] = self.last_file[file] = now
        self.previous[cue] = self.previous_any = file
        log.info('Voice cue=%s file=%s priority=%s', cue, file, priority)
        return True

    def stop(self): self.player.stop()
