#!/usr/bin/env python3
"""Dependency-free PE section and string inventory (no user configuration)."""
import hashlib, json, pathlib, re, struct, sys

p = pathlib.Path(sys.argv[1]).expanduser()
b = p.read_bytes()
u16 = lambda o: struct.unpack_from('<H', b, o)[0]
u32 = lambda o: struct.unpack_from('<I', b, o)[0]
pe = u32(0x3c)
assert b[pe:pe+4] == b'PE\0\0'
opt = pe+24
base = u32(opt+28)
sections = []
for i in range(u16(pe+6)):
    o = opt+u16(pe+20)+40*i
    sections.append(dict(name=b[o:o+8].rstrip(b'\0').decode(), virtual_size=u32(o+8), rva=u32(o+12), raw_size=u32(o+16), offset=u32(o+20)))
out = pathlib.Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
(out/'binary.json').write_text(json.dumps(dict(name=p.name,sha256=hashlib.sha256(b).hexdigest(),size=len(b),image_base=hex(base),entry=hex(base+u32(opt+16)),sections=sections),indent=2)+'\n')
def va(off):
    for s in sections:
        if s['offset'] <= off < s['offset']+s['raw_size']:
            return hex(base+s['rva']+off-s['offset'])
    return 'unmapped'
def offset(rva):
    for s in sections:
        if s['rva'] <= rva < s['rva']+s['raw_size']:
            return s['offset']+rva-s['rva']
    raise ValueError(hex(rva))
def cstring(o):
    return b[o:b.index(b'\0',o)].decode('ascii',errors='replace')
imports=[]
descriptor=offset(u32(opt+104))
while u32(descriptor+12):
    dll=cstring(offset(u32(descriptor+12)))
    thunk=u32(descriptor) or u32(descriptor+16)
    iat=u32(descriptor+16)
    i=0
    while (entry:=u32(offset(thunk)+4*i)):
        name=f'ordinal_{entry&0xffff}' if entry&0x80000000 else cstring(offset(entry)+2)
        imports.append(f'{hex(base+iat+4*i)}\t{dll}\t{name}')
        i+=1
    descriptor+=20
(out/'imports.tsv').write_text('\n'.join(imports)+'\n')
with (out/'strings.tsv').open('w') as f:
    for pat, encoding in [(rb'[\x20-\x7e]{5,}', 'ascii'), (rb'(?:[\x20-\x7e]\x00){5,}', 'utf-16le')]:
        for m in re.finditer(pat,b):
            f.write(f'{va(m.start())}\t{encoding}\t{m.group().decode(encoding)}\n')
