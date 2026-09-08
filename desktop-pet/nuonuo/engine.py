"""Deterministic, Qt-independent desktop pet state machine.

The GUI supplies window snapshots and pointer positions. Tests supply the same
inputs without touching the real desktop. All coordinates are physical pixels.
"""
from __future__ import annotations

from collections import deque
import math
import random
from .animation import Animator
from .model import Settings, LifeState, Meal, MealQueue, HUNGER_ACTIONS, COOLDOWNS, choose_action, hand_mode, clamp
from .physics import Rect, Surface, DragTracker, landing_surface, platform_response, enclosure_step


def smooth(t):
    t = clamp(t, 0, 1)
    return t * t * (3 - 2 * t)


class PetEngine:
    def __init__(self, catalog, settings=None, life=None, seed=None):
        self.settings = settings or Settings()
        self.life = life or LifeState()
        self.animator = Animator(catalog)
        self.rng = random.Random(seed)
        self.state, self.purpose = 'idle', ''
        self.now = self.elapsed = 0.
        self.x = self.y = self.vx = self.vy = 0.
        self.scale, self.facing = 1., 1
        self.render_size = None
        self.stretch_x = self.stretch_y = 1.
        self.lean = 0.
        self.monitors, self.surfaces, self.bodies = [], [], []
        self.icons = []
        self.support = None
        self.support_missing = 0.
        self.enclosure = None
        self.enclosure_previous = None
        self.cooldowns = {}
        self.next_decision = 2.
        self.next_hunger = self.next_climb = self.next_impact = 0.
        self.next_name = self.rng.uniform(20, 50)
        self.next_need = 5.
        self.ignore_handle, self.ignore_until = 0, 0.
        self.target = (0., 0.)
        self.climb_plan = None
        self.meals = MealQueue()
        self.burst = deque()
        self.events = []
        self.drag = DragTracker()
        self.drag_offset = (0., 0.)
        self.pointer = (0., 0.)
        self.cursor_speed = 0.
        self.hand = None
        self.duration = 0.
        self.fall_start = 0.
        self.demo = False

    @property
    def pixels(self): return (self.render_size or self.settings.pet_size) * self.scale

    def anchor(self, cx, cy):
        factor = self.pixels / 512
        return self.x + (cx - 256) * factor, self.y + (cy - 498.6666666667) * factor

    def collision_rect(self):
        return Rect(self.x - self.pixels * .29, self.y - self.pixels * .79, self.x + self.pixels * .29, self.y)

    def emit(self, cue=None, voice=None, priority=1, cooldown=8):
        self.events.append(dict(cue=cue, voice=voice, priority=priority, cooldown=cooldown,
                                item=self.meals.active.name if self.meals.active else None))

    def enter(self, state, clip=None):
        self.events.append({'state': state, 'previous': self.state})
        self.state, self.elapsed = state, 0.
        self.stretch_x = self.stretch_y = 1.
        self.lean = 0.
        if clip: self.animator.play(clip)

    def supported(self):
        return next((s for s in self.surfaces if s.contains(self.x) and abs(s.top - self.y) <= 6 * self.scale), None)

    def home(self, pointer=None):
        if not self.monitors: return
        px, py = pointer or self.pointer
        m = self.monitor_at(px, py)
        self.scale = m.scale
        self.x = m.work.right - self.pixels * .65 - 24 * self.scale
        self.y = m.work.bottom - 1
        self.meals.clear()
        self.enclosure = self.enclosure_previous = None
        self.support = next((s for s in self.surfaces if s.floor and s.handle == m.handle), None)
        self.idle()
        self.emit('Home')

    def monitor_at(self, x, y):
        return min(self.monitors, key=lambda m: max(m.bounds.left - x, 0, x - m.bounds.right) ** 2 + max(m.bounds.top - y, 0, y - m.bounds.bottom) ** 2)

    def set_world(self, monitors, surfaces, bodies, dt=.06):
        previous_bodies = {b.handle: b for b in self.bodies}
        self.monitors, self.surfaces, self.bodies = monitors, surfaces, bodies
        if self.monitors:
            m = self.monitor_at(self.x, self.y)
            self.scale = m.scale
            if not any(b.bounds.contains(self.x, self.y) for b in monitors) and self.state != 'drag':
                self.x = clamp(self.x, m.work.left + 12, m.work.right - 12)
                self.y = clamp(self.y, m.work.top + self.pixels * .8, m.work.bottom - 1)
                self.fall()
        if self.support and self.state not in {'drag', 'fall', 'climb', 'slide'} and not self.enclosure:
            old = self.support
            new = next((s for s in surfaces if s.handle == old.handle and s.floor == old.floor and s.contains(self.x)), None)
            if new:
                self.support_missing = 0.
                dy = new.top - old.top
                response, launch = platform_response(dy, dy / max(dt, .004), self.scale)
                self.support = new
                self.y += dy
                if response == 'launch':
                    self.fall(launch, self.vx, old.handle)
                    self.emit('PlatformLaunch', 'Scream', 3, 4)
                elif response == 'release':
                    self.y -= dy
                    self.fall(0, self.vx, old.handle)
            else:
                self.support_missing += dt
                body = next((b for b in bodies if b.handle == old.handle), None)
                if body and body.maximized:
                    center = (m.work.left + m.work.right) / 2
                    self.fall(-820 * self.scale, (-260 if self.x < center else 260) * self.scale, old.handle)
                    self.emit('WindowMaximized', 'Panic', 3, 4)
                elif self.support_missing > .35:
                    self.fall()
        # Windows rising into an airborne pet can launch it too.
        if self.state == 'fall':
            for b in bodies:
                old = previous_bodies.get(b.handle)
                if not old or b.maximized or not b.rect.left < self.x < b.rect.right: continue
                dy = b.rect.top - old.rect.top
                if b.rect.top < self.y <= old.rect.top + 2:
                    response, velocity = platform_response(dy, dy / max(dt, .004), self.scale)
                    if response == 'launch':
                        self.y = b.rect.top
                        self.vy = min(self.vy, velocity)
                        self.ignore_handle, self.ignore_until = b.handle, self.now + .18
        # Side impacts use relative moving-edge velocity, with original restitution.
        if self.state not in {'drag', 'climb', 'slide', 'chomp', 'lick'} and not self.enclosure and self.now >= self.next_impact:
            pet = self.collision_rect()
            for b in bodies:
                old = previous_bodies.get(b.handle)
                if not old or b.handle == getattr(self.support, 'handle', None): continue
                if max(min(old.rect.bottom, pet.bottom) - max(old.rect.top, pet.top), min(b.rect.bottom, pet.bottom) - max(b.rect.top, pet.top)) < 4 * self.scale: continue
                speed_r = (b.rect.right - old.rect.right) / max(dt, .004)
                speed_l = (b.rect.left - old.rect.left) / max(dt, .004)
                direction = 0
                if speed_r >= 22 * self.scale and old.rect.right <= pet.left + 3 * self.scale and b.rect.right >= pet.left - 3 * self.scale:
                    direction, speed = 1, speed_r
                elif speed_l <= -22 * self.scale and old.rect.left >= pet.right - 3 * self.scale and b.rect.left <= pet.right + 3 * self.scale:
                    direction, speed = -1, -speed_l
                if direction:
                    speed = min(speed, 1100 * self.scale)
                    correction = min(pet.width * .45, max(0, b.rect.right - pet.left + 2 * self.scale)) if direction > 0 else -min(pet.width * .45, max(0, pet.right - b.rect.left + 2 * self.scale))
                    self.x += correction
                    self.fall(-clamp(105 * self.scale + speed * .035, 125 * self.scale, 220 * self.scale), direction * clamp(speed * .92 + 100 * self.scale, 230 * self.scale, 1450 * self.scale), b.handle)
                    self.next_impact = self.now + .4
                    break

    def idle(self):
        self.purpose, self.hand, self.climb_plan = '', None, None
        if self.meals.active and not self.meals.active.consumed:
            self.meals.requeue()
        else:
            self.meals.active = None
        self.vx = self.vy = 0.
        self.facing = 1
        self.enter('idle', 'idle')
        self.support = self.supported()
        self.next_decision = self.now + self.rng.uniform(2, 5)
        if not self.support and not self.enclosure:
            self.fall()

    def fall(self, vy=0., vx=0., ignored=0, clip='fall'):
        # A moving window may interrupt a meal approach. Preserve its ghost and
        # queue slot until consumption, just as for an explicit drag interruption.
        if self.meals.active and not self.meals.active.consumed:
            self.meals.requeue()
        self.support = None
        self.support_missing = 0
        self.hand, self.purpose, self.climb_plan = None, '', None
        self.vx, self.vy = vx, vy
        self.fall_start = self.y
        self.ignore_handle, self.ignore_until = ignored, self.now + .25
        self.enter('fall', clip)

    def land(self, surface):
        impact = self.vy
        self.y, self.support = surface.top, surface
        self.vx = self.vy = 0
        self.enter('landing', 'land')
        if impact >= 560 * self.scale or self.y - self.fall_start >= 150 * self.scale:
            self.emit('HardLanding', 'Landing', 2, 12)

    def pick_up(self, x, y):
        self.demo = False
        self.meals.requeue()
        self.enclosure = self.enclosure_previous = None
        self.support = None
        self.drag.reset(x, y, self.now)
        self.drag_offset = self.x - x, self.y - y
        self.enter('drag', 'drag')
        self.emit('PickedUp', 'Aggrieved', 2, 8)

    def drag_to(self, x, y):
        if self.state != 'drag': return
        self.drag.add(x, y, self.now)
        dx, dy = x + self.drag_offset[0] - self.x, y + self.drag_offset[1] - self.y
        self.x, self.y = x + self.drag_offset[0], y + self.drag_offset[1]
        amount = clamp(math.hypot(dx, dy) / (40 * self.scale), 0, 1)
        self.stretch_x, self.stretch_y = 1 - amount * .12, 1 + amount * .18
        self.lean = clamp(dx / self.scale * .35, -14, 14)

    def release(self, x, y):
        if self.state != 'drag': return
        vx, vy = self.drag.release(x, y, self.now, self.scale)
        pet = self.collision_rect()
        self.enclosure = next((b.handle for b in self.bodies if b.rect.width > pet.width + 24 * self.scale and b.rect.height > pet.height + 24 * self.scale and b.rect.left + 6 < pet.left and b.rect.right - 6 > pet.right and b.rect.top + 6 < pet.top and b.rect.bottom - 6 > pet.bottom), None)
        if self.enclosure:
            self.enclosure_previous = next(b.rect for b in self.bodies if b.handle == self.enclosure)
        self.fall(vy, vx, clip='toss' if vx or vy else 'fall')
        self.emit('DragThrow' if vx or vy else 'Released', 'Scream' if vx or vy else 'Neutral', 3 if vx or vy else 1, 5)

    def accept_meal(self, meal):
        if self.settings.quiet_mode or not self.settings.react_to_deletes: return False
        if not self.meals.add(meal): return False
        self.burst.append(self.now)
        while self.burst and self.now - self.burst[0] > 2.5: self.burst.popleft()
        if len(self.burst) == 2: self.emit('Buffet', 'Affirmative', 2, 8)
        if self.state == 'sleep': self.wake(True)
        return True

    def start_meal(self):
        if not self.meals.pending or not self.settings.react_to_deletes or self.settings.quiet_mode: return
        self.enclosure = self.enclosure_previous = self.support = None
        self.meals.active = self.meals.pending.popleft()
        self.target = self.meals.active.x, self.meals.active.y
        self.vx = self.vy = 0
        self.purpose = 'meal'
        self.enter('move', 'run')
        self.emit('MealQueueContinues' if self.meals.pending else 'MealSpotted')

    def consume(self):
        if self.meals.active and not self.meals.active.consumed:
            self.life.meal(self.meals.active.path)
            self.meals.active.consumed = True
            if self.settings.fasting_mode: self.life.hunger = 0
            self.events.append({'consumed': self.meals.active.path})

    def icon_lick(self):
        if self.enclosure or not self.icons: return False
        candidates = sorted(self.icons, key=lambda p: math.hypot(p['x'] - self.x, p['y'] - self.y))[:5]
        icon = self.rng.choice(candidates)
        self.target = icon['x'] + icon.get('width', 32) / 2, icon['y']
        self.support, self.purpose = None, 'lick'
        self.vx = self.vy = 0
        self.enter('move', 'run')
        self.emit('CuriousIconLick', 'Question', 1, 20)
        return True

    def sleep(self):
        if not self.supported() and not self.enclosure:
            self.fall()
            return
        self.duration = self.rng.uniform(14, 24)
        self.enter('sleep', 'sleep_enter')
        self.emit('Sleep', 'Calm', 0, 45)

    def wake(self, for_meal=False):
        self.enter('wake', 'sleep_exit')
        self.emit('WakeForFood' if for_meal else 'WakeNormally')

    def begin_hand(self, forced=None):
        px, py = self.pointer
        ax, ay = self.anchor(256, 286)
        distance = math.hypot(px - ax, py - ay)
        if not self.monitors or self.monitor_at(px, py).handle != self.monitor_at(self.x, self.y).handle or distance > 1000 or abs(py - ay) > 520:
            return False
        mode = forced or ('dodge' if self.cursor_speed > 920 * self.scale and distance < 280 else hand_mode(distance, self.rng.random()))
        self.hand = mode
        self.duration = {'hug': 2.2, 'dodge': 2.4, 'follow': 6.8, 'chase': 6}[mode]
        self.vx = self.vy = 0
        self.enter('hand', 'hug' if mode == 'hug' else 'walk' if mode == 'follow' else 'run')
        if mode == 'hug':
            self.support = None
            self.facing = 1 if px >= ax else -1
        self.emit('Hand' + mode.title(), 'Positive' if mode == 'hug' else 'Question', 1, 12)
        return True

    def climb_target(self):
        support = self.supported()
        if not support or self.now < self.next_climb: return None
        candidates = []
        for s in self.surfaces:
            height = support.top - s.top
            if s.floor or s.handle == support.handle or not 64 * self.scale <= height <= 1320 * self.scale or s.bottom < support.top - 420 * self.scale: continue
            for direction, approach, land in [(1, s.left - 14 * self.scale, s.left + 34 * self.scale), (-1, s.right + 14 * self.scale, s.right - 34 * self.scale)]:
                if support.contains(approach, 18) and s.contains(land):
                    candidates.append((abs(approach - self.x) + height * .16, s.handle, direction, approach, land, height))
        return self.rng.choice(sorted(candidates)[:4]) if candidates else None

    def patrol(self, prefer_climb=False):
        self.support = self.supported()
        if not self.support:
            self.fall()
            return
        self.climb_plan = self.climb_target() if prefer_climb or self.rng.random() < .34 else None
        if self.climb_plan:
            self.target, self.purpose = (self.climb_plan[3], self.y), 'climb'
        else:
            s = self.support
            inset = clamp(self.pixels * .2, 24, 72)
            if s.right - s.left < inset * 2 + 42:
                self.idle()
                return
            if abs(self.x - (s.right - inset if self.facing > 0 else s.left + inset)) < 20:
                self.facing *= -1
            self.target, self.purpose = (s.right - inset if self.facing > 0 else s.left + inset, self.y), 'patrol'
        self.vx = 0
        self.enter('move', 'walk')
        self.next_need = self.now + 5

    def do_action(self, action):
        self.cooldowns[action] = self.now + COOLDOWNS[action]
        if action in HUNGER_ACTIONS: self.next_hunger = self.now + 45
        if action in {'wander', 'explore'}: self.patrol(action == 'explore')
        elif action == 'sleep': self.sleep()
        elif action == 'ask':
            self.duration = self.rng.uniform(2.8, 5)
            self.enter('curious', 'hungry')
            self.emit('VeryHungry' if self.life.hunger >= 78 else 'ABitHungry', 'Aggrieved', 1, 20)
        elif action == 'lick':
            if not self.icon_lick(): self.patrol()
        elif action == 'roll':
            self.enter('roll', 'roll')
            self.emit('HungryRoll', 'Aggrieved', 1, 10)
        elif action == 'hand':
            if not self.begin_hand(): self.patrol()
        elif action == 'hop':
            handle = self.support.handle if self.support else 0
            self.fall(-520 * self.scale, self.facing * 160 * self.scale, handle, 'jump')
            self.emit('TerrainHop', 'Positive', 1, 10)
        else:
            if self.settings.quiet_mode: self.next_decision = self.now + 5
            else: self.patrol()

    def available_actions(self):
        return {a for a in COOLDOWNS if self.now >= self.cooldowns.get(a, 0)
                and (a not in HUNGER_ACTIONS or self.now >= self.next_hunger)
                and (not self.settings.fasting_mode or a not in HUNGER_ACTIONS)
                and (not self.settings.quiet_mode or a in {'rest', 'sleep'})}

    def set_mode(self, name, value):
        setattr(self.settings, name, value)
        if name == 'fasting_mode' and value: self.life.hunger = 0
        if name == 'quiet_mode' and value:
            self.meals.clear()
            if self.state not in {'drag', 'fall', 'sleep', 'wake', 'landing'}:
                self.idle()
        if name == 'react_to_deletes' and not value:
            self.meals.clear()
            if self.purpose == 'meal' or self.state in {'chomp', 'satisfied'}: self.idle()

    def tick(self, seconds, pointer=None):
        real_dt = max(0, seconds)
        dt = min(.05, real_dt)
        self.now += real_dt
        self.elapsed += dt
        if pointer is not None:
            speed = math.dist(pointer, self.pointer) / max(.001, real_dt)
            self.cursor_speed += (speed - self.cursor_speed) * min(1, dt * 12)
            self.pointer = pointer
        self.life.advance(real_dt, self.state == 'sleep')
        if self.settings.fasting_mode: self.life.hunger = 0
        finished = self.animator.tick(dt)
        if self.demo: return
        if self.state == 'drag': return
        if self.enclosure:
            if self.meals.pending and not self.settings.quiet_mode and self.settings.react_to_deletes:
                self.start_meal()
            else:
                body = next((b for b in self.bodies if b.handle == self.enclosure), None)
                if not body:
                    self.enclosure = None
                    self.fall()
                else:
                    dx, dy, self.vx, self.vy, resting, impact = enclosure_step(self.collision_rect(), self.enclosure_previous or body.rect, body.rect, self.vx, self.vy, dt, self.scale)
                    self.x += dx
                    self.y += dy
                    self.enclosure_previous = body.rect
                    if resting:
                        if self.state not in {'idle', 'sleep', 'wake'}: self.enter('idle', 'idle')
                        if self.state == 'idle' and self.now >= self.next_decision:
                            self.next_decision = self.now + 8
                            if self.rng.random() < .3: self.sleep()
                    elif self.state != 'fall': self.enter('fall', 'fall')
                    if impact > 550 * self.scale and self.now >= self.next_impact:
                        self.emit('HardLanding', 'Landing', 2, 12)
                        self.next_impact = self.now + .5
                    if self.state == 'sleep' and self.elapsed >= self.duration: self.wake()
                    if finished: self.animation_finished(finished)
                    return
        if finished: self.animation_finished(finished)
        if self.meals.pending and not self.meals.active and self.state in {'idle', 'curious', 'move'} and self.settings.react_to_deletes and not self.settings.quiet_mode:
            self.start_meal()
        if self.state == 'fall': self.update_fall(dt)
        elif self.state == 'move': self.update_move(dt)
        elif self.state == 'hand': self.update_hand(dt)
        elif self.state == 'climb': self.update_climb()
        elif self.state == 'slide': self.update_slide()
        elif self.state == 'chomp':
            if self.elapsed >= 1.35: self.consume()
        elif self.state == 'sleep':
            amount = (math.sin(self.elapsed * 2.1) + 1) / 2
            self.stretch_x, self.stretch_y, self.lean = 1 + amount * .025, 1 - amount * .018, -1.5
            if self.elapsed >= self.duration or self.elapsed >= 7.5 and self.life.sleepiness <= 24: self.wake()
        elif self.state == 'landing' and self.elapsed >= 1.05:
            self.start_meal() if self.meals.pending and not self.settings.quiet_mode else self.idle()
        elif self.state == 'curious' and self.elapsed >= self.duration: self.idle()
        elif self.state == 'idle':
            if not self.support and not self.supported(): self.fall()
            elif self.now >= self.next_decision:
                self.do_action(choose_action(self.life, True, self.available_actions() | {'rest'}, self.rng.random()))
            elif self.now >= self.next_name:
                self.events.append({'text': '糯糯'})
                self.next_name = self.now + self.rng.uniform(20, 50)

    def animation_finished(self, clip):
        if self.state == 'fall' and clip in {'jump', 'toss'}: self.animator.play('fall')
        elif self.state == 'sleep' and clip == 'sleep_enter': self.animator.play('sleep')
        elif self.state == 'wake' and clip == 'sleep_exit':
            self.start_meal() if self.meals.pending and self.settings.react_to_deletes and not self.settings.quiet_mode else self.idle()
        elif self.state == 'hand' and clip == 'hug': self.fall(clamp(self.vy * .2 + 70, -420, 520), self.vx * .28)
        elif self.state == 'roll' and clip == 'roll':
            self.life.hunger += .25
            if self.settings.fasting_mode: self.life.hunger = 0
            self.idle()
        elif self.state == 'lick' and clip == 'lick':
            self.life.hunger += .4
            if self.settings.fasting_mode: self.life.hunger = 0
            self.life.curiosity -= 1.5
            self.emit('IconTaste', 'Neutral', 0, 15)
            self.fall()
        elif self.state == 'chomp' and clip == 'chomp':
            self.consume()
            self.enter('satisfied', 'satisfied_quick' if self.meals.pending else 'satisfied')
            self.emit('AnotherBite' if self.meals.pending else 'Stuffed' if self.life.fullness >= 88 else 'TastedItem', 'Affirmative', 2, 5)
        elif self.state == 'satisfied' and clip.startswith('satisfied'):
            self.meals.active = None
            if self.meals.pending: self.start_meal()
            else: self.idle()

    def update_fall(self, dt):
        self.vx *= math.exp(-.48 * dt)
        self.vy = min(1350 * self.scale, self.vy + 1650 * self.scale * dt)
        nx, ny = self.x + self.vx * dt, self.y + self.vy * dt
        if self.monitors:
            m = self.monitor_at(nx, ny)
            corrected = clamp(nx, m.bounds.left + 8 * m.scale, m.bounds.right - 8 * m.scale)
            if corrected != nx:
                nx, self.vx = corrected, -self.vx * .58
            if ny < m.bounds.top + self.pixels * .78:
                ny, self.vy = m.bounds.top + self.pixels * .78, max(0, -self.vy * .35)
        ignored = self.ignore_handle if self.now < self.ignore_until else 0
        surface = landing_surface(self.surfaces, nx, self.y, ny, ignored) if self.vy >= 0 else None
        if not surface and self.vy >= 0 and self.monitors and ny > m.work.bottom:
            surface = next((s for s in self.surfaces if s.floor and s.handle == m.handle), None)
        self.x = nx
        if surface: self.land(surface)
        else: self.y = ny
        if abs(self.vx) > 8: self.facing = 1 if self.vx >= 0 else -1
        self.lean = clamp(self.vx / (1100 * self.scale) * 8, -8, 8)

    def update_move(self, dt):
        if self.purpose in {'meal', 'lick'}:
            ax, ay = self.anchor(45 if self.purpose == 'meal' else 60, 267 if self.purpose == 'meal' else 334)
            dx, dy = self.target[0] - ax, self.target[1] - ay
            distance = math.hypot(dx, dy)
            if distance < 18 * self.scale or self.elapsed > 6.5:
                self.x += dx
                self.y += dy
                self.vx = self.vy = 0
                self.facing = 1
                self.enter('chomp' if self.purpose == 'meal' else 'lick', 'chomp' if self.purpose == 'meal' else 'lick')
                if self.state == 'chomp': self.emit('Suction', 'Positive', 2, 6)
                self.purpose = ''
                return
            speed = clamp(distance * 3.2, 250 * self.scale, (720 if self.purpose == 'meal' else 640) * self.scale)
            self.vx += (dx / distance * speed - self.vx) * min(1, dt * 7.5)
            self.vy += (dy / distance * speed - self.vy) * min(1, dt * 7.5)
            self.x += self.vx * dt
            self.y += self.vy * dt
            self.facing = 1 if self.vx >= 0 else -1
            return
        s = self.supported()
        if not s:
            self.fall()
            return
        self.support = s
        if self.now >= self.next_need:
            self.next_need = self.now + 5
            thresholds = {'sleep': self.life.sleepiness >= 62, 'ask': self.life.hunger >= 70, 'lick': self.life.hunger >= 62, 'roll': self.life.hunger >= 65}
            ready = {a for a in self.available_actions() if thresholds.get(a, False)}
            if ready:
                self.do_action(choose_action(self.life, True, ready, self.rng.random()))
                return
        dx = self.target[0] - self.x
        speed = 125 * self.scale
        self.vx += ((speed if dx > 0 else -speed) - self.vx) * min(1, dt * 7.2)
        self.x += clamp(self.vx * dt, -abs(dx), abs(dx))
        self.facing = 1 if dx > 0 else -1
        self.y = s.top
        if abs(dx) < 6:
            if self.purpose == 'climb' and self.climb_plan:
                self.climb_start = self.y
                height = self.climb_plan[5]
                self.duration = clamp(height / (175 * self.scale), 2, 6.4)
                self.climb_success = self.rng.random() < (.58 if height > 700 * self.scale else .74)
                self.climb_failure = self.rng.uniform(.56, .76)
                self.support = None
                self.facing = self.climb_plan[2]
                self.enter('climb', 'climb')
                self.emit('ConfidentClimb' if self.climb_success else 'CarefulClimb', 'Question', 1, 10)
            else:
                r = self.rng.random()
                if r < (.22 if s.floor else .2): self.do_action('hop')
                elif not s.floor and r < .34:
                    self.slide_handle, self.slide_start = s.handle, self.y
                    self.slide_side = self.facing
                    self.slide_end = min(s.bottom, self.y + 260 * self.scale)
                    self.duration = 2.5
                    self.support = None
                    self.enter('slide', 'slide')
                    self.emit('EdgeSlide', 'Aggrieved', 1, 10)
                elif not s.floor and r < .48:
                    self.x = (s.right + 12 * self.scale) if self.facing > 0 else (s.left - 12 * self.scale)
                    self.fall(-220 * self.scale, self.facing * 210 * self.scale, s.handle, 'jump')
                    self.emit('TerrainJumpDown')
                else:
                    self.facing *= -1
                    if self.rng.random() < .18:
                        self.life.explore()
                        self.duration = self.rng.uniform(2.8, 5)
                        self.enter('curious', 'curious')
                        self.emit('Exploration', 'Question', 0, 18)
                    else: self.patrol()

    def update_climb(self):
        plan = self.climb_plan
        s = next((s for s in self.surfaces if plan and s.handle == plan[1] and not s.floor), None)
        if not s:
            self.fall()
            return
        t = self.elapsed / self.duration
        if not self.climb_success and t >= self.climb_failure:
            self.next_climb = self.now + 24
            self.emit('ClimbSlip', 'Aggrieved', 2, 8)
            self.fall(80 * self.scale)
            return
        approach = s.left - 14 * self.scale if plan[2] > 0 else s.right + 14 * self.scale
        target_x = s.left + 34 * self.scale if plan[2] > 0 else s.right - 34 * self.scale
        self.x = approach + (target_x - approach) * smooth((smooth(t) - .78) / .22)
        self.y = self.climb_start + (s.top - self.climb_start) * smooth(t)
        if t >= 1:
            self.support, self.y, self.x = s, s.top, target_x
            self.life.explore(12)
            self.next_climb = self.now + 20
            self.emit('ClimbSuccess', 'Affirmative', 2, 8)
            self.patrol()

    def update_slide(self):
        s = next((s for s in self.surfaces if s.handle == self.slide_handle), None)
        if not s:
            self.fall(90 * self.scale)
            return
        self.x = s.right + self.pixels * .29 if self.slide_side > 0 else s.left - self.pixels * .29
        self.y = self.slide_start + (self.slide_end - self.slide_start) * smooth(self.elapsed / self.duration)
        self.lean = -self.slide_side * 3
        if self.elapsed >= self.duration: self.fall(105 * self.scale, self.slide_side * 85 * self.scale, s.handle)

    def update_hand(self, dt):
        if self.hand == 'hug':
            ax, ay = self.anchor(394 if self.facing > 0 else 118, 260)
            dx, dy = self.pointer[0] - ax, self.pointer[1] - ay
            self.vx += (dx * 8.5 - self.vx) * min(1, dt * 9.5)
            self.vy += (dy * 8.5 - self.vy) * min(1, dt * 9.5)
            speed = math.hypot(self.vx, self.vy)
            if speed > 1250 * self.scale:
                ratio = 1250 * self.scale / speed
                self.vx *= ratio
                self.vy *= ratio
            self.x += self.vx * dt
            self.y += self.vy * dt
            self.lean = clamp(self.vx / (1250 * self.scale) * 8, -8, 8)
            if self.elapsed >= self.duration or math.hypot(dx, dy) > 680:
                self.fall(clamp(self.vy * .2 + 70, -420, 520), self.vx * .28)
            return
        if self.elapsed >= self.duration:
            self.idle()
            return
        s = self.supported()
        if not s:
            self.fall()
            return
        dx = self.pointer[0] - self.x
        if self.hand == 'chase' and math.dist(self.pointer, self.anchor(256, 286)) <= 76 * self.scale:
            self.begin_hand('hug')
            return
        inset = clamp(34 * self.scale, 24, 72)
        if self.hand == 'dodge': target = s.right - inset if dx <= 0 else s.left + inset
        elif self.hand == 'follow': target = self.pointer[0] - (82 if dx > 0 else -82) * self.scale
        else: target = self.pointer[0]
        target = clamp(target, s.left + inset, s.right - inset)
        delta = target - self.x
        speed = {'follow': 135, 'dodge': 320, 'chase': 285}[self.hand] * self.scale
        self.vx += ((0 if abs(delta) < 6 else speed if delta > 0 else -speed) - self.vx) * min(1, dt * 7.2)
        self.x += clamp(self.vx * dt, -abs(delta), abs(delta))
        if abs(delta) > 2: self.facing = 1 if delta > 0 else -1
