"""Original 21 clip timings, finite completion and non-duplicating ping-pong."""
import json
from pathlib import Path


class Animator:
    def __init__(self, catalog):
        self.clips = {c['name']: c for c in json.loads(Path(catalog).read_text(encoding='utf-8'))['clips']}
        self.name = ''
        self.play('idle')

    def play(self, name, restart=True):
        if name == self.name and not restart:
            return
        self.name = name
        self.clip = self.clips[name]
        self.sequence = list(range(self.clip['first_frame'], self.clip['last_frame'] + 1))
        if self.clip['start_reversed']:
            self.sequence.reverse()
        if self.clip['ping_pong'] and len(self.sequence) > 2:
            self.sequence += self.sequence[-2:0:-1]
        self.position = 0
        self.elapsed = 0.
        self.finished = False

    @property
    def frame(self):
        return self.sequence[self.position]

    @property
    def path(self):
        return f"sprites/runtime/{self.clip['asset_folder']}/frame_{self.frame:02d}.png"

    def tick(self, dt):
        if self.finished:
            return None
        self.elapsed += max(0, dt)
        seconds = self.clip['frame_seconds']
        while self.elapsed + 1e-12 >= seconds:
            self.elapsed -= seconds
            self.position += 1
            if self.position == len(self.sequence):
                if self.clip['loop']:
                    self.position = 0
                else:
                    self.position -= 1
                    self.finished = True
                    return self.name
        return None
