#!/usr/bin/env python3


import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile


def write_fixtures(path, data):
    formatted = json.dumps(data, indent=2)
    formatted = re.sub(r'\[\s*(-?\d+(?:,\s*-?\d+)*)\s*\]',
                       lambda match: '[' + re.sub(r'\s+', '', match[1]) + ']', formatted)
    path.write_text(formatted + '\n')


ENGINE_FIELDS = [('groupGridWithBorder', 0xe64bc, 420), ('groupLiberties', 0xe601c, 128),
                 ('groupSizes', 0xe609c, 128), ('groupLife', 0xe611c, 128),
                 ('cachedGroupLife', 0xfcc63, 128)]


def harness(directory, status, output, mode='estimate', fixture=None, include_engine=False, include_final=False):
    base, rva = 0x400000, 0x1000
    image, cursor = bytearray(0x3000), 0x1000

    def put(data):
        nonlocal cursor
        address = base + rva + cursor
        if len(image) < cursor + len(data):
            image.extend(bytes(cursor + len(data) - len(image)))
        image[cursor:cursor + len(data)] = data
        cursor = (cursor + len(data) + 3) & ~3
        return address

    def string(value):
        return put(value.encode() + b'\0')

    def windows(path):
        return 'Z:' + str(path).replace('/', '\\')

    directory_address = string(windows(directory))
    library = string(windows(directory / 'SE.dll'))
    export = string('ScoreEstimate')
    output_address = string(windows(output))
    board = put(bytes(map(int, status)))
    penalties, written = put(bytes((fixture or {}).get('penalties', [0, 0])) + bytes(30)), put(bytes(4))
    result_value = put(bytes(4))
    go_ownership, original_calc = put(bytes(361 * 4)), put(bytes(4))
    engine_size = sum(size for _, _, size in ENGINE_FIELDS)
    engine_state = put(bytes(engine_size)) if include_engine else 0
    engine_final = put(bytes(engine_size)) if include_final else 0
    neighbor_data = put(bytes(265)) if mode == 'go-neighbors' else 0
    liberty_data = put(bytes(10)) if mode == 'go-liberties' else 0
    zone_data = put(bytes(420)) if mode == 'go-zones' else 0
    budget_data = put(bytes(8)) if mode == 'go-budget' else 0
    plan_data = put(bytes(4096)) if mode == 'go-plan' else 0
    probe_data = put(bytes(16)) if mode == 'go-probe' else 0
    atari_data = put(bytes(8)) if mode == 'go-atari' else 0
    life_override = put(bytes(fixture['life_override'])) if fixture and 'life_override' in fixture else 0
    fixture = fixture or {}
    if mode == 'go-plan':
        plan_input = bytearray(4096)
        plan_input[5] = len(fixture['replies'])
        plan_input[6] = fixture.get('analyzed', 0)
        for i, reply in enumerate(fixture['replies']):
            child = 512 + i * 8
            struct.pack_into('<HH', plan_input, 7 + 4 * i, reply['point'], child)
            plan_input[child + 2] = reply.get('result', 0)
            if 'child' in reply:
                struct.pack_into('<H', plan_input, 9 + 4 * i, reply['child'])
        plan_input_address = put(plan_input)
    cases = fixture.get('cases')
    if cases:
        records = bytearray()
        for case in cases:
            ko = case.get('ko', {'point': 0, 'color': 0})
            records.extend(struct.pack('<4I', case.get('group', case.get('point', 0)),
                case.get('limit', case.get('color', 0) << 8), ko['point'] | (ko['color'] << 16),
                case.get('group', 0) if mode in ('go-atari', 'go-candidates') else 0))
        records_address = put(records)
        record_cursor = put(struct.pack('<I', records_address))
        result_size = {'go-liberties': 10, 'go-probe': 16, 'go-atari': 8, 'go-candidates': 12}[mode]
        batch_data = put(bytes(len(cases) * result_size))
        batch_cursor = put(struct.pack('<I', batch_data))
        helper_base = put(bytes(4))
    context_data = bytearray(struct.pack('<I', 19) + bytes(0xb24 - 4))
    if 'previous' in fixture:
        previous = fixture['previous']
        struct.pack_into('<I', context_data, 8, previous['maxLabel'])
        context_data[12:373] = bytes(previous['labels'])
        if 'lastLiberty' in previous:
            for n, point in enumerate(previous['lastLiberty']):
                context_data[0x930 + n * 2:0x932 + n * 2] = bytes([point // 19, point % 19])
    context = put(context_data) if mode in ('groups', 'regions', 'expand-region') else 0
    color_map = put(bytes(fixture['map'])) if mode in ('color-map', 'dead-groups') else 0
    dead = put(bytes(fixture['dead'])) if mode in ('dead-groups', 'atari', 'connectivity', 'edges', 'recursive', 'penalties') else 0
    flags = put(bytes(fixture['flags'])) if mode in ('atari', 'edges', 'recursive', 'penalties') else 0
    prior = put(bytes(fixture['prior'])) if mode == 'recursive' else 0
    intercept = base + rva + 0x400
    names = ['SetDllDirectoryA', 'LoadLibraryA', 'GetProcAddress', 'CreateFileA',
             'WriteFile', 'CloseHandle', 'ExitProcess', 'Sleep', 'VirtualProtect']
    kernel = string('KERNEL32.dll')
    hints = [put(b'\0\0' + name.encode() + b'\0') - base for name in names]
    table = b''.join(struct.pack('<I', value) for value in hints + [0])
    original_thunks, iat = put(table) - base, put(table)
    descriptor = put(struct.pack('<IIIII', original_thunks, 0, 0, kernel - base,
                                 iat - base) + bytes(20)) - base
    functions = {name: iat + i * 4 for i, name in enumerate(names)}
    code = bytearray()

    def push(value):
        code.extend(b'\x68' + struct.pack('<I', value & 0xffffffff))

    def invoke(name):
        code.extend(b'\xff\x15' + struct.pack('<I', functions[name]))

    push(directory_address); invoke('SetDllDirectoryA')
    push(library); invoke('LoadLibraryA')
    push(export); code.extend(b'\x50'); invoke('GetProcAddress')
    code.extend(b'\x89\xc5')


    if mode == 'keepalive':
        push(600000); invoke('Sleep')
    elif mode in ('groups', 'regions'):
        code.extend(b'\xbe' + struct.pack('<I', context))
        offset = 0x115a if mode == 'groups' else 0x142c
        code.extend(b'\x8d\x85' + struct.pack('<i', offset - 0x51fb))
        if mode == 'regions':
            push(fixture['color'])
        push(board); code.extend(b'\xff\xd0')
        if mode == 'groups':
            code.extend(b'\x83\xc4\x04')
    elif mode == 'color-map':
        code.extend(b'\x8d\x85' + struct.pack('<i', 0x1922 - 0x51fb))
        push(19); push(fixture['color']); push(board); push(color_map)
        code.extend(b'\xff\xd0\x83\xc4\x10')
    elif mode == 'dead-groups':
        code.extend(b'\x8d\x85' + struct.pack('<i', 0x1b38 - 0x51fb))
        code.extend(b'\xb9' + struct.pack('<I', color_map))
        push(19); push(fixture['color']); push(dead); push(board)
        code.extend(b'\xff\xd0\x83\xc4\x10')
    elif mode == 'two-liberties':
        code.extend(b'\x8d\x85' + struct.pack('<i', 0x3556 - 0x51fb))
        move, anchor, reply = fixture['move'], fixture['anchor'], fixture['reply']
        code.extend(b'\xb9' + struct.pack('<I', move // 19))
        code.extend(b'\xba' + struct.pack('<I', move % 19))
        push(board); push(fixture['color']); push(reply % 19); push(reply // 19)
        push(anchor % 19 if anchor >= 0 else 0); push(anchor // 19 if anchor >= 0 else -1)
        if 'scratchLiberties' in fixture:


            code.extend(b'\x60\x8d\xbc\x24' + struct.pack('<i', -0x1e0))
            code.extend(b'\xb9' + struct.pack('<I', 247) + b'\x31\xc0')
            if fixture['scratchLiberties']:
                code.extend(b'\x66\x40\x66\xab\xe2\xfa')
            else:
                code.extend(b'\xf3\x66\xab')
            code.extend(b'\x61')
        code.extend(b'\xff\xd0\x83\xc4\x18\xa3' + struct.pack('<I', penalties))
    elif mode == 'atari':
        code.extend(b'\x8d\x85' + struct.pack('<i', 0x3919 - 0x51fb))
        code.extend(b'\xb9' + struct.pack('<I', board))
        code.extend(b'\xba' + struct.pack('<I', dead))
        push(flags); code.extend(b'\xff\xd0\x83\xc4\x04')
    elif mode == 'connectivity':
        code.extend(b'\x8d\x85' + struct.pack('<i', 0x1e70 - 0x51fb))
        code.extend(b'\xb9' + struct.pack('<I', board))
        code.extend(b'\xba' + struct.pack('<I', 19))
        push(dead); code.extend(b'\xff\xd0\x83\xc4\x04')
    elif mode == 'edges':
        code.extend(b'\x8d\x85' + struct.pack('<i', 0x4084 - 0x51fb))
        code.extend(b'\xb9' + struct.pack('<I', board))
        code.extend(b'\xba' + struct.pack('<I', flags))
        push(dead); push(19); code.extend(b'\xff\xd0\x83\xc4\x08')
    elif mode == 'expand-region':
        code.extend(b'\x8d\x85' + struct.pack('<i', 0x1722 - 0x51fb))
        code.extend(b'\xbb' + struct.pack('<I', context))
        push(fixture['point'] % 19); push(fixture['point'] // 19); push(board)
        code.extend(b'\xff\xd0\xa3' + struct.pack('<I', penalties))
    elif mode == 'recursive':
        code.extend(b'\x8d\x85' + struct.pack('<i', 0x3c62 - 0x51fb))
        code.extend(b'\xb9' + struct.pack('<I', board))
        push(prior); push(dead); push(flags)
        code.extend(b'\xff\xd0\x83\xc4\x0c\xa3' + struct.pack('<I', penalties))
    elif mode == 'penalties':
        code.extend(b'\x8d\x85' + struct.pack('<i', 0x2b1c - 0x51fb))
        code.extend(b'\xb9' + struct.pack('<I', board))
        code.extend(b'\xba' + struct.pack('<I', dead))
        push(penalties); push(flags); code.extend(b'\xff\xd0\x83\xc4\x08')
        code.extend(b'\xa3' + struct.pack('<I', result_value))
    else:
        code.extend(b'\x8d\x85' + struct.pack('<i', 0x1000 - 0x51fb) + b'\xff\xd0')
        code.extend(b'\x8d\x85' + struct.pack('<i', -0x51fb))
        code.extend(b'\x8b\x90' + struct.pack('<I', 0xd788))
        code.extend(b'\x89\x15' + struct.pack('<I', original_calc))
        code.extend(b'\xc7\x80' + struct.pack('<II', 0xd788, intercept))
        if mode == 'calc-address':
            code.extend(b'\x89\x15' + struct.pack('<I', board))
        else:
            push(penalties); push(board); push(19)
            code.extend(b'\xff\xd5\x83\xc4\x0c')
    write_entry = base + rva + len(code)
    for value in [0, 128, 2, 0, 0, 0x40000000, output_address]:
        push(value)
    invoke('CreateFileA'); code.extend(b'\x89\xc3')
    outputs = ([(budget_data, 8)] if mode == 'go-budget' else
               [(plan_data, 4096)] + ([(result_value, 4)] if 'insert' in fixture else []) if mode == 'go-plan' else
               [(zone_data, 420)] if mode == 'go-zones' else
               [(batch_data, len(cases) * result_size)] if cases else
               [(engine_state, engine_size), (result_value, 4), (penalties, 4)] if mode == 'go-play' else
               [(engine_state, engine_size)] if mode in ('go-groups', 'go-life-entry') else
               [(neighbor_data, 265)] if mode == 'go-neighbors' else
               [(liberty_data, 10)] if mode == 'go-liberties' else
               [(probe_data, 16)] if mode == 'go-probe' else
               [(atari_data, 8)] if mode == 'go-atari' else
               [(context, 0xb24)] if mode in ('groups', 'regions') else
               [(context, 0xb24), (penalties, 4)] if mode == 'expand-region' else
               [(color_map, 361)] if mode == 'color-map' else
               [(board, 361), (dead, 361), (color_map, 361)] if mode == 'dead-groups' else
               [(board, 361), (penalties, 4)] if mode == 'two-liberties' else
               [(board, 361), (dead, 361), (flags, 361)] if mode in ('atari', 'edges') else
               [(board, 361), (dead, 361)] if mode == 'connectivity' else
               [(board, 361), (flags, 361), (dead, 361), (prior, 361), (penalties, 4)] if mode == 'recursive' else
               [(board, 361), (dead, 361), (flags, 361), (penalties, 2), (result_value, 4)] if mode == 'penalties' else
               [(board, 361), (penalties, 2), (go_ownership, 361 * 4)] +
               ([(engine_state, engine_size)] if include_engine else []) +
               ([(engine_final, engine_size)] if include_final else []))
    for address, size in outputs:
        for value in [0, written, size, address]:
            push(value)
        code.extend(b'\x53'); invoke('WriteFile')
    code.extend(b'\x53'); invoke('CloseHandle')
    push(0); invoke('ExitProcess')
    assert len(code) < 0x1000, 'Harness entry overlaps data'
    image[:len(code)] = code


    before_calc = bytearray()
    if include_engine:


        before_calc.extend(b'\x9c\x60\x8b\x1d' + struct.pack('<I', original_calc))
        before_calc.extend(b'\x81\xeb' + struct.pack('<I', 0x12f0))
        offset = 0
        for _, source, size in ENGINE_FIELDS:
            before_calc.extend(b'\x8d\xb3' + struct.pack('<I', source))
            before_calc.extend(b'\xbf' + struct.pack('<I', engine_state + offset))
            before_calc.extend(b'\xb9' + struct.pack('<I', size) + b'\xf3\xa4')
            offset += size
        before_calc.extend(b'\x61\x9d')
    after_calc = bytearray()
    if include_final:
        after_calc.extend(b'\x9c\x60\x8b\x1d' + struct.pack('<I', original_calc))
        after_calc.extend(b'\x81\xeb' + struct.pack('<I', 0x12f0))
        offset = 0
        for _, source, size in ENGINE_FIELDS:
            after_calc.extend(b'\x8d\xb3' + struct.pack('<I', source))
            after_calc.extend(b'\xbf' + struct.pack('<I', engine_final + offset))
            after_calc.extend(b'\xb9' + struct.pack('<I', size) + b'\xf3\xa4')
            offset += size
        after_calc.extend(b'\x61\x9d')
    if cases:


        helper = bytearray(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0))
        helper.extend(b'\xa3' + struct.pack('<I', helper_base))
        loop = len(helper)
        helper.extend(b'\x8b\x35' + struct.pack('<I', record_cursor))
        helper.extend(b'\x8b\x2d' + struct.pack('<I', helper_base))
        helper.extend(b'\x8b\x46\x08\x89\x85' + struct.pack('<I', 0xe6018))
        helper.extend(b'\x8b\x46\x0c\x89\x85' + struct.pack('<I', 0xfbe8e))
        helper.extend(b'\x89\xe8\x05' + struct.pack('<I', {'go-liberties': 0x4f312, 'go-probe': 0x12ba8, 'go-atari': 0x4f07c, 'go-candidates': 0x4f312}[mode]))
        helper.extend(b'\x8b\x16') if mode == 'go-probe' else helper.extend(b'\x8b\x1e')
        if mode == 'go-probe':
            helper.extend(b'\x8b\x56\x04\x8b\x36')
        elif mode in ('go-liberties', 'go-candidates'):
            helper.extend(b'\x8b\x56\x04')
        helper.extend(b'\xff\xd0')
        if mode == 'go-candidates':
            helper.extend(b'\x88\xc2\xa1' + struct.pack('<I', helper_base))
            helper.extend(b'\x05' + struct.pack('<I', 0x4f35d) + b'\xff\xd0')
        if mode == 'go-atari':
            helper.extend(b'\x9c\x5a\x81\xe2' + struct.pack('<I', 0xc1))
            helper.extend(b'\x8b\x3d' + struct.pack('<I', batch_cursor) + b'\x89\x17\x89\x77\x04')
        else:
            helper.extend(b'\x89\xfa\x8b\x3d' + struct.pack('<I', batch_cursor))
            if mode == 'go-liberties':
                helper.extend(b'\x88\x07\x0f\x92\x47\x01')
            elif mode == 'go-probe':
                helper.extend(b'\x0f\x92\x07\x89\x57\x04')
            helper.extend(b'\xa1' + struct.pack('<I', helper_base))
            fields = [(0x110ef6, 0, 8), (0xf921c, 8, 4)] if mode == 'go-candidates' else [(0xf9154, 2, 8)] if mode == 'go-liberties' else [
                (0xf9168, 1, 1), (0xe601b, 2, 1), (0xe6018, 8, 4), (0xf9160, 12, 4)]
            for source, destination, size in fields:
                helper.extend(b'\x8d\xb0' + struct.pack('<I', source))
                helper.extend(b'\x8b\x3d' + struct.pack('<I', batch_cursor))
                helper.extend(b'\x83\xc7' + bytes([destination]))
                helper.extend(b'\xb9' + struct.pack('<I', size) + b'\xf3\xa4')
        helper.extend(b'\x83\x05' + struct.pack('<I', record_cursor) + b'\x10')
        helper.extend(b'\x83\x05' + struct.pack('<I', batch_cursor) + bytes([result_size]))
        helper.extend(b'\x81\x3d' + struct.pack('<II', record_cursor, records_address + len(records)))
        helper.extend(b'\x0f\x82' + struct.pack('<i', loop - (len(helper) + 6)))
        helper.extend(b'\xb8' + struct.pack('<I', write_entry) + b'\xff\xe0')
        wrapper = helper
    elif mode == 'go-budget':
        helper = bytearray(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0) + b'\x89\xc3')
        for source, value, size in [(0x10f273, fixture['parentLimit'], 4), (0x10f277, fixture['childLimit'], 4),
            (0xe9123, fixture['cursor'], 2), (0xf914b, fixture['rootAllowance'], 2),
            (0x10f26f, fixture['depth'], 1), (0xf9148, fixture['mode'], 1),
            (0xe9128, fixture['candidateCount'], 1), (0xe9127, fixture.get('nodeResult', 0), 1)]:
            helper.extend((b'\xc6\x83' if size == 1 else b'\x66\xc7\x83' if size == 2 else b'\xc7\x83') + struct.pack('<I', source))
            helper.extend(value.to_bytes(size, 'little'))
        helper.extend(b'\x8d\xb3' + struct.pack('<I', 0x4de51))
        helper.extend(b'\xbd' + struct.pack('<I', 2) + b'\xb9' + struct.pack('<I', fixture['remaining']))
        helper.extend(b'\xb8' + struct.pack('<I', fixture.get('accumulator', 0)) + b'\xff\xd6')
        helper.extend(b'\x0f\x92\x05' + struct.pack('<I', budget_data + 6))
        helper.extend(b'\x66\x89\x0d' + struct.pack('<I', budget_data + 4))
        helper.extend(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0))
        for source, target, size in [(0x10f277, budget_data, 4), (0xe9127, budget_data + 7, 1)]:
            helper.extend(b'\x8d\xb0' + struct.pack('<I', source) + b'\xbf' + struct.pack('<I', target))
            helper.extend(b'\xb9' + struct.pack('<I', size) + b'\xf3\xa4')
        helper.extend(b'\xb8' + struct.pack('<I', write_entry) + b'\xff\xe0')
        wrapper = helper
    elif mode == 'go-plan':
        helper = bytearray(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0) + b'\x89\xc3')
        helper.extend(b'\xbe' + struct.pack('<I', plan_input_address))
        helper.extend(b'\x8d\xbb' + struct.pack('<I', 0xe9123))
        helper.extend(b'\xb9' + struct.pack('<I', 4096) + b'\xf3\xa4')
        helper.extend(b'\xc6\x83' + struct.pack('<I', 0xf9148) + bytes([fixture.get('search_mode', 0)]))
        helper.extend(b'\xbd' + struct.pack('<I', 2))
        if 'insert' in fixture:
            helper.extend(b'\x8d\x8b' + struct.pack('<I', 0x503b5 if fixture['priority'] else 0x5038b))
            helper.extend(b'\xb8' + struct.pack('<I', fixture['insert']))
            helper.extend(b'\xbf' + struct.pack('<I', fixture.get('cursor', 7 + 4 * len(fixture['replies']))))
            helper.extend(b'\xff\xd1\x89\x3d' + struct.pack('<I', result_value))
        else:
            helper.extend(b'\x8d\x83' + struct.pack('<I', 0x50b53) + b'\xff\xd0')
        helper.extend(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0))
        helper.extend(b'\x8d\xb0' + struct.pack('<I', 0xe9123) + b'\xbf' + struct.pack('<I', plan_data))
        helper.extend(b'\xb9' + struct.pack('<I', 4096) + b'\xf3\xa4')
        helper.extend(b'\xb8' + struct.pack('<I', write_entry) + b'\xff\xe0')
        wrapper = helper
    elif mode == 'go-zones':
        helper = bytearray(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0))
        helper.extend(b'\x8d\xb0' + struct.pack('<I', 0xe632c) + b'\xbf' + struct.pack('<I', zone_data))
        helper.extend(b'\xb9' + struct.pack('<I', 420) + b'\xf3\xa4')
        helper.extend(b'\xb8' + struct.pack('<I', write_entry) + b'\xff\xe0')
        wrapper = helper
    elif mode == 'go-life-entry':
        helper = bytearray(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0) + b'\x89\xc3')
        if life_override:
            helper.extend(b'\xbe' + struct.pack('<I', life_override))
            helper.extend(b'\x8d\xbb' + struct.pack('<I', 0xe611c))
            helper.extend(b'\xb9' + struct.pack('<I', 128) + b'\xf3\xa4')
        for value in [written, 0x40, 9]:
            helper.extend(b'\x68' + struct.pack('<I', value))
        helper.extend(b'\x8d\x83' + struct.pack('<I', 0x4dac9) + b'\x50')
        helper.extend(b'\xff\x15' + struct.pack('<I', functions['VirtualProtect']))


        helper.extend(b'\xc6\x83' + struct.pack('<I', 0x4dac9) + b'\xb8')
        helper.extend(b'\xc7\x83' + struct.pack('<I', 0x4daca))
        destination_slot = len(helper); helper.extend(bytes(4))
        helper.extend(b'\x66\xc7\x83' + struct.pack('<I', 0x4dace) + b'\xff\xe0')
        helper.extend(b'\x8d\x83' + struct.pack('<I', 0x4d6bb) + b'\xff\xd0')
        struct.pack_into('<I', helper, destination_slot, intercept + len(helper))
        helper.extend(before_calc)
        helper.extend(b'\xb8' + struct.pack('<I', write_entry) + b'\xff\xe0')
        wrapper = helper
    elif mode == 'go-play':
        helper = bytearray(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0))
        helper.extend(b'\x89\xc3')
        if life_override:
            helper.extend(b'\xbe' + struct.pack('<I', life_override))
            helper.extend(b'\x8d\xbb' + struct.pack('<I', 0xe611c))
            helper.extend(b'\xb9' + struct.pack('<I', 128) + b'\xf3\xa4')
        ko = fixture.get('ko', {'point': 0, 'color': 0})
        helper.extend(b'\xc7\x83' + struct.pack('<II', 0xe6018, ko['point'] | (ko['color'] << 16)))
        helper.extend(b'\xc7\x83' + struct.pack('<II', 0xfbe8e, fixture.get('activeTarget', 0)))
        helper.extend(b'\xc6\x83' + struct.pack('<I', 0xf922a) + b'\x00')
        helper.extend(b'\x05' + struct.pack('<I', 0x12bed))
        helper.extend(b'\xbe' + struct.pack('<I', fixture['point']))
        helper.extend(b'\xba' + struct.pack('<I', fixture['color'] << 8) + b'\xff\xd0')
        helper.extend(b'\x0f\x92\x05' + struct.pack('<I', result_value))
        helper.extend(b'\xa2' + struct.pack('<I', result_value + 1))
        helper.extend(b'\x88\x1d' + struct.pack('<I', result_value + 2))
        helper.extend(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0))
        for source, target, size in [(0xe601b, result_value + 3, 1), (0xe6018, penalties, 4)]:
            helper.extend(b'\x8d\xb0' + struct.pack('<I', source) + b'\xbf' + struct.pack('<I', target))
            helper.extend(b'\xb9' + struct.pack('<I', size) + b'\xf3\xa4')
        helper.extend(before_calc)
        helper.extend(b'\xb8' + struct.pack('<I', write_entry) + b'\xff\xe0')
        wrapper = helper
    elif mode == 'go-groups':
        wrapper = before_calc + b'\xb8' + struct.pack('<I', write_entry) + b'\xff\xe0'
    elif mode == 'go-atari':
        helper = bytearray(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0))
        helper.extend(b'\x89\xc3')
        ko = fixture.get('ko', {'point': 0, 'color': 0})
        helper.extend(b'\xc7\x83' + struct.pack('<II', 0xe6018, ko['point'] | (ko['color'] << 16)))
        helper.extend(b'\xc7\x83' + struct.pack('<II', 0xfbe8e, fixture['group']))
        helper.extend(b'\x05' + struct.pack('<I', 0x4f07c))
        helper.extend(b'\xbb' + struct.pack('<I', fixture['group']) + b'\xff\xd0')
        helper.extend(b'\x9c\x58\x25' + struct.pack('<I', 0xc1))
        helper.extend(b'\xa3' + struct.pack('<I', atari_data))
        helper.extend(b'\x89\x35' + struct.pack('<I', atari_data + 4))
        helper.extend(b'\xb8' + struct.pack('<I', write_entry) + b'\xff\xe0')
        wrapper = helper
    elif mode == 'go-probe':
        helper = bytearray(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0))
        helper.extend(b'\x89\xc3')
        ko = fixture.get('ko', {'point': 0, 'color': 0})
        helper.extend(b'\xc7\x83' + struct.pack('<II', 0xe6018, ko['point'] | (ko['color'] << 16)))
        helper.extend(b'\x05' + struct.pack('<I', 0x12ba8))
        helper.extend(b'\xbe' + struct.pack('<I', fixture['point']))
        helper.extend(b'\xba' + struct.pack('<I', fixture['color'] << 8) + b'\xff\xd0')
        helper.extend(b'\x0f\x92\x05' + struct.pack('<I', probe_data))
        helper.extend(b'\x89\x3d' + struct.pack('<I', probe_data + 4))
        helper.extend(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0))
        for source, target, size in [(0xf9168, probe_data + 1, 1), (0xe601b, probe_data + 2, 1),
                                    (0xe6018, probe_data + 8, 4), (0xf9160, probe_data + 12, 4)]:
            helper.extend(b'\x8d\xb0' + struct.pack('<I', source) + b'\xbf' + struct.pack('<I', target))
            helper.extend(b'\xb9' + struct.pack('<I', size) + b'\xf3\xa4')
        helper.extend(b'\xb8' + struct.pack('<I', write_entry) + b'\xff\xe0')
        wrapper = helper
    elif mode == 'go-liberties':
        helper = bytearray(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0))
        helper.extend(b'\x05' + struct.pack('<I', 0x4f312))
        helper.extend(b'\xbb' + struct.pack('<I', fixture['group']))
        helper.extend(b'\xba' + struct.pack('<I', fixture['limit']) + b'\xff\xd0')
        helper.extend(b'\xa2' + struct.pack('<I', liberty_data))
        helper.extend(b'\x0f\x92\x05' + struct.pack('<I', liberty_data + 1))
        helper.extend(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0))
        helper.extend(b'\x8d\xb0' + struct.pack('<I', 0xf9154) + b'\xbf' + struct.pack('<I', liberty_data + 2))
        helper.extend(b'\xb9' + struct.pack('<I', 8) + b'\xf3\xa4')
        helper.extend(b'\xb8' + struct.pack('<I', write_entry) + b'\xff\xe0')
        wrapper = helper
    elif mode == 'go-neighbors':


        helper = bytearray(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0))
        helper.extend(b'\x05' + struct.pack('<I', 0x1c18e))
        helper.extend(b'\xbb' + struct.pack('<I', fixture['group']))
        helper.extend(b'\xba' + struct.pack('<I', fixture['limit']) + b'\xff\xd0')
        helper.extend(b'\x89\x3d' + struct.pack('<I', neighbor_data))
        helper.extend(b'\x89\x0d' + struct.pack('<I', neighbor_data + 4))
        helper.extend(b'\x0f\x92\x05' + struct.pack('<I', neighbor_data + 8))
        helper.extend(b'\xa1' + struct.pack('<I', original_calc) + b'\x2d' + struct.pack('<I', 0x12f0))
        for source, target in [(0xe7969, neighbor_data + 9), (0x105c4f, neighbor_data + 137)]:
            helper.extend(b'\x8d\xb0' + struct.pack('<I', source) + b'\xbf' + struct.pack('<I', target))
            helper.extend(b'\xb9' + struct.pack('<I', 128) + b'\xf3\xa4')
        helper.extend(b'\xb8' + struct.pack('<I', write_entry) + b'\xff\xe0')
        wrapper = helper
    else:
        wrapper = (b'\x55\x89\xe5\x56\x57' + before_calc + b'\xff\x75\x08\xff\x15' +
               struct.pack('<I', original_calc) + b'\x83\xc4\x04' + after_calc + b'\x50\x8b\x75\x08\xbf' +
               struct.pack('<I', go_ownership) + b'\xb9' + struct.pack('<I', 361) +
               b'\xf3\xa5\x58\x5f\x5e\x5d\xc3')
    if mode in ('estimate', 'go-neighbors', 'go-groups', 'go-liberties', 'go-probe', 'go-atari', 'go-candidates', 'go-play', 'go-life-entry', 'go-zones', 'go-plan', 'go-budget'):
        image[0x400:0x400 + len(wrapper)] = wrapper
    image.extend(bytes((-len(image)) % 512))
    headers = bytearray(512)
    headers[:2] = b'MZ'
    struct.pack_into('<I', headers, 60, 128)
    headers[128:132] = b'PE\0\0'
    struct.pack_into('<HHIIIHH', headers, 132, 0x14c, 1, 0, 0, 0, 224, 0x102)
    optional = 152
    struct.pack_into('<H', headers, optional, 0x10b)
    struct.pack_into('<III', headers, optional + 16, rva, rva, rva)
    struct.pack_into('<III', headers, optional + 28, base, 4096, 512)
    struct.pack_into('<HH', headers, optional + 40, 4, 0)
    struct.pack_into('<HH', headers, optional + 48, 4, 0)
    struct.pack_into('<II', headers, optional + 56, ((rva + len(image) + 4095) // 4096) * 4096, 512)
    struct.pack_into('<H', headers, optional + 68, 3)
    struct.pack_into('<IIIIII', headers, optional + 72, 0x100000, 4096, 0x100000,
                     4096, 0, 16)
    struct.pack_into('<II', headers, optional + 104, descriptor, 40)
    section = optional + 224
    headers[section:section + 8] = b'.all\0\0\0\0'
    struct.pack_into('<IIII', headers, section + 8, len(image), rva, len(image), 512)
    struct.pack_into('<I', headers, section + 36, 0xe0000060)
    return headers + image


def run_native(executable):
    environment = {**os.environ, 'WINEDEBUG': '-all', 'MVK_CONFIG_LOG_LEVEL': '0'}
    environment['WINEDLLOVERRIDES'] = ';'.join(filter(None, [environment.get('WINEDLLOVERRIDES'),
        'winecoreaudio.drv=d;winealsa.drv=d;winepulse.drv=d']))
    environment.setdefault('WINEPREFIX', str(Path.home() / '.foxweiqi'))
    subprocess.run([shutil.which('wine') or 'wine', str(executable)], env=environment,
        check=True, timeout=45, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def batch_queries(data, directory, mode):
    groups = {}
    for fixture in data['positions']:
        status = fixture.get('status') or data['boards'][fixture['board']]['status']
        groups.setdefault(status, []).append(fixture)
    result_size = {'go-liberties': 10, 'go-probe': 16, 'go-atari': 8, 'go-candidates': 12}[mode]
    results = {}
    for status, fixtures in groups.items():
        with tempfile.TemporaryDirectory(prefix='fox-native-batch-') as temp:
            temp = Path(temp)
            executable, output = temp / 'queries.exe', temp / 'result.bin'
            executable.write_bytes(harness(directory, status, output, mode, {'cases': fixtures}))
            run_native(executable)
            result = output.read_bytes()
            assert len(result) == len(fixtures) * result_size
            for i, fixture in enumerate(fixtures):
                results[id(fixture)] = result[i * result_size:(i + 1) * result_size]
        print(f"Captured native {mode} batch: {len(fixtures)} queries", flush=True)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fixtures', type=Path)
    parser.add_argument('--update', action='store_true')
    parser.add_argument('--batch', action='store_true', help='Batch independent GoStar private queries by board')
    parser.add_argument('--engine-final', action='store_true', help='Also capture GoStar group state after native CalcTerritory')
    parser.add_argument('--engine-state', action='store_true', help='Also capture GoStar group state immediately before CalcTerritory')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--groups', action='store_true', help='Capture SE group/liberty routine')
    modes.add_argument('--regions', action='store_true', help='Capture SE empty-region routine')
    modes.add_argument('--color-map', action='store_true', help='Capture SE per-color correction routine')
    modes.add_argument('--dead-groups', action='store_true', help='Capture SE zero-liberty ownership groups')
    modes.add_argument('--two-liberties', action='store_true', help='Capture SE tactical two-liberty probe')
    modes.add_argument('--atari', action='store_true', help='Capture SE atari correction pass')
    modes.add_argument('--connectivity', action='store_true', help='Capture SE gap/connectivity pass')
    modes.add_argument('--edges', action='store_true', help='Capture SE edge tactical correction pass')
    modes.add_argument('--expand-region', action='store_true', help='Capture SE removal/region-expansion routine')
    modes.add_argument('--recursive', action='store_true', help='Capture SE recursive correction decision')
    modes.add_argument('--penalties', action='store_true', help='Capture SE one false-eye/penalty pass')
    modes.add_argument('--go-neighbors', action='store_true', help='Capture GoStar neighboring-group helper on native board state')
    modes.add_argument('--go-budget', action='store_true', help='Capture deterministic native search child allocation budget')
    modes.add_argument('--go-plan', action='store_true', help='Capture native search reply ordering/reduction')
    modes.add_argument('--go-zones', action='store_true', help='Capture native static board-zone tags')
    modes.add_argument('--go-life-entry', action='store_true', help='Capture native life-search preparation before its first tactical helper')
    modes.add_argument('--go-play', action='store_true', help='Capture committed GoStar move and resulting full group state')
    modes.add_argument('--go-candidates', action='store_true', help='Capture GoStar extension candidate ranking (requires --batch)')
    modes.add_argument('--go-atari', action='store_true', help='Capture GoStar cheap one-liberty search entry')
    modes.add_argument('--go-probe', action='store_true', help='Capture GoStar non-committing tactical move probe')
    modes.add_argument('--go-liberties', action='store_true', help='Capture GoStar liberty candidate ordering')
    modes.add_argument('--go-groups', action='store_true', help='Capture GoStar group construction without running territory estimation')
    parser.add_argument('--fox-directory', type=Path, default=Path.home() /
                        '.foxweiqi/drive_c/Program Files (x86)/foxwq/foxwq')
    args = parser.parse_args()
    mode = ('groups' if args.groups else 'regions' if args.regions else
            'color-map' if args.color_map else 'dead-groups' if args.dead_groups else
            'two-liberties' if args.two_liberties else 'atari' if args.atari else
            'connectivity' if args.connectivity else 'edges' if args.edges else
            'expand-region' if args.expand_region else 'recursive' if args.recursive else
            'penalties' if args.penalties else 'go-neighbors' if args.go_neighbors else
            'go-groups' if args.go_groups else 'go-liberties' if args.go_liberties else 'go-probe' if args.go_probe else 'go-atari' if args.go_atari else 'go-candidates' if args.go_candidates else 'go-play' if args.go_play else 'go-life-entry' if args.go_life_entry else 'go-zones' if args.go_zones else 'go-plan' if args.go_plan else 'go-budget' if args.go_budget else 'estimate')
    assert not (args.engine_state or args.engine_final) or mode == 'estimate'
    include_engine = args.engine_state or mode in ('go-groups', 'go-play', 'go-life-entry')
    data = json.loads(args.fixtures.read_text())
    hashes = {name: hashlib.sha256((args.fox_directory / name).read_bytes()).hexdigest()
              for name in ['SE.dll', 'GoStar5M.dll']}
    if 'dll_sha256' in data:
        assert hashes == data['dll_sha256'], 'Installed Fox DLL differs from reference'
    data['dll_sha256'] = hashes
    assert mode != 'go-candidates' or args.batch
    assert not args.batch or mode in ('go-liberties', 'go-probe', 'go-atari', 'go-candidates')
    batched = batch_queries(data, args.fox_directory.resolve(), mode) if args.batch else {}
    for fixture in data['positions']:
        status = fixture.get('status') or data['boards'][fixture['board']]['status']
        if mode not in ('estimate', 'go-neighbors', 'go-groups', 'go-liberties', 'go-probe', 'go-atari', 'go-candidates', 'go-play', 'go-life-entry', 'go-zones', 'go-plan', 'go-budget'):
            assert len(status) == 361 and all(0 <= n <= 255 for n in status)
        else:
            assert len(status) == 361 and set(status) <= set('012')
        with tempfile.TemporaryDirectory(prefix='fox-native-score-') as temp:
            temp = Path(temp)
            executable, output = temp / 'estimate.exe', temp / 'ownership.bin'
            if args.batch:
                result = batched[id(fixture)]
            else:
                executable.write_bytes(harness(args.fox_directory.resolve(), status, output, mode, fixture, include_engine, args.engine_final))
                run_native(executable)
                result = output.read_bytes()
            if mode == 'go-budget':
                assert len(result) == 8
                captured = {'budget': {'limit': struct.unpack_from('<I', result)[0],
                    'remaining': struct.unpack_from('<H', result, 4)[0], 'exhausted': bool(result[6]), 'nodeResult': result[7]}}
            elif mode == 'go-plan':
                assert len(result) == (4100 if 'insert' in fixture else 4096)
                candidates = []
                for i in range(result[5] if 'insert' in fixture else len(fixture['replies'])):
                    point, child = struct.unpack_from('<HH', result, 7 + 4 * i)
                    candidates.append({'point': point, 'child': child} if 'insert' in fixture else
                                      {'point': point, 'result': result[child + 2]})
                captured = {'insertion': {'candidateCount': result[5], 'candidates': candidates,
                    'cursor': struct.unpack_from('<I', result, 4096)[0]}} if 'insert' in fixture else {
                    'selection': {'result': result[4], 'candidates': candidates}}
            elif mode == 'go-zones':
                assert len(result) == 420
                captured = {'zones': [result[21 + y * 20 + x] for y in range(19) for x in range(19)]}
            elif mode == 'go-play':
                assert len(result) == sum(size for _, _, size in ENGINE_FIELDS) + 8
                state, offset = {}, 0
                for name, _, size in ENGINE_FIELDS:
                    state[name] = list(result[offset:offset + size]); offset += size
                legal = not bool(result[offset])
                captured = {'play_state': state, 'move': {'legal': legal,
                    'group': result[offset + 2], 'liberties': result[offset + 1],
                    'captures': result[offset + 3] if legal else 0,
                    'ko': {'point': struct.unpack_from('<H', result, offset + 4)[0], 'color': result[offset + 6]}}}
            elif mode in ('go-groups', 'go-life-entry'):
                assert len(result) == sum(size for _, _, size in ENGINE_FIELDS)
                state_key = 'life_entry' if mode == 'go-life-entry' else 'go_groups'
                captured = {state_key: {}}
                offset = 0
                for name, _, size in ENGINE_FIELDS:
                    captured[state_key][name] = list(result[offset:offset + size])
                    offset += size
            elif mode == 'go-candidates':
                assert len(result) == 12
                count = fixture['limit']
                captured = {'candidates': {'points': list(struct.unpack_from('<4H', result))[:count],
                                          'scores': list(result[8:8 + count])}}
            elif mode == 'go-atari':
                assert len(result) == 8
                flags, point = struct.unpack('<II', result)
                captured = {'entry': {'point': point, 'flags': flags}}
            elif mode == 'go-probe':
                assert len(result) == 16
                count = struct.unpack_from('<I', result, 4)[0]
                legal = not bool(result[0])
                assert not legal or count <= 4
                ko = {'point': struct.unpack_from('<H', result, 8)[0], 'color': result[10]}
                captured = {'probe': {'legal': legal, 'liberties': result[1] if legal else 0,
                    'friendlyGroups': list(result[12:12 + count]) if legal else [],
                    'captures': result[2] if legal else 0, 'ko': ko}}
            elif mode == 'go-liberties':
                assert len(result) == 10
                count = result[0]
                captured = {'points': list(struct.unpack_from('<4H', result, 2))[:min(count, 4)],
                            'count': count, 'unsupported': bool(result[1])}
            elif mode == 'go-neighbors':
                assert len(result) == 265
                count, atari = struct.unpack_from('<II', result)
                assert count < 128 and atari <= count
                captured = {'groups': list(result[9:9 + count]), 'weights': list(result[137:137 + atari]),
                            'atariCount': atari, 'unsupported': bool(result[8])}
            elif mode in ('groups', 'regions', 'expand-region'):
                assert len(result) == (0xb28 if mode == 'expand-region' else 0xb24)
                captured = {'maxLabel': struct.unpack_from('<I', result, 8)[0],
                            'labels': list(result[12:12 + 361]),
                            'sizes': list(struct.unpack_from('<247i', result, 0x178))}
                if mode == 'groups':
                    captured.update(count=struct.unpack_from('<I', result, 4)[0],
                                    liberties=list(struct.unpack_from('<247i', result, 0x554)),
                                    lastLiberty=[result[0x930 + n * 2] * 19 + result[0x931 + n * 2] for n in range(247)])
                else:
                    captured['borderMasks'] = list(result[0x554:0x554 + 247])
                    if mode == 'expand-region':
                        captured['removed'] = struct.unpack_from('<I', result, 0xb24)[0]
            elif mode == 'color-map':
                assert len(result) == 361
                captured = {'result': list(result)}
            elif mode == 'dead-groups':
                assert len(result) == 361 * 3
                assert list(result[722:]) == fixture['map']
                captured = {'flags': list(result[:361]), 'dead_result': list(result[361:722])}
            elif mode == 'two-liberties':
                assert len(result) == 365
                captured = {'board_result': list(result[:361]),
                            'success': struct.unpack_from('<I', result, 361)[0]}
                assert captured['success'] in (0, 1)
            elif mode in ('atari', 'edges'):
                assert len(result) == 1083
                captured = {'board_result': list(result[:361]), 'dead_result': list(result[361:722]),
                            'flags_result': list(result[722:])}
            elif mode == 'connectivity':
                assert len(result) == 722
                assert list(result[361:]) == fixture['dead']
                captured = {'board_result': list(result[:361])}
            elif mode == 'recursive':
                assert len(result) == 1448
                assert list(result[:361]) == fixture['status']
                assert list(result[361:722]) == fixture['flags']
                assert list(result[722:1083]) == fixture['dead']
                captured = {'prior_result': list(result[1083:1444]),
                            'changed': struct.unpack_from('<I', result, 1444)[0]}
                assert captured['changed'] in (0, 1)
            elif mode == 'penalties':
                assert len(result) == 1089
                captured = {'board_result': list(result[:361]), 'dead_result': list(result[361:722]),
                            'flags_result': list(result[722:1083]), 'penalties_result': list(result[1083:1085]),
                            'changed': struct.unpack_from('<I', result, 1085)[0]}
                assert captured['changed'] in (0, 1)
            else:
                normal_size = 363 + 361 * 4
                assert len(result) == normal_size + (sum(n for _, _, n in ENGINE_FIELDS) * (int(args.engine_state) + int(args.engine_final)))
                captured = {'ownership': ''.join(str(n) for n in result[:361]),
                            'black_penalty': result[361], 'white_penalty': result[362]}
                go = struct.unpack_from('<361I', result, 363)
                assert set(go) <= {0, 1, 2, 3}
                captured['go_ownership'] = ''.join(str(n) for n in go)
                if args.engine_state:
                    offset = normal_size
                    captured['go_groups'] = {}
                    for name, _, size in ENGINE_FIELDS:
                        captured['go_groups'][name] = list(result[offset:offset + size])
                        offset += size
                if args.engine_final:
                    offset = normal_size + (sum(n for _, _, n in ENGINE_FIELDS) if args.engine_state else 0)
                    captured['go_final'] = {}
                    for name, _, size in ENGINE_FIELDS:
                        captured['go_final'][name] = list(result[offset:offset + size]); offset += size
            if args.update:


                for key in captured:
                    if key in fixture:
                        assert fixture[key] == captured[key], (fixture['name'], key)
                fixture.update(captured)


                if not args.batch:
                    write_fixtures(args.fixtures, data)
            else:
                assert all(fixture[key] == value for key, value in captured.items()), fixture['name']
            if not args.batch:
                print(f"Native Fox verified: {fixture['name']}")
    if args.update and args.batch:
        write_fixtures(args.fixtures, data)
    if args.batch:
        print(f"Native Fox verified: {len(data['positions'])} independent queries")


if __name__ == '__main__':
    main()
