"""Deterministic interaction policy, independent of Qt and model latency."""
from collections import OrderedDict
from datetime import datetime
import math
import time

COMMANDS = {'睡觉':'sleep', '去睡觉':'sleep', '醒醒':'wake', '回来':'home', '回家':'home', '跳一下':'hop', '翻个滚':'roll', '抱抱':'hug', '吃点心':'feed'}

def local_command(text):
    return COMMANDS.get(text.strip().rstrip('。！!'))

def is_drag(start, current, threshold=8):
    return math.dist(start, current) >= threshold

class ActionQueue:
    def __init__(self, capacity=16):
        self.capacity = capacity
        self.items = OrderedDict()

    def put(self, kind, value, priority=0):
        self.items.pop(kind, None)
        self.items[kind] = (priority, value, time.monotonic()+5)
        if len(self.items) > self.capacity:
            self.items.pop(min(self.items, key=lambda k:self.items[k][0]))

    def take(self, unsafe=False):
        for key,(_,_,expires) in list(self.items.items()):
            if expires < time.monotonic():self.items.pop(key)
        if unsafe or not self.items: return None
        key = max(self.items, key=lambda k:self.items[k][0])
        return key, self.items.pop(key)[1]

class Initiative:
    def __init__(self, saved=None):
        saved=saved if isinstance(saved,dict) else {}
        self.saved={'day':str(saved.get('day','')),'count':0,'last':0}
        for name in ('count','last'):
            value=saved.get(name,0)
            if isinstance(value,(int,float)) and math.isfinite(value):self.saved[name]=max(0,value)
        self.was_away = False

    def consider(self, now, idle, blocked=False):
        day = datetime.fromtimestamp(now).strftime('%Y-%m-%d')
        if self.saved.get('day') != day:
            self.saved.update(day=day, count=0)
        returning = self.was_away and idle < 3
        if idle >= 600: self.was_away = True
        elif idle < 3: self.was_away = False
        if blocked or idle >= 600 or now - self.saved.get('last', 0) < 2700 or self.saved.get('count',0) >= 6: return None
        self.saved.update(last=now, count=self.saved.get('count',0)+1)
        return '你回来啦，我在这里。' if returning else ('我在，有事点我就好。' if self.saved['count'] == 1 else '要不要歇一会儿，陪我玩一下？')
