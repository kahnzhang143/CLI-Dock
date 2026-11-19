# -*- coding: utf-8 -*-
"""示例：Python 计时器。用来演示 python 程序的导入、参数与日志。"""
import argparse
import datetime
import sys
import time


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--rounds", type=int, default=0)
    args = parser.parse_args()

    print(f"[tick] 启动于 {datetime.datetime.now():%Y-%m-%d %H:%M:%S}  pid={__import__('os').getpid()}", flush=True)
    i = 0
    while True:
        i += 1
        print(f"[tick] 第 {i} 次输出 {datetime.datetime.now():%H:%M:%S}", flush=True)
        if i % 5 == 0:
            print(f"[tick] 模拟错误输出，用于演示 stderr 高亮", file=sys.stderr, flush=True)
        if args.rounds and i >= args.rounds:
            print("[tick] 达到循环上限，正常退出", flush=True)
            return 0
        time.sleep(max(0.1, args.interval))


if __name__ == "__main__":
    raise SystemExit(main())
