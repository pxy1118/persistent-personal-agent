import argparse

if __name__=='__main__':
    parser=argparse.ArgumentParser(description='PPA 灵动桌宠')
    parser.add_argument('--data-dir',help='PPA 数据目录；桌宠状态保存到其 pet 子目录')
    for name in ['mute','quiet','no-tray','debug','no-backend','chat','exercise']:
        parser.add_argument('--'+name,action='store_true')
    parser.add_argument('--seed',type=int)
    parser.add_argument('--report')
    parser.add_argument('--screenshot',help='仅保存本应用窗口，不截取桌面')
    parser.add_argument('--quit-after',type=float)
    try:
        from nuonuo.app import run
        raise SystemExit(run(parser.parse_args()))
    except Exception as exc:
        import traceback
        traceback.print_exc()
        # pythonw has no console, so startup failures must remain visible.
        import ctypes
        ctypes.windll.user32.MessageBoxW(None,str(exc),'PPA 桌宠启动失败',0x10)
        raise SystemExit(1)
