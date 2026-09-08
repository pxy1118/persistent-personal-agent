"""Small, explicitly typed Win32 adapter. Does not delete or move user files."""
from __future__ import annotations

import ctypes as C
from ctypes import wintypes as W
import logging
import os
from pathlib import Path
import sys
from .physics import Rect, Monitor, Surface, Body

IS_WINDOWS = sys.platform == 'win32'
log = logging.getLogger(__name__)


if IS_WINDOWS:
    user = C.WinDLL('user32', use_last_error=True)
    kernel = C.WinDLL('kernel32', use_last_error=True)
    dwm = C.WinDLL('dwmapi', use_last_error=True)
    CALLBACK = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
    MON_CALLBACK = C.WINFUNCTYPE(W.BOOL, W.HMONITOR, W.HDC, C.POINTER(W.RECT), W.LPARAM)

    def api(dll, name, restype, *args):
        fn = getattr(dll, name)
        fn.restype, fn.argtypes = restype, list(args)
        return fn

    api(user, 'EnumWindows', W.BOOL, CALLBACK, W.LPARAM)
    api(user, 'EnumDisplayMonitors', W.BOOL, W.HDC, C.POINTER(W.RECT), MON_CALLBACK, W.LPARAM)
    api(user, 'GetWindowRect', W.BOOL, W.HWND, C.POINTER(W.RECT))
    api(user, 'GetWindowThreadProcessId', W.DWORD, W.HWND, C.POINTER(W.DWORD))
    api(user, 'GetWindowLongPtrW', C.c_ssize_t, W.HWND, C.c_int)
    api(user, 'GetClassNameW', C.c_int, W.HWND, W.LPWSTR, C.c_int)
    api(user, 'IsWindowVisible', W.BOOL, W.HWND)
    api(user, 'IsIconic', W.BOOL, W.HWND)
    api(user, 'IsZoomed', W.BOOL, W.HWND)
    api(user, 'GetCursorPos', W.BOOL, C.POINTER(W.POINT))
    api(user, 'SetWindowPos', W.BOOL, W.HWND, W.HWND, C.c_int, C.c_int, C.c_int, C.c_int, W.UINT)
    api(dwm, 'DwmGetWindowAttribute', C.c_long, W.HWND, W.DWORD, C.c_void_p, W.DWORD)

    class MonitorInfo(C.Structure):
        _fields_ = [('size', W.DWORD), ('monitor', W.RECT), ('work', W.RECT), ('flags', W.DWORD), ('device', W.WCHAR * 32)]
    api(user, 'GetMonitorInfoW', W.BOOL, W.HMONITOR, C.POINTER(MonitorInfo))



def enable_dpi_awareness():
    if IS_WINDOWS:
        try:
            api(user, 'SetProcessDpiAwarenessContext', W.BOOL, C.c_void_p)(C.c_void_p(-4))
        except (AttributeError, OSError):
            pass  # Qt also requests per-monitor DPI awareness during initialization.


def rect(r): return Rect(r.left, r.top, r.right, r.bottom)


def monitors():
    if not IS_WINDOWS:
        from PySide6.QtGui import QGuiApplication
        return [Monitor(i + 1, Rect(s.geometry().left(), s.geometry().top(), s.geometry().right() + 1, s.geometry().bottom() + 1),
                        Rect(s.availableGeometry().left(), s.availableGeometry().top(), s.availableGeometry().right() + 1, s.availableGeometry().bottom() + 1), 1, s.name())
                for i, s in enumerate(QGuiApplication.screens())]
    result = []
    @MON_CALLBACK
    def collect(handle, hdc, bounds, extra):
        info = MonitorInfo()
        info.size = C.sizeof(info)
        if user.GetMonitorInfoW(handle, C.byref(info)):
            dx, dy = W.UINT(96), W.UINT(96)
            try:
                fn = api(C.WinDLL('shcore'), 'GetDpiForMonitor', C.c_long, W.HMONITOR, C.c_int, C.POINTER(W.UINT), C.POINTER(W.UINT))
                fn(handle, 0, C.byref(dx), C.byref(dy))
            except OSError:
                pass
            result.append(Monitor(int(handle), rect(info.monitor), rect(info.work), dx.value / 96, info.device))
        return True
    user.EnumDisplayMonitors(None, None, collect, 0)
    return result


