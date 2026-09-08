"""Physical screen coordinates; equations follow the supplied C# policies."""
from dataclasses import dataclass
from collections import deque
import math
from .model import clamp


@dataclass(frozen=True)
class Rect:
    left: float
    top: float
    right: float
    bottom: float
    @property
    def width(self): return self.right - self.left
    @property
    def height(self): return self.bottom - self.top
    def contains(self, x, y): return self.left <= x < self.right and self.top <= y < self.bottom


@dataclass(frozen=True)
class Monitor:
    handle: int
    bounds: Rect
    work: Rect
    scale: float = 1.
    name: str = ''


@dataclass(frozen=True)
class Surface:
    handle: int
    left: float
    right: float
    top: float
    bottom: float
    floor: bool = False
    def contains(self, x, inset=8): return self.left + inset <= x <= self.right - inset


@dataclass(frozen=True)
class Body:
    handle: int
    rect: Rect
    maximized: bool = False


def landing_surface(surfaces, x, previous_y, next_y, ignored=0):
    if next_y < previous_y:
        return None
    return next((s for s in sorted(surfaces, key=lambda s: s.top)
                 if s.handle != ignored and s.contains(x) and previous_y - 1 <= s.top <= next_y + 2), None)


def platform_response(displacement, velocity, scale=1):
    scale = max(.75, scale)
    if displacement <= -3 * scale and velocity <= -360 * scale:
        return 'launch', clamp(velocity * .88, -1150 * scale, -300 * scale)
    if displacement >= 2 * scale and velocity >= 90 * scale:
        return 'release', 0
    return 'follow', 0


class DragTracker:
    def __init__(self): self.samples = deque()
    def reset(self, x, y, now):
        self.samples.clear()
        self.samples.append((x, y, now))
    def add(self, x, y, now):
        if self.samples and now < self.samples[0][2]:
            self.reset(x, y, now)
            return
        if not self.samples or (x, y) != self.samples[-1][:2] or now - self.samples[-1][2] >= .004:
            self.samples.append((x, y, now))
        while len(self.samples) > 2 and (now - self.samples[0][2] > .14 or len(self.samples) > 12):
            self.samples.popleft()
    def release(self, x, y, now, scale=1):
        self.add(x, y, now)
        if len(self.samples) < 2:
            return 0., 0.
        a, b = self.samples[0], self.samples[-1]
        dt = b[2] - a[2]
        if dt < .012:
            return 0., 0.
        vx, vy = (b[0] - a[0]) / dt, (b[1] - a[1]) / dt
        speed = math.hypot(vx, vy)
        scale = max(.75, scale)
        if speed < 430 * scale:
            return 0., 0.
        factor = clamp((speed - 430 * scale) / (850 * scale), .38, .82)
        return clamp(vx * factor, -1750 * scale, 1750 * scale), clamp(vy * factor, -1350 * scale, 1100 * scale)


def enclosure_step(pet, previous, current, vx, vy, dt, scale=1):
    """Return dx,dy,vx,vy,resting,impact; moving-wall relative velocity restitution."""
    dt = min(.08, dt)
    if dt <= 0: return 0, 0, vx, vy, False, 0
    scale = max(.5, scale)
    wall = Rect(current.left + 6 * scale, current.top + 6 * scale, current.right - 6 * scale, current.bottom - 6 * scale)
    vx *= math.exp(-.32 * dt)
    vy = min(1400 * scale, vy + 1650 * scale * dt)
    dx, dy = vx * dt, vy * dt
    speeds = [clamp((getattr(current, p) - getattr(previous, p)) / dt, -limit * scale, limit * scale)
              for p, limit in [('left', 900), ('top', 850), ('right', 900), ('bottom', 850)]]
    resting, impact = False, 0.
    if wall.width < pet.width:
        dx = (wall.left + wall.right - pet.left - pet.right) / 2
        vx = (speeds[0] + speeds[2]) / 2
    elif pet.left + dx < wall.left:
        dx = wall.left - pet.left
        relative = vx - speeds[0]
        impact = max(impact, abs(relative))
        if relative < 0: vx = speeds[0] - relative * .68
    elif pet.right + dx > wall.right:
        dx = wall.right - pet.right
        relative = vx - speeds[2]
        impact = max(impact, abs(relative))
        if relative > 0: vx = speeds[2] - relative * .68
    if wall.height < pet.height:
        dy = (wall.top + wall.bottom - pet.top - pet.bottom) / 2
        vy = (speeds[1] + speeds[3]) / 2
    elif pet.top + dy < wall.top:
        dy = wall.top - pet.top
        relative = vy - speeds[1]
        impact = max(impact, abs(relative))
        if relative < 0: vy = speeds[1] - relative * .58
    elif pet.bottom + dy >= wall.bottom:
        dy = wall.bottom - pet.bottom
        relative = vy - speeds[3]
        impact = max(impact, abs(relative))
        if 0 <= relative < 115 * scale and abs(speeds[3]) < 90 * scale:
            vy, resting = speeds[3], True
        elif relative > 0:
            vy = speeds[3] - relative * .48
    if resting: vx *= math.exp(-2.2 * dt)
    return dx, dy, clamp(vx, -1350 * scale, 1350 * scale), clamp(vy, -1200 * scale, 1200 * scale), resting, impact
