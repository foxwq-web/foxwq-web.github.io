#!/usr/bin/env python3
"""Execute Fox's real x86 clock code to regenerate the regression fixture.

Usage: python native-countdown.py /path/to/foxwq.exe > native-countdown.json
Requires pefile and unicorn (install in a separate virtual environment).
No Windows process, network connection or audio device is opened.
"""
import hashlib
import json
import struct
import sys
from pathlib import Path

import pefile
from unicorn import Uc, UC_ARCH_X86, UC_MODE_32, UC_HOOK_CODE
from unicorn.x86_const import (
    UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_EDX,
    UC_X86_REG_ESI, UC_X86_REG_EDI, UC_X86_REG_EBP, UC_X86_REG_ESP, UC_X86_REG_EIP,
)

SHA256 = "beb4112eb519985c5d0a8af5c342a0152ff1fa82e523c16428981a803b29994d"


class NativeClock:
    STACK, OBJECT, STOP, GET_TICK_COUNT = 0x4000000, 0x5000000, 0x6000000, 0x6001000

    def __init__(self, path):
        assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == SHA256, "Wrong Fox binary"
        pe = pefile.PE(path)
        self.cpu = Uc(UC_ARCH_X86, UC_MODE_32)
        self.cpu.mem_map(pe.OPTIONAL_HEADER.ImageBase, (pe.OPTIONAL_HEADER.SizeOfImage + 4095) & ~4095)
        self.cpu.mem_write(pe.OPTIONAL_HEADER.ImageBase, pe.get_memory_mapped_image())
        self.cpu.mem_map(self.STACK, 0x10000)
        self.cpu.mem_map(self.OBJECT, 0x10000)
        self.cpu.mem_map(self.STOP, 0x2000)
        self.write(0xF27354, self.GET_TICK_COUNT)
        self.cpu.hook_add(UC_HOOK_CODE, self.hook)
        self.time = 0

    def write(self, address, value):
        self.cpu.mem_write(address, struct.pack("<I", value & 0xFFFFFFFF))

    def read(self, address):
        return struct.unpack("<i", self.cpu.mem_read(address, 4))[0]

    def hook(self, cpu, address, size, user):
        if address == self.GET_TICK_COUNT:
            cpu.reg_write(UC_X86_REG_EAX, self.time)
            sp = cpu.reg_read(UC_X86_REG_ESP)
            ret = self.read(sp) & 0xFFFFFFFF
            cpu.reg_write(UC_X86_REG_ESP, sp + 4)
            cpu.reg_write(UC_X86_REG_EIP, ret)

    def call(self, function, registers, arguments):
        sp = self.STACK + 0xFF00
        for i, value in enumerate([self.STOP, *arguments]):
            self.write(sp + i * 4, value)
        for register in [UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_EDX,
                         UC_X86_REG_ESI, UC_X86_REG_EDI, UC_X86_REG_EBP]:
            self.cpu.reg_write(register, 0)
        for register, value in registers.items():
            self.cpu.reg_write(register, value)
        self.cpu.reg_write(UC_X86_REG_ESP, sp)
        self.cpu.emu_start(function, self.STOP, count=10000)
        assert self.cpu.reg_read(UC_X86_REG_EIP) == self.STOP, "Clock failed to return"

    def setup(self, clock, color):
        self.time = 0
        self.cpu.mem_write(self.OBJECT, bytes(0x1000))
        self.write(self.OBJECT + 0xA0, clock["periodLength"])
        self.write(self.OBJECT + 0xA4, clock["periods"])
        player = 0x190 if color == 1 else 0x310
        self.write(self.OBJECT + player, 42)
        self.write(0x1B82BD0, 42)
        self.write(0x1B82BD4, 0)
        self.call(0x6E8FF0 if color == 1 else 0x6E9060, {
            UC_X86_REG_EAX: self.OBJECT, UC_X86_REG_ECX: clock["main"],
            UC_X86_REG_ESI: clock["byoyomi"], UC_X86_REG_EDI: 0,
        }, [clock["periods"]])

    def tick(self, milliseconds, color, own):
        self.time = milliseconds
        if own:
            self.call(0x6E7CD0, {UC_X86_REG_EAX: color, UC_X86_REG_EDI: self.OBJECT}, [0])
        else:
            self.call(0x6E7FD0, {UC_X86_REG_EAX: color, UC_X86_REG_ESI: self.OBJECT}, [0])
        offset = 0x280 if color == 1 else 0x400
        return {"ms": milliseconds, "main": self.read(self.OBJECT + offset),
                "seconds": self.read(self.OBJECT + offset + 4),
                "periods": self.read(self.OBJECT + offset + 8),
                "atMs": self.read(self.OBJECT + 0x6BC)}


    def notify(self, main, periods, seconds, color):
        # Stub only the room accessors, leaving the actual notification handler,
        # minimum-value guard and player setters as executable Fox instructions.
        room, vtable, message = self.OBJECT + 0x2000, self.OBJECT + 0x3000, self.OBJECT + 0x4000
        status, model = self.STOP + 0x100, self.STOP + 0x200
        self.cpu.mem_write(status, b"\xb8" + struct.pack("<I", 0x3F1) + b"\xc3")
        self.cpu.mem_write(model, b"\xb8" + struct.pack("<I", self.OBJECT) + b"\xc3")
        self.write(room, vtable)
        for offset, target in [(0x64, status), (0xB0, model), (0xB4, model)]:
            self.write(vtable + offset, target)
        for offset, value in [(8, main), (0xC, periods), (0x10, seconds),
                              (0x18, 42), (0x1C, 0), (0x2C, 0x10)]:
            self.write(message + offset, value)
        self.call(0x80C930, {UC_X86_REG_EAX: message, UC_X86_REG_ECX: room}, [self.time])
        offset = 0x280 if color == 1 else 0x400
        return [self.read(self.OBJECT + offset + i * 4) for i in range(3)]


