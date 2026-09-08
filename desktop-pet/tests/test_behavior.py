from pathlib import Path
import json
import math
import struct

import pytest
from nuonuo.animation import Animator
from nuonuo.engine import PetEngine
from nuonuo.model import Settings, LifeState, Meal, MealQueue, Store, choose_action
from nuonuo.physics import Rect, Monitor, Body, Surface, DragTracker, platform_response, landing_surface, enclosure_step

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def engine():
    e = PetEngine(ROOT / 'data/animation_clips.json', seed=3)
    m = Monitor(1, Rect(0, 0, 1920, 1080), Rect(0, 0, 1920, 1040))
    e.set_world([m], [Surface(1, 0, 1919, 1039, 1039, True)], [])
    e.home((960, 600))
    e.settings.quiet_mode = True
    return e


def advance(e, seconds):
    for _ in range(round(seconds / .02)):
        e.tick(.02)


def test_sleep_clip_pingpong_and_reverse_endpoints():
    a = Animator(ROOT / 'data/animation_clips.json')
    a.play('sleep')
    frames = []
    for _ in range(16):
        frames.append(a.frame)
        a.tick(.185)
    assert frames == [8, 9, 10, 11, 12, 13, 14, 15, 14, 13, 12, 11, 10, 9, 8, 9]
    a.play('sleep_exit')
    assert a.frame == 7
    assert a.tick(.105 * 8) == 'sleep_exit'
    assert a.frame == 0
    assert a.tick(10) is None  # Finite clips complete exactly once.


def test_catalog_uses_exact_original_frames():
    a = Animator(ROOT / 'data/animation_clips.json')
    assert len(a.clips) == 21
    assert a.clips['toss']['last_frame'] == 7
    assert a.clips['satisfied_quick']['last_frame'] == 9
    for name in a.clips:
        a.play(name)
        for frame in a.sequence:
            assert (ROOT.parent / 'nuonuo_dev_assets/assets/sprites/runtime' / a.clip['asset_folder'] / f'frame_{frame:02d}.png').is_file()


def test_need_rates_and_offline_cap():
    l = LifeState()
    l.advance(60)
    assert (l.hunger, l.fullness, l.sleepiness, l.curiosity) == pytest.approx((36.18, 23.68, 20.13, 48.22))
    l.advance(60, sleeping=True)
    assert (l.hunger, l.fullness, l.sleepiness, l.curiosity) == pytest.approx((36.3, 23.48, 0, 48.3))
    a, b = LifeState(), LifeState()
    a.advance(720 * 60)
    b.advance(3000 * 60)
    assert (a.hunger, a.fullness, a.sleepiness, a.curiosity) == (b.hunger, b.fullness, b.sleepiness, b.curiosity)


def test_meal_counts_and_case_insensitive_types():
    l = LifeState()
    l.meal('A.ZIP')
    l.meal('B.zip')
    assert l.total_meals == 2 and l.food_type_counts == {'zip': 2}
    assert l.hunger == pytest.approx(36 - 2 * 15 * .92)
    assert l.favorite_food_type == 'zip'


def test_store_recovers_invalid_json_and_nonfinite_values(tmp_path):
    s = Store(tmp_path)
    (tmp_path / 'life.json').write_text('{oops', encoding='utf-8')
    assert s.load('life.json', LifeState).hunger == 36
    (tmp_path / 'life.json').write_text('{"hunger":"bad","fullness":-3,"food_type_counts":null}', encoding='utf-8')
    l = s.load('life.json', LifeState)
    assert l.hunger == 36 and l.fullness == 0 and l.food_type_counts == {}
    s.save('life.json', l)
    assert json.loads((tmp_path / 'life.json').read_text())['hunger'] == 36
    assert not (tmp_path / 'life.json.tmp').exists()


def test_queue_capacity_includes_current_meal_and_requeue_preserves_order():
    q = MealQueue()
    q.active = Meal('first.txt', 0, 0)
    for i in range(23): assert q.add(Meal(f'{i}.png', 0, 0))
    assert not q.add(Meal('overflow', 0, 0))
    q.requeue()
    assert len(q.pending) == 24 and q.pending[0].path == 'first.txt'
    q.active = q.pending.popleft()
    q.active.consumed = True
    q.requeue()
    assert len(q.pending) == 23


def test_drag_release_speed_and_pause():
    t = DragTracker()
    t.reset(0, 0, 0)
    for i in range(1, 8): t.add(i * 20, -i * 10, i * .02)
    vx, vy = t.release(160, -80, .16)
    assert vx > 380 and vy < 0
    t.add(160, -80, .5)
    assert t.release(160, -80, .6) == (0, 0)