def nearest_monitor(items, x, y):
    return min(items, key=lambda m: max(m.bounds.left - x, 0, x - m.bounds.right) ** 2 + max(m.bounds.top - y, 0, y - m.bounds.bottom) ** 2)


def cursor():
    if IS_WINDOWS:
        p = W.POINT()
        if user.GetCursorPos(C.byref(p)): return p.x, p.y
    from PySide6.QtGui import QCursor
    p = QCursor.pos()
    return p.x(), p.y()


def class_for_window(hwnd):
    out = C.create_unicode_buffer(512)
    user.GetClassNameW(hwnd, out, len(out))
    return out.value


def window_rect(hwnd):
    r = W.RECT()
    if dwm.DwmGetWindowAttribute(hwnd, 9, C.byref(r), C.sizeof(r)) == 0 or user.GetWindowRect(hwnd, C.byref(r)):
        return rect(r)
    return None


IGNORED = {'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'DV2ControlHost',
           'tooltips_class32', 'Windows.UI.Core.CoreWindow', 'XamlExplorerHostIslandWindow'}


def window_bodies(exclude=()):
    if not IS_WINDOWS: return []
    result = []
    @CALLBACK
    def collect(hwnd, extra):
        try:
            pid = W.DWORD()
            user.GetWindowThreadProcessId(hwnd, C.byref(pid))
            if hwnd in exclude or pid.value == os.getpid() or not user.IsWindowVisible(hwnd) or user.IsIconic(hwnd): return True
            cls = class_for_window(hwnd)
            if cls in IGNORED: return True
            exstyle, style = user.GetWindowLongPtrW(hwnd, -20), user.GetWindowLongPtrW(hwnd, -16)
            if exstyle & (0x8000080 | 0x20): return True
            cloaked = C.c_int()
            if dwm.DwmGetWindowAttribute(hwnd, 14, C.byref(cloaked), 4) == 0 and cloaked.value: return True
            fragments = ['录屏', '屏幕录制', '截图', '截屏', 'screencapture', 'screen capture', 'screenrecord', 'screenshot']
            if any(x in cls.lower() for x in fragments): return True
            if exstyle & 0x80000 and exstyle & 8 and not style & 0xC00000: return True
            r = window_rect(hwnd)
            if r and r.width >= 140 and r.height >= 60:
                result.append(Body(int(hwnd), r, bool(user.IsZoomed(hwnd))))
        except Exception:
            log.exception('Window enumeration failed for %s', hwnd)
        return True
    user.EnumWindows(collect, 0)
    return result  # EnumWindows yields front-to-back Z order.


def surfaces(monitors_, bodies):
    found = [Surface(m.handle, m.work.left, m.work.right - 1, m.work.bottom - 1, m.work.bottom - 1, True) for m in monitors_]
    for b in bodies:
        r = b.rect
        for m in monitors_:
            w = m.work
            if r.bottom > w.top and w.top + 36 < r.top < w.bottom - 30:
                left, right = max(r.left, w.left), min(r.right, w.right)
                if right - left >= 140:
                    found.append(Surface(b.handle, left, right - 1, r.top, r.bottom))
    return sorted(found, key=lambda s: s.top)


def place_window(hwnd, x, y):
    if IS_WINDOWS:
        user.SetWindowPos(hwnd, None, round(x), round(y), 0, 0, 0x0015)  # NOSIZE | NOZORDER | NOACTIVATE




def idle_seconds():
    if not IS_WINDOWS: return 0.
    class LastInput(C.Structure):
        _fields_ = [("size", W.UINT), ("tick", W.DWORD)]
    info = LastInput()
    info.size = C.sizeof(info)
    if user.GetLastInputInfo(C.byref(info)):
        return ((kernel.GetTickCount() - info.tick) & 0xffffffff) / 1000
    return 0.