def fixtures(path):
    native = NativeClock(path)
    cases = []
    scenarios = [
        ("period rollover", 0, 3, 60, 60, [0, 499, 500, 1000, 1500, 58000, 58499, 58500,
         59000, 59499, 59500, 60000, 60499, 60500, 60999, 61000, 119000, 120000, 121000, 121500]),
        ("main boundary", 5, 3, 60, 60, [0, 4499, 4500, 4999, 5000, 5499, 5500, 6500]),
        ("server zero", 0, 2, 0, 60, [0, 499, 500, 999, 1000, 1500]),
        ("partial period", 0, 3, 3, 30, [0, 2499, 2500, 3000, 3499, 3500, 4000, 33000, 34000]),
        ("last period", 0, 1, 2, 60, [0, 500, 1500, 2000, 2499, 2500, 3000, 4000]),
        ("late callback", 0, 3, 10, 30, [0, 500, 90000, 90250, 90500, 120500, 121000]),
        ("no overtime", 2, 0, 0, 60, [0, 500, 1500, 2000, 2500, 3000]),
    ]
    for color in [1, 2]:
        for own in [True, False]:
            for name, main, periods, seconds, length, times in scenarios:
                initial = {"main": main, "periods": periods, "byoyomi": seconds,
                           "periodLength": length, "at": 0}
                native.setup(initial, color)
                cases.append({"name": name, "color": color, "own": own, "initial": initial,
                              "ticks": [native.tick(t, color, own) for t in times]})
    # Verify the sync guard with both real player setters, too.
    for color in [1, 2]:
        native.setup({"main": 0, "periods": 3, "byoyomi": 60, "periodLength": 60}, color)
        native.tick(52000, color, True)
        assert native.notify(0, 3, 60, color) == [0, 8, 3]
        assert native.notify(0, 3, 9, color) == [0, 9, 3]
        assert native.notify(0, 2, 60, color) == [0, 60, 2]
        assert native.notify(0, 2, 0, color) == [0, 0, 2]
    return {"binarySha256": SHA256, "cases": cases}


if __name__ == "__main__":
    print(json.dumps(fixtures(sys.argv[1]), indent=2))