def test_fast_moving_platform_response():
    assert platform_response(-12, -600) == ('launch', -528)
    assert platform_response(3, 150) == ('release', 0)
    assert platform_response(1, 50) == ('follow', 0)
    # Same logical movement on a 200% DPI screen.
    assert platform_response(-24, -1200, 2) == ('launch', -1056)


def test_swept_landing_does_not_tunnel():
    floor = Surface(1, 0, 1919, 1039, 1039, True)
    upper = Surface(2, 100, 900, 500, 900)
    assert landing_surface([floor, upper], 300, 480, 1080) == upper
    assert landing_surface([floor, upper], 300, 600, 450) is None
    assert landing_surface([floor, upper], 300, 480, 1080, ignored=2) == floor


def test_fall_lands_on_window_then_falls_when_window_closes(engine):
    upper = Surface(2, 200, 800, 500, 900)
    engine.set_world(engine.monitors, engine.surfaces + [upper], [Body(2, Rect(200, 500, 800, 900))])
    engine.x, engine.y = 400, 300
    engine.fall(1000)
    advance(engine, .3)
    assert engine.state == 'landing' and engine.y == 500
    for _ in range(8): engine.set_world(engine.monitors, [s for s in engine.surfaces if s.floor], [], .06)
    assert engine.state == 'fall'
    advance(engine, 2)
    assert engine.y == 1039 and engine.state in {'idle', 'landing'}


def test_quiet_mode_suppresses_deletes_but_not_gravity(engine):
    assert not engine.accept_meal(Meal('deleted.png', 400, 300))
    engine.x, engine.y = 400, 300
    engine.fall()
    advance(engine, 2)
    assert engine.y == 1039


def test_fasting_still_accepts_deletion_and_applies_meal_once(engine):
    engine.set_mode('quiet_mode', False)
    engine.set_mode('fasting_mode', True)
    engine.accept_meal(Meal('deleted.zip', *engine.anchor(45, 267)))
    engine.start_meal()
    advance(engine, 4)
    assert engine.life.total_meals == 1
    assert engine.life.hunger == 0
    assert not engine.meals.active


def test_drag_interrupt_requeues_unconsumed_meal(engine):
    engine.set_mode('quiet_mode', False)
    engine.accept_meal(Meal('a.png', 400, 300))
    engine.start_meal()
    engine.pick_up(engine.x, engine.y)
    assert engine.meals.active is None and len(engine.meals.pending) == 1
    assert engine.life.total_meals == 0
    engine.release(engine.x, engine.y)
    advance(engine, 12)
    assert engine.life.total_meals == 1


def test_physical_interruption_preserves_active_meal(engine):
    engine.set_mode('quiet_mode', False)
    engine.accept_meal(Meal('a.png', 500, 500))
    engine.start_meal()
    engine.fall(-180, 250)
    assert engine.meals.active is None
    assert [m.path for m in engine.meals.pending] == ['a.png']
    advance(engine, 13)
    assert engine.life.total_meals == 1


def test_food_wakes_sleeping_pet(engine):
    engine.set_mode('quiet_mode', False)
    engine.sleep()
    advance(engine, 2)
    assert engine.animator.name == 'sleep'
    engine.accept_meal(Meal('a.png', *engine.anchor(45, 267)))
    assert engine.state == 'wake' and engine.animator.name == 'sleep_exit'
    advance(engine, 6)
    assert engine.life.total_meals == 1


def test_enclosure_bounce_and_settle():
    box = Rect(0, 0, 600, 600)
    pet = Rect(200, 200, 300, 350)
    vx, vy, rests = 180, 0, 0
    for _ in range(1500):
        dx, dy, vx, vy, resting, impact = enclosure_step(pet, box, box, vx, vy, .016)
        pet = Rect(pet.left + dx, pet.top + dy, pet.right + dx, pet.bottom + dy)
        assert pet.left >= 6 - 1e-8 and pet.right <= 594 + 1e-8
        assert pet.top >= 6 - 1e-8 and pet.bottom <= 594 + 1e-8
        rests += resting
    assert rests > 100 and abs(vx) < 1 and abs(vy) < 1


def test_enclosure_disappears_and_meal_escapes(engine):
    body = Body(2, Rect(200, 200, 900, 1000))
    engine.x, engine.y = 500, 600
    engine.set_world(engine.monitors, engine.surfaces, [body])
    engine.pick_up(500, 600)
    engine.release(500, 600)
    assert engine.enclosure == 2
    engine.set_mode('quiet_mode', False)
    engine.accept_meal(Meal('food.txt', 800, 600))
    engine.tick(.02)
    assert engine.enclosure is None and engine.purpose == 'meal'


