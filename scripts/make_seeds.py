#!/usr/bin/env python3
import json, pathlib, re, struct, sys

rows=[]
for m in json.loads(pathlib.Path('analysis/message-vtables.json').read_text()):
    for i,a in enumerate(m['methods']):
        if i in (4,5,10,11):
            continue  # Shared MessageLite runtime methods, not per-message schema.
        rows.append(f"{a}\t{m['message']} vslot {i}")
    for a in m['refs']:
        rows.append(f"{a}\t{m['message']} constructor")
pathlib.Path('analysis/seeds.tsv').write_text('\n'.join(rows)+'\n')
if len(sys.argv)>1:
    b=pathlib.Path(sys.argv[1]).expanduser().read_bytes()
    meta=json.loads(pathlib.Path('analysis/binary.json').read_text())
    text=meta['sections'][0]
    def va(o): return int(meta['image_base'],16)+text['rva']+o-text['offset']
    anchors={}
    for line in pathlib.Path('analysis/strings.tsv').read_text().splitlines():
        addr,encoding,s=line.split('\t',2)
        if s in {'TGWHost','TGWPort','TGWLoginHost','TGWLoginPort','Server_Info','BtnAutoInvite','BtnFastGame','BtnSlowGame','CNFFieldSelectionDlg','TXTRES_HALLACTIONPANEL_SLOWGAME','TXTRES_NFFIELDSELECTDLG_STARTMATCH'}:
            anchors[int(addr,16)]=s
    for line in pathlib.Path('analysis/imports.tsv').read_text().splitlines():
        a,dll,name=line.split('\t')
        if dll.lower()=='ws2_32.dll' and name in {'ordinal_19','ordinal_16','ordinal_4','ordinal_3','ordinal_23'}:
            anchors[int(a,16)]='Winsock '+name
    for addr,label in anchors.items():
        for m in re.finditer(re.escape(struct.pack('<I',addr)),b):
            if text['offset']<=m.start()<text['offset']+text['raw_size']:
                rows.append(f'{hex(va(m.start()))}\tanchor: {label}')
    pathlib.Path('analysis/seeds.tsv').write_text('\n'.join(rows)+'\n')
