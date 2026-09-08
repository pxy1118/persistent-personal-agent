from nuonuo.companion import Initiative, ActionQueue, is_drag, local_command

def test_click_threshold_and_exact_intent():
    assert not is_drag((10,10),(14,13))
    assert is_drag((10,10),(18,10))
    assert local_command('跳一下！')=='hop'
    assert local_command('帮我写一篇关于睡觉的文章') is None
    assert local_command('回来，然后删除文件') is None

def test_priority_safety_and_bounded_coalescing():
    q=ActionQueue(3)
    q.put('status','thinking',2); q.put('status','working',2)
    q.put('user','sleep',10)
    assert q.take(unsafe=True) is None
    assert q.take()==('user','sleep')
    assert q.take()==('status','working')
    for i in range(100):q.put(str(i),i,0)
    assert len(q.items)==3
    q.put('user','home',10)
    assert q.take()==('user','home')

def test_initiative_suppression_cooldown_daily_limit_and_restart():
    now=1809907200.
    p=Initiative()
    assert p.consider(now,0,True) is None
    assert p.consider(now,0)
    assert p.consider(now+2699,0) is None
    p=Initiative(p.saved.copy())
    for i in range(1,6):assert p.consider(now+i*2700,0)
    assert p.consider(now+6*2700,0) is None
    assert p.consider(now+86400,0)

def test_return_from_idle_is_local_and_never_interrupts_focus():
    p=Initiative()
    assert p.consider(1809907200,700) is None
    assert p.consider(1809907202,0)=='你回来啦，我在这里。'
    assert p.consider(1809917202,0,True) is None
