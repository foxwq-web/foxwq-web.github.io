#!/usr/bin/env python3
"""Find MSVC x86 RTTI/vtables for selected protobuf classes in a PE32 file."""
import json, pathlib, re, struct, sys

b = pathlib.Path(sys.argv[1]).expanduser().read_bytes()
meta = json.loads(pathlib.Path('analysis/binary.json').read_text())
base = int(meta['image_base'],16)
def va(off):
    for s in meta['sections']:
        if s['offset'] <= off < s['offset']+s['raw_size']:
            return base+s['rva']+off-s['offset']
    raise ValueError(off)
def off(addr):
    for s in meta['sections']:
        if base+s['rva'] <= addr < base+s['rva']+s['raw_size']:
            return s['offset']+addr-base-s['rva']
    raise ValueError(addr)
def refs(addr, aligned=True):
    return [m.start() for m in re.finditer(re.escape(struct.pack('<I',addr)),b) if not aligned or m.start()%4==0]
selected = set(pathlib.Path(sys.argv[2]).read_text().splitlines())
out = []
for m in re.finditer(rb'\.\?AV([^\0]+)\0',b):
    parts=m[1].decode().rstrip('@').split('@')
    name='.'.join(reversed(parts))
    if name not in selected: continue
    td=va(m.start()-8)
    for r in refs(td):
        col=r-12
        if struct.unpack_from('<III',b,col)!=(0,0,0): continue
        for vr in refs(va(col)):
            vt=vr+4; methods=[]
            for i in range(18):
                a=struct.unpack_from('<I',b,vt+4*i)[0]
                if not base+4096 <= a < base+4096+meta['sections'][0]['virtual_size']: break
                methods.append(hex(a))
            if methods:
                out.append(dict(message=name,vtable=hex(va(vt)),methods=methods,refs=[hex(va(x)) for x in refs(va(vt),False) if base+4096 <= va(x) < base+4096+meta['sections'][0]['virtual_size']]))
pathlib.Path(sys.argv[3] if len(sys.argv)>3 else 'analysis/message-vtables.json').write_text(json.dumps(out,indent=2)+'\n')
print(f'{len(out)} message vtables recovered')