def test_weighted_policy_only_chooses_allowed_actions():
    life = LifeState(hunger=100, curiosity=100)
    for draw in [0, .01, .3, .6, .99999]:
        assert choose_action(life, True, {'rest', 'sleep'}, draw) in {'rest', 'sleep'}


def test_hug_tracks_pointer_then_releases(engine):
    engine.pointer = engine.anchor(256, 286)
    assert engine.begin_hand('hug')
    x = engine.x
    for i in range(100): engine.tick(.02, (x - 50 + i, 850))
    assert engine.state in {'hand', 'fall', 'landing'}
    assert math.isfinite(engine.x) and math.isfinite(engine.y)
    advance(engine, 3)
    assert engine.state in {'idle', 'landing', 'sleep'}


def test_large_frame_delay_advances_needs_without_physics_explosion(engine):
    engine.x, engine.y = 600, 300
    engine.fall()
    engine.tick(600)
    assert engine.life.hunger == pytest.approx(37.8)
    assert engine.y < 310  # Animation/physics max50ms; life uses elapsed time.



def test_burst_at_bottom_right_keeps_24_ghosts_apart_and_pet_visible():
    from nuonuo.model import ghost_anchor
    work = Rect(0, 0, 1920, 1040)
    meals = []
    for i in range(24):
        x, y = ghost_anchor((1910, 1030), meals, work, 220)
        assert all(math.hypot(x - m.x, y - m.y) >= 48 for m in meals)
        assert y + (498.666 - 267) / 512 * 220 < work.bottom
        assert x + (512 - 45) / 512 * 220 < work.right
        meals.append(Meal(str(i), x, y))


def test_render_fit_used_for_collision_and_anchor(engine):
    engine.settings.pet_size = 440
    engine.render_size = 160
    engine.scale = 2
    assert engine.pixels == 320
    assert engine.collision_rect().width == pytest.approx(320 * .58)


def test_climb_success_and_slip_reach_valid_states(engine):
    engine.settings.quiet_mode = False
    target = Surface(2, 300, 900, 400, 1030)
    engine.set_world(engine.monitors, engine.surfaces + [target], [Body(2, Rect(300, 400, 900, 1030))])
    engine.climb_plan = engine.climb_target()
    assert engine.climb_plan
    engine.x = engine.climb_plan[3]
    engine.target = engine.x, engine.y
    engine.purpose = 'climb'
    engine.enter('move', 'walk')
    engine.tick(.02)
    assert engine.state == 'climb'
    engine.climb_success = True
    advance(engine, engine.duration + .1)
    assert engine.support.handle == 2 and engine.y == 400
    assert engine.life.curiosity < 48
    engine.home((900, 500))
    engine.next_climb = 0
    engine.climb_plan = engine.climb_target()
    engine.x = engine.climb_plan[3]
    engine.target = engine.x, engine.y
    engine.purpose = 'climb'
    engine.enter('move', 'walk')
    engine.tick(.02)
    engine.climb_success = False
    advance(engine, engine.duration * engine.climb_failure + .02)
    assert engine.state == 'fall'


def test_slide_loses_window_safely(engine):
    engine.slide_handle = 22
    engine.slide_side = 1
    engine.slide_start = 500
    engine.slide_end = 760
    engine.duration = 2.5
    engine.enter('slide', 'slide')
    engine.tick(.02)
    assert engine.state == 'fall'


def test_platform_vertical_launch_and_maximize(engine):
    s = Surface(2, 200, 900, 500, 950)
    engine.x, engine.y, engine.support = 400, 500, s
    engine.set_world(engine.monitors, engine.surfaces + [s], [Body(2, Rect(200, 500, 900, 950))])
    moved = Surface(2, 200, 900, 470, 920)
    engine.set_world(engine.monitors, [moved, engine.surfaces[0]], [Body(2, Rect(200, 470, 900, 920))], .05)
    assert engine.state == 'fall' and engine.vy == pytest.approx(-528)
    engine.x, engine.y, engine.support = 400, 470, moved
    engine.enter('idle', 'idle')
    engine.set_world(engine.monitors, [s for s in engine.surfaces if s.floor], [Body(2, Rect(0, 0, 1920, 1040), True)], .06)
    assert engine.state == 'fall' and engine.vy == -820


def test_multimonitor_negative_coordinates_and_dpi_crossing(engine):
    second = Monitor(3, Rect(-2560, 0, 0, 1440), Rect(-2560, 0, 0, 1400), 1.5)
    engine.set_world([*engine.monitors, second], [*engine.surfaces, Surface(3, -2560, -1, 1399, 1399, True)], [])
    engine.home((-1000, 800))
    assert engine.scale == 1.5 and -2560 < engine.x < 0 and engine.y == 1399
    engine.x, engine.y = -5, 500
    engine.fall(0, 600)
    advance(engine, .5)
    assert engine.x > 0
