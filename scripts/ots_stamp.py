#!/usr/bin/env python3
"""OpenTimestamps 的最小封装：只做 stamp / upgrade / report，不碰钱包。

官方的 `ots` 命令行在 Windows 上起不来，因为 otsclient.cmds 在 import 阶段就会
加载 python-bitcoinlib，而它在 Windows 上会 ctypes 去 LoadLibrary('ssl') 失败。
我们从来不用钱包相关的功能，所以把 bitcoin.* 这一串用空壳模块顶掉，只复用
otsclient 里的时间戳逻辑（提交到日历、合并升级、解析证明）。

用法：
  python scripts/ots_stamp.py report  <file.txt>
  python scripts/ots_stamp.py stamp   <file.txt> [<file2.txt> ...]
  python scripts/ots_stamp.py upgrade <file.txt> [<file2.txt> ...]

输出：一行 JSON（stdout），形如
  {"ok": true, "files": [{"path": "...", "state": "pending"|"confirmed", "height": 841203, ...}]}
"""

import json
import os
import sys
import types


class _StubModule(types.ModuleType):
    """任何属性访问都返回一个同样可以继续取属性的空壳，用来顶掉 bitcoin.*"""

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _StubModule(self.__name__ + "." + name)

    def __call__(self, *args, **kwargs):
        return _StubModule(self.__name__ + "()")


def _install_bitcoin_stub():
    for name in (
        "bitcoin",
        "bitcoin.rpc",
        "bitcoin.core",
        "bitcoin.core.key",
        "bitcoin.core.script",
        "bitcoin.core.serialize",
        "bitcoin.wallet",
        "bitcoin.base58",
        "bitcoin.params",
        "bitcoin.script",
        "bitcoin.script.opcodes",
        "bitcoin.script.script",
        "bitcoin.script.standard",
        "bitcoin.encoding",
        "bitcoin.messages",
        "bitcoin.serialize",
        "bitcoin.wallet",
    ):
        sys.modules.setdefault(name, _StubModule(name))


_install_bitcoin_stub()

import logging  # noqa: E402

logging.basicConfig(level=logging.ERROR)

import opentimestamps.calendar  # noqa: E402
import otsclient.cmds as cmds  # noqa: E402
from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation  # noqa: E402
from opentimestamps.core.serialize import BytesSerializationContext, StreamSerializationContext, StreamDeserializationContext  # noqa: E402
from opentimestamps.core.timestamp import DetachedTimestampFile  # noqa: E402
from opentimestamps.core.op import OpSHA256  # noqa: E402

CALENDARS = [
    "https://a.pool.opentimestamps.org",
    "https://b.pool.opentimestamps.org",
    "https://alice.btc.calendar.opentimestamps.org",
    "https://bob.btc.calendar.opentimestamps.org",
]


class Args:
    """冒充 otsclient 的 argparse 结果，只填我们用得到的字段"""

    def __init__(self, calendars, whitelist):
        self.use_btc_wallet = False
        self.setup_bitcoin = False
        self.m = 2
        self.timeout = 12
        self.calendar_urls = calendars
        self.whitelist = whitelist
        self.cache = {}
        self.wait = False
        self.wait_interval = 8


def read_stamp(path):
    with open(path, "rb") as f:
        ctx = StreamDeserializationContext(f)
        return DetachedTimestampFile.deserialize(ctx)


def write_stamp(path, stamp):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        ctx = StreamSerializationContext(f)
        stamp.serialize(ctx)
    os.replace(tmp, path)


def describe(stamp):
    """从证明里挑出第一个比特币区块高度，以及是否还是 pending"""
    height = None
    pending = 0
    for msg, att in stamp.timestamp.all_attestations():
        if isinstance(att, BitcoinBlockHeaderAttestation):
            if height is None or att.height < height:
                height = att.height
        elif isinstance(att, PendingAttestation):
            pending += 1
    return height, pending


def report(path):
    stamp = read_stamp(path)
    height, pending = describe(stamp)
    return {
        "path": path,
        "msg": stamp.timestamp.msg.hex(),
        "height": height,
        "pending": pending,
    }


def stamp_file(path):
    with open(path, "rb") as f:
        stamp = DetachedTimestampFile.from_fd(OpSHA256(), f)
    args = Args(CALENDARS, {})
    cmds.create_timestamp(stamp.timestamp, CALENDARS, args)
    write_stamp(path + ".ots", stamp)
    return report(path + ".ots")


def upgrade_file(path):
    ots = path + ".ots"
    stamp = read_stamp(ots)
    height, _ = describe(stamp)
    if height is not None:
        return report(ots)
    args = Args([], set(CALENDARS))
    cmds.upgrade_timestamp(stamp.timestamp, args)
    write_stamp(ots, stamp)
    return report(ots)


def main(argv):
    if len(argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: ots_stamp.py <report|stamp|upgrade> <file>..."}))
        return 2
    mode, paths = argv[1], argv[2:]
    out = []
    try:
        for path in paths:
            single = {"path": path}
            if mode == "stamp":
                if os.path.exists(path + ".ots"):
                    single = report(path + ".ots")
                else:
                    single = stamp_file(path)
            elif mode == "upgrade":
                single = upgrade_file(path)
            else:
                single = report(path + ".ots" if not path.endswith(".ots") else path)
            out.append(single)
    except Exception as exc:  # 网络、日历、格式，任何一种都不该炸掉整次构建
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc), "files": out}))
        return 1
    print(json.dumps({"ok": True, "files": out}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
