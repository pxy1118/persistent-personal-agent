"""Pure rules ported from SoftMochiPet.Models and Core; no GUI dependency."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field, asdict
import json
import math
import ntpath
from pathlib import Path
import time


def clamp(value, low, high):
    return min(high, max(low, value))


def finite(value, default):
    try:
        value = float(value)
        return value if math.isfinite(value) else default
    except (TypeError, ValueError):
        return default


@dataclass
class Settings:
    react_to_deletes: bool = True
    sound_enabled: bool = True
    fasting_mode: bool = False
    quiet_mode: bool = False
    voice_volume: float = .72
    pet_size: float = 220.
    watched_folders: list[str] = field(default_factory=list)

    def normalize(self):
        for name in ('react_to_deletes', 'sound_enabled', 'fasting_mode', 'quiet_mode'):
            if not isinstance(getattr(self, name), bool):
                setattr(self, name, self.__dataclass_fields__[name].default)
        self.pet_size = clamp(finite(self.pet_size, 220), 132, 440)
        self.voice_volume = clamp(finite(self.voice_volume, .72), 0, 1)
        self.watched_folders = list(dict.fromkeys(x for x in self.watched_folders if isinstance(x, str) and x.strip())) if isinstance(self.watched_folders, list) else []


@dataclass
class LifeState:
    hunger: float = 36.
    fullness: float = 24.
    sleepiness: float = 20.
    curiosity: float = 48.
    total_meals: int = 0
    favorite_food_type: str = ''
    food_type_counts: dict[str, int] = field(default_factory=dict)
    last_updated_utc: float = field(default_factory=time.time)

    def normalize(self):
        for name, default in [('hunger', 36), ('fullness', 24), ('sleepiness', 20), ('curiosity', 48)]:
            setattr(self, name, clamp(finite(getattr(self, name), default), 0, 100))
        self.total_meals = max(0, int(finite(self.total_meals, 0)))
        if not isinstance(self.food_type_counts, dict):
            self.food_type_counts = {}
        self.food_type_counts = {str(k): max(0, int(finite(v, 0))) for k, v in self.food_type_counts.items()}
        self.last_updated_utc = finite(self.last_updated_utc, time.time())

    def advance(self, seconds, sleeping=False):
        minutes = clamp(finite(seconds, 0) / 60, 0, 720)
        rates = (.12, -.2, -36, .08) if sleeping else (.18, -.32, .13, .22)
        for name, rate in zip(('hunger', 'fullness', 'sleepiness', 'curiosity'), rates):
            setattr(self, name, getattr(self, name) + rate * minutes)
        self.normalize()

    def meal(self, path, nourishment=None):
        n = clamp(nourishment if nourishment is not None else meal_nourishment(path), 2, 24)
        self.hunger -= n * .92
        self.fullness += n
        self.sleepiness += n * .055
        self.curiosity -= min(3, n * .12)
        self.total_meals += 1
        ext = ntpath.splitext(path)[1].lower().lstrip('.')
        food = '点心' if ext == 'snack' else ext or '文件夹'
        self.food_type_counts[food] = self.food_type_counts.get(food, 0) + 1
        self.favorite_food_type = min(self.food_type_counts, key=lambda k: (-self.food_type_counts[k], k.lower()))
        self.normalize()

    def explore(self, amount=18):
        self.curiosity -= clamp(amount, 2, 30)
        self.hunger += .8
        self.normalize()


def meal_nourishment(path):
    ext = ntpath.splitext(path)[1].lower()
    for extensions, value in [(('.snack',), 9), (('.zip', '.rar', '.iso', '.7z'), 15),
                              (('.mp4', '.mkv', '.mov'), 14), (('.exe', '.msi'), 13),
                              (('.png', '.jpg', '.gif', '.jpeg', '.webp'), 10), (('.lnk', '.url'), 8)]:
        if ext in extensions:
            return value
    return 11


HUNGER_ACTIONS = {'ask', 'lick', 'roll'}
COOLDOWNS = dict(rest=5, wander=9, explore=18, sleep=90, ask=65, lick=70, roll=42, hand=78, hop=24)


def choose_action(life, supported, available, random_unit):
    weights = [('rest', 2.2 + max(0, life.fullness - 68) / 24)]
    if supported:
        weights += [('wander', 1.1 + life.curiosity / 85), ('explore', .25 + max(0, life.curiosity - 30) / 13)]
    weights += [('sleep', .75 + max(0, life.sleepiness - 43) / 9),
                ('ask', max(0, life.hunger - 48) / 10), ('lick', .16 + max(0, life.hunger - 35) / 24),
                ('roll', max(0, life.hunger - 58) / 10), ('hand', .32 + life.curiosity / 115)]
    if supported:
        weights.append(('hop', .24 + life.curiosity / 180))
    weights = [(a, w) for a, w in weights if a in available and w > 0]
    draw = clamp(random_unit, 0, .999999) * sum(w for a, w in weights)
    for action, weight in weights:
        draw -= weight
        if draw <= 0:
            return action
    return weights[-1][0] if weights else 'rest'


def hand_mode(distance, random_unit):
    if distance <= 95:
        return 'hug' if random_unit < .38 else 'dodge' if random_unit < .7 else 'follow'
    if distance <= 300:
        return 'chase' if random_unit < .42 else 'dodge' if random_unit < .68 else 'follow'
    return 'chase' if random_unit < .72 else 'follow'


class Store:
    """Separate Python save directory; atomic replace prevents truncated JSON."""
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def load(self, name, cls):
        path = self.directory / name
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            result = cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
            result.normalize()
            return result
        except (OSError, ValueError, TypeError, AttributeError):
            return cls()

    def save(self, name, value):
        path = self.directory / name
        temporary = path.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(asdict(value), ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
        temporary.replace(path)


@dataclass
class Meal:
    path: str
    x: float
    y: float
    source: str = 'folder'
    consumed: bool = False
    icon: object = None
    @property
    def name(self):
        return ntpath.basename(self.path) or '神秘文件'


class MealQueue:
    def __init__(self):
        self.pending = deque()
        self.active: Meal | None = None

    def add(self, meal):
        if len(self.pending) + int(self.active is not None) >= 24:
            return False
        self.pending.append(meal)
        return True

    def requeue(self):
        if self.active and not self.active.consumed:
            self.pending.appendleft(self.active)
        self.active = None

    def clear(self):
        self.pending.clear()
        self.active = None


def ghost_anchor(origin, occupied, work, pixels, scale=1):
    """Keep both the food and the approaching full sprite inside the work area."""
    left, right = work.left + 44 * scale, work.right - max(60 * scale, pixels * .96)
    top, bottom = work.top + pixels * .56, work.bottom - pixels * .50
    right, bottom = max(left, right), max(top, bottom)
    center = clamp(origin[0], left, right), clamp(origin[1], top, bottom)
    offsets = sorted(((i, j) for i in range(-6, 7) for j in range(-6, 7)), key=lambda p: (p[0] ** 2 + p[1] ** 2, p))
    for i, j in offsets:
        x, y = clamp(center[0] + i * 64 * scale, left, right), clamp(center[1] + j * 68 * scale, top, bottom)
        if all(math.hypot(x - m.x, y - m.y) >= 48 * scale for m in occupied):
            return x, y
    return center
