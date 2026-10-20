#!/usr/bin/env python3


import argparse, collections, gzip, hashlib, json, pathlib, re, struct, subprocess
import capstone as cs
from capstone.x86 import X86_OP_REG, X86_OP_IMM, X86_OP_MEM
import pefile

HERE = pathlib.Path(__file__).resolve().parent
ESTIMATOR = HERE.parent
PINS = {'SE.dll': '52833c1d75e11b16e4b8db03207aecdc4722136fe44ad675eebb6611a3e1e921',
        'GoStar5M.dll': 'a3db40c7c59294f96df2dca1a9c45a72140309aa64fa7922c188758afc979f60'}
BASES = {'SE.dll': 0x100000, 'GoStar5M.dll': 0x200000}
SHIMS = {0x29cf0e:'CRT!malloc',0x29cfd8:'CRT!free',0x29b07c:'CRT!atexit',
         0x29c531:'CRT!time64',0x29c50a:'CRT!localtime64',0x29cbec:'CRT!ftime64'}
REGS = {}
for n, names in enumerate([('eax','ax','al','ah'),('ecx','cx','cl','ch'),('edx','dx','dl','dh'),
                           ('ebx','bx','bl','bh'),('esp','sp'),('ebp','bp'),('esi','si'),('edi','di')]):
    for j,name in enumerate(names): REGS[name]=(n,[32,16,8,8][j],8 if j==3 else 0)
CONDS = dict(zip(['o','no','b','ae','e','ne','be','a','s','ns','p','np','l','ge','le','g'],range(16)))
ALIASES = {'z':'e','nz':'ne','c':'b','nc':'ae','na':'be','nbe':'a','nb':'ae','nae':'b',
           'pe':'p','po':'np','nge':'l','nl':'ge','ng':'le','nle':'g'}

def u32(data, offset): return struct.unpack_from('<I', data, offset)[0]
def store32(data, offset, value): struct.pack_into('<I', data, offset, value & 0xffffffff)
def cstring(image, offset): return image[offset:image.index(0, offset)].decode('ascii')

class Translation:
    def __init__(self):
        self.images={}; self.exports={}; self.services=dict(SHIMS); self.insns={}; self.unsupported={}
        self.decoder=cs.Cs(cs.CS_ARCH_X86,cs.CS_MODE_32); self.decoder.detail=True
        self.outlines={}; self.outline_calls={}; self.outline_min_uses=32
        self.roots=set(); self.entries=set(); self.ranges=[]; self.import_cursor=0x600000
    def load(self,name):
        raw=(ESTIMATOR/'dll'/name).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=PINS[name]: raise ValueError(f'Unverified engine version: {name}')
        pe=pefile.PE(data=raw); base=BASES[name]; preferred=pe.OPTIONAL_HEADER.ImageBase
        if pe.FILE_HEADER.Machine!=0x14c or pe.OPTIONAL_HEADER.Magic!=0x10b: raise ValueError('Expected x86 PE32')
        image=bytearray(pe.get_memory_mapped_image()); image.extend(bytes(pe.OPTIONAL_HEADER.SizeOfImage-len(image)))
        code=[]
        for s in pe.sections:
            if s.Characteristics&0x20000000:
                code.append((base+s.VirtualAddress,base+s.VirtualAddress+s.Misc_VirtualSize))
        self.ranges+=code
        def executable(a):return any(lo<=a<hi for lo,hi in code)
        for block in pe.DIRECTORY_ENTRY_BASERELOC:
            for entry in block.entries:
                if entry.type==0: continue
                if entry.type!=3:raise ValueError(f'Unsupported relocation: {entry.type}')
                value=(u32(image,entry.rva)+base-preferred)&0xffffffff
                store32(image,entry.rva,value)
                if executable(value):self.roots.add(value)
        self.exports[name]={x.name.decode():base+x.address for x in pe.DIRECTORY_ENTRY_EXPORT.symbols if x.name}
        self.roots.update(self.exports[name].values())
        for dll in pe.DIRECTORY_ENTRY_IMPORT:
            for imp in dll.imports:
                address=self.import_cursor;self.import_cursor+=16
                self.services[address]=dll.dll.decode()+'!'+(imp.name.decode() if imp.name else f'ordinal_{imp.ordinal}')
                store32(image,imp.address-preferred,address)
        self.images[base]=image
    def decode(self):
        self.entries.update(self.roots)
        queue=list(sorted(self.roots))
        while queue:
            address=queue.pop()
            if address in self.insns or address in self.services:continue
            if not any(lo<=address<hi for lo,hi in self.ranges):continue
            base=max(b for b in self.images if b<=address);off=address-base
            insn=next(self.decoder.disasm(self.images[base][off:off+15],address,count=1),None)
            if insn is None:continue
            self.insns[address]=insn
            mnemonic=insn.mnemonic.split()[-1]
            if insn.group(cs.CS_GRP_JUMP) or insn.group(cs.CS_GRP_CALL):
                if insn.operands[0].type==X86_OP_IMM:
                    target=insn.operands[0].imm & 0xffffffff
                    queue.append(target);self.entries.add(target)
                if insn.group(cs.CS_GRP_CALL):self.entries.add(address+insn.size)
            if mnemonic not in ['ret','retf','jmp','int3','hlt','ud2','iretd']:
                queue.append(address+insn.size)
                if address>>8!=(address+insn.size)>>8:self.entries.add(address+insn.size)
    def register(self,insn,reg):
        name=insn.reg_name(reg)
        if name not in REGS:raise ValueError('register '+name)
        n,bits,shift=REGS[name]
        return n,bits,shift
    def address(self,i,o):
        m=o.mem
        if m.segment and i.reg_name(m.segment) not in ['ds','es','ss','cs','fs','gs']:raise ValueError('segmented memory')
        terms=[str(m.disp&0xffffffff)+'u']
        if m.base:
            n,b,s=self.register(i,m.base);terms.append(f'r[{n}]' if b==32 else f'((r[{n}]>>{s})&{(1<<b)-1}u)')
        if m.index:
            n,b,s=self.register(i,m.index);terms.append(f'r[{n}]*{m.scale}u' if b==32 else f'((r[{n}]>>{s})&{(1<<b)-1}u)*{m.scale}u')
        expression='('+'+'.join(terms)+')'
        return f'({expression}&65535u)' if i.addr_size==2 else expression
    def read(self,i,o):
        if o.type==X86_OP_IMM:return str(o.imm&0xffffffff)+'u'
        if o.type==X86_OP_REG:
            n,b,s=self.register(i,o.reg)
            return f'r[{n}]' if b==32 else f'((r[{n}]>>{s})&{(1<<b)-1}u)'
        if o.type==X86_OP_MEM:
            if o.size not in [1,2,4]:raise ValueError('memory operand size')
            return f'rd({self.address(i,o)},{o.size})'
        raise ValueError('operand')
    def write(self,i,o,value):
        if o.type==X86_OP_REG:
            n,b,s=self.register(i,o.reg)
            if b==32:return f'r[{n}]={value};'
            mask=((1<<b)-1)<<s
            return f'r[{n}]=(r[{n}]&{(~mask)&0xffffffff}u)|((({value})&{(1<<b)-1}u)<<{s});'
        if o.type==X86_OP_MEM:
            return f'wr({self.address(i,o)},{value},{o.size});'
        raise ValueError('write operand')
    def jump(self,target,page):
        if target in self.insns and target>>8==page:return f'goto L{target:x};'
        return f'pc={target}u;return;'
    def outline(self,code):


        if not code or 'return' in code:return code
        parameters={};arguments=[]
        def parameter(match):
            token=match[0]
            if token not in parameters:
                parameters[token]='p'+str(len(arguments));arguments.append(token[2:-1] if token.startswith('r[') else token)
            value=parameters[token]
            return 'r['+value+']' if token.startswith('r[') else value
        body=re.sub(r'r\[\d+\]|\b\d+u\b',parameter,code)
        if len(arguments)>6 or not arguments:return code
        if body not in self.outlines:self.outlines[body]=[len(self.outlines),len(arguments),0]
        record=self.outlines[body];record[2]+=1
        call='outlined_'+str(record[0])+'('+','.join(arguments)+');'
        self.outline_calls[call]=(body,code)
        return call
    def emit(self,i,page):
        m=i.mnemonic.split()[-1]; ops=i.operands; next_=i.address+i.size
        end=self.jump(next_,page)
        read=lambda k:self.read(i,ops[k])
        write=lambda k,v:self.write(i,ops[k],v)
        bits=lambda k:ops[k].size*8
        a=lambda k:self.address(i,ops[k])
        c=''
        if m in ['mov','movzx','movsx']:
            value=read(1)
            if m=='movsx':value=f'(uint32_t)signed_value({value},{bits(1)})'
            c=write(0,value)
        elif m=='lea':c=write(0,a(1))
        elif m in ['add','sub','adc','sbb','and','or','xor','cmp','test']:
            op=['add','sub','adc','sbb','and','or','xor'].index({'cmp':'sub','test':'and'}.get(m,m))
            c=f'a={read(0)};b={read(1)};v=alu({op},a,b,{bits(0)});'
            if m not in ['cmp','test']:c+=write(0,'v')
        elif m in ['inc','dec']:c=f'v=incdec({read(0)},{bits(0)},{int(m=="dec")});'+write(0,'v')
        elif m=='not':c=write(0,f'~({read(0)})')
        elif m=='neg':c=f'v=alu(1,0,{read(0)},{bits(0)});'+write(0,'v')
        elif m in ['shl','sal','shr','sar','rol','ror','rcl','rcr']:
            op=['shl','shr','sar','rol','ror','rcl','rcr'].index('shl' if m=='sal' else m)
            c=f'a={read(0)};b={read(1)};v=shift({op},a,b,{bits(0)});'+write(0,'v')
        elif m in ['mul','imul']:
            if len(ops)==1:c=f'multiply(r[0],{read(0)},{bits(0)},{int(m=="imul")},1);'
            else:
                x=read(0) if len(ops)==2 else read(1); y=read(1) if len(ops)==2 else read(2)
                c=f'a={x};b={y};saved=r[0];multiply(a,b,{bits(0)},1,0);v=r[0];r[0]=saved;'+write(0,'v')
        elif m in ['div','idiv']:c=f'divide({read(0)},{bits(0)},{int(m=="idiv")});'
        elif m=='xchg':
            c=f'a={read(0)};b={read(1)};'
            for k in range(2):
                if ops[k].type==X86_OP_MEM:c+=f'addr{k}={a(k)};'
            for k,value in [(0,'b'),(1,'a')]:
                c+=f'wr(addr{k},{value},{ops[k].size});' if ops[k].type==X86_OP_MEM else write(k,value)
        elif m=='xadd':
            c=f'a={read(0)};b={read(1)};v=alu(0,a,b,{bits(0)});'
            if ops[0].type==X86_OP_MEM:c+=f'addr0={a(0)};'
            c+=write(1,'a')
            c+=f'wr(addr0,v,{ops[0].size});' if ops[0].type==X86_OP_MEM else write(0,'v')
        elif m=='push':c=f'push({read(0)},{ops[0].size});'
        elif m=='pop':c=f'v=pop({ops[0].size});'+write(0,'v')
        elif m in ['pushfd','pushf']:c=f'push(flags,{4 if m=="pushfd" else 2});'
        elif m in ['popfd','popf']:c=f'flags=pop({4 if m=="popfd" else 2})|2;'
        elif m=='pushal':c='saved=r[4];push(r[0],4);push(r[1],4);push(r[2],4);push(r[3],4);push(saved,4);push(r[5],4);push(r[6],4);push(r[7],4);'
        elif m=='popal':c='r[7]=pop(4);r[6]=pop(4);r[5]=pop(4);pop(4);r[3]=pop(4);r[2]=pop(4);r[1]=pop(4);r[0]=pop(4);'
        elif m=='leave':c='r[4]=r[5];r[5]=pop(4);'
        elif m=='call':
            c=f'v={read(0)};push({next_}u,4);pc=v;return;';end=''
        elif m=='jmp':
            c=self.jump(ops[0].imm&0xffffffff,page) if ops[0].type==X86_OP_IMM else f'pc={read(0)};return;'
            end=''
        elif m=='ret':c='pc=pop(4);'+(f'r[4]+={ops[0].imm}u;' if ops else '')+'return;';end=''
        elif m.startswith('j') and ALIASES.get(m[1:],m[1:]) in CONDS:
            cc=CONDS[ALIASES.get(m[1:],m[1:])]
            c=f'if(cond({cc})){{{self.jump(ops[0].imm&0xffffffff,page)}}}'
        elif m.startswith('set') and ALIASES.get(m[3:],m[3:]) in CONDS:
            c=write(0,f'cond({CONDS[ALIASES.get(m[3:],m[3:])]})')
        elif m in ['loop','loope','loopne','jecxz','jcxz']:
            test='r[1]==0' if m=='jecxz' else '(r[1]&65535)==0' if m=='jcxz' else '--r[1]!=0'
            if m=='loope':test+='&&(flags&64)'
            if m=='loopne':test+='&&!(flags&64)'
            c=f'if({test}){{{self.jump(ops[0].imm&0xffffffff,page)}}}'
        elif m in ['cdq','cwde','cbw']:
            c={'cdq':'r[2]=(uint32_t)((int32_t)r[0]>>31);','cwde':'r[0]=(uint32_t)signed_value(r[0],16);',
               'cbw':'r[0]=(r[0]&0xffff0000u)|((uint32_t)signed_value(r[0],8)&65535);'}[m]
        elif m in ['clc','stc','cmc','cld','std','sahf','lahf']:
            c={'clc':'flags&=~1u;','stc':'flags|=1;','cmc':'flags^=1;','cld':'flags&=~1024u;',
               'std':'flags|=1024;','sahf':'flags=(flags&~213u)|((r[0]>>8)&213u);',
               'lahf':'r[0]=(r[0]&0xffff00ffu)|((flags&213u|2u)<<8);'}[m]
        elif m in ['movsb','movsw','movsd','stosb','stosw','stosd','lodsb','lodsw','lodsd','scasb','scasw','scasd','cmpsb','cmpsw','cmpsd'] and not any(o.type==X86_OP_REG and i.reg_name(o.reg).startswith('xmm') for o in ops):
            op=['movs','stos','lods','scas','cmps'].index(m[:-1]);n={'b':1,'w':2,'d':4}[m[-1]]
            repeat=2 if i.mnemonic.startswith('repne') else 1 if i.mnemonic.startswith('rep') else 0
            c=f'strings({op},{n},{repeat});'
        elif m in ['movdqa','movdqu','movaps','movups','pxor']:
            def loc(o):
                if o.type==X86_OP_REG and i.reg_name(o.reg).startswith('xmm'):return f'xmm[{int(i.reg_name(o.reg)[3:])}]'
                if o.type==X86_OP_MEM:return f'guest+{self.address(i,o)}'
                raise ValueError('SIMD operand')
            if any(o.type==X86_OP_MEM for o in ops):
                for o in ops:
                    if o.type==X86_OP_MEM:c+=f'if({self.address(i,o)}>MEM_SIZE-16){{fail(1);return;}}'
            dst,src=loc(ops[0]),loc(ops[1]);symbol='^=' if m=='pxor' else '='
            c+=f'for(unsigned k=0;k<16;k++)({dst})[k]{symbol}({src})[k];'
        elif m in ['nop','wait']:pass
        else:raise ValueError(m)
        return self.outline(c)+end
    def generate(self,out):
        self.decode();out.mkdir(parents=True,exist_ok=True)
        pages=collections.defaultdict(list)
        for addr,i in sorted(self.insns.items()):pages[addr>>8].append(i)

        codes={}
        for page,insns in sorted(pages.items()):
            for i in insns:
                try:codes[i.address]=self.emit(i,page)
                except ValueError as error:
                    self.unsupported[i.address]=f'{i.mnemonic} {i.op_str}: {error}'
                    codes[i.address]='fail(5);return;'
        for address,code in codes.items():
            call=code.split(';',1)[0]+';'
            if call in self.outline_calls:
                body,original=self.outline_calls[call]
                if self.outlines[body][2]<self.outline_min_uses:codes[address]=original+code[len(call):]


        for address,code in codes.items():
            if code.startswith('outlined_'):
                call,end=code.split(';',1)
                call=call.replace('(',f'({address}u,',1)
                codes[address]=f'if(!{call})return;'+end
        with (out/'lifted.c').open('w') as f:
            f.write('#include "'+str(HERE/'machine.h')+'"\n')
            for base,image in self.images.items():
                f.write(f'static const uint8_t image_{base:x}[]={{\n')
                for offset in range(0,len(image),256):f.write(','.join(map(str,image[offset:offset+256]))+',\n')
                f.write('};\n')
            for body,(number,arity,count) in self.outlines.items():
                if count>=self.outline_min_uses:
                    args='uint32_t entry,'+','.join('uint32_t p'+str(n) for n in range(arity))
                    f.write(f'static __attribute__((noinline)) unsigned outlined_{number}({args}){{if(!step(entry))return 0;uint32_t a,b,v,saved,addr0,addr1;{body}return 1;}}\n')
            for page,insns in sorted(pages.items()):
                f.write(f'static void page_{page:x}(void){{uint32_t a,b,v,saved,addr0,addr1;switch(pc){{\n')
                for i in insns:f.write(f'case {i.address}u:goto L{i.address:x};\n')
                f.write('default:fail(4);return;}\n')
                for i in insns:
                    code=codes[i.address]
                    guard='' if code.startswith('if(!outlined_') else f'if(!step({i.address}u))return;'
                    f.write(f'L{i.address:x}:{guard}{code}\n')
                f.write('}\n')
            f.write('__attribute__((export_name("initialize"))) void initialize(void){\n')
            f.write('for(unsigned i=0;i<MEM_SIZE;i++)guest[i]=0;for(unsigned i=0;i<8;i++)r[i]=0;flags=2;fault=0;pc=0;trace_return=0;\n')
            for base,image in self.images.items():f.write(f'for(unsigned i=0;i<{len(image)}u;i++)guest[{base}u+i]=image_{base:x}[i];\n')
            f.write('}\n')
            f.write('__attribute__((export_name("execute"))) uint32_t execute(uint32_t address,uint32_t budget){pc=address;fuel=budget;fault=0;while(pc!=0x700000u&&!fault){if(pc==2102000u){trace_return=rd(r[4],4);trace_board=rd(r[4]+4,4);trace(0,trace_board);}else if(trace_return&&pc==trace_return){trace_return=0;trace(1,trace_board);}switch(pc){\n')
            for addr in sorted(self.services):f.write(f'case {addr}u:service({addr}u);break;\n')
            f.write('default:switch(pc>>8){\n')
            for page in sorted(pages):f.write(f'case {page}u:page_{page:x}();break;\n')
            f.write('default:fail(4);break;}break;}}return fault;}\n')
        manifest={'format':1,'dll_sha256':PINS,'exports':self.exports,'services':self.services,
                  'instructions':len(self.insns),'entries':len(self.insns),'pages':len(pages),
                  'outlined_helpers':sum(count>=self.outline_min_uses for _,_,count in self.outlines.values()),
                  'outlined_instructions':sum(code.startswith('if(!outlined_') for code in codes.values()),
                  'unsupported':{hex(k):v for k,v in sorted(self.unsupported.items())}}
        (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
        print(f'{len(self.insns)} static instructions, {len(pages)} pages, {len(self.unsupported)} fail-closed instructions')


OPTIMIZER_FLAGS = ['--mvp-features', '--enable-mutable-globals', '--enable-sign-ext',
                   '--enable-bulk-memory-opt', '--one-caller-inline-max-function-size=0',
                   '--inline-max-combined-binary-size=65536', '-Oz', '--converge',
                   '--emit-target-features']


def optimize(wasm_opt, source, destination):
    version=subprocess.check_output([str(wasm_opt),'--version'],text=True).strip()
    if version!='wasm-opt version 133 (version_133)':
        raise ValueError(f'Unverified optimizer version: {version}; expected Binaryen 133')
    subprocess.run([str(wasm_opt),str(source),*OPTIMIZER_FLAGS,'-o',str(destination)],check=True)
    return version


def wasm_metrics(data):
    if data[:8]!=b'\0asm\x01\0\0\0':raise ValueError('Expected WebAssembly v1')
    def leb(offset):
        value=shift=0
        while True:
            byte=data[offset];offset+=1;value|=(byte&127)<<shift
            if not byte&128:return value,offset
            shift+=7
            if shift>=35:raise ValueError('Invalid WASM length')
    names={0:'custom',1:'types',2:'imports',3:'functions',4:'table',5:'memory',
           6:'globals',7:'exports',8:'start',9:'elements',10:'code',11:'data',12:'data-count'}
    sections={};position=8;maximum=count=0
    while position<len(data):
        identifier=data[position];length,start=leb(position+1);end=start+length
        if end>len(data):raise ValueError('Truncated WASM section')
        name=names.get(identifier,str(identifier));sections[name]=sections.get(name,0)+length
        if identifier==10:
            count,cursor=leb(start)
            for _ in range(count):
                size,cursor=leb(cursor);maximum=max(maximum,size);cursor+=size
            if cursor!=end:raise ValueError('Invalid WASM code section')
        position=end
    return {'wasm_sections':sections,'max_function_bytes':maximum,'function_count':count,
            'wasm_gzip_bytes':len(gzip.compress(data,compresslevel=6,mtime=0))}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=pathlib.Path,required=True)
    parser.add_argument('--clang',type=pathlib.Path,required=True)
    parser.add_argument('--wasm-opt',type=pathlib.Path,required=True,help='Binaryen 133 wasm-opt executable')
    parser.add_argument('--install',action='store_true',help='Install the built WASM, bindings and audit report into score-estimator/artifacts')
    args=parser.parse_args()
    t=Translation()
    for name in PINS:t.load(name)
    t.generate(args.out)
    command=[str(args.clang),'--target=wasm32-unknown-unknown','-Os','-fno-strict-aliasing','-fwrapv',
             '-nostdlib','-Wl,--no-entry','-Wl,--strip-all','-Wl,--export-memory','-Wl,-z,stack-size=1048576',
             '-Wl,--initial-memory=73400320','-Wl,--max-memory=73400320',
             str(args.out/'lifted.c'),'-o',str(args.out/'fox-score-unoptimized.wasm')]
    subprocess.run(command,check=True)
    wasm=args.out/'fox-score.wasm'
    optimizer=optimize(args.wasm_opt,args.out/'fox-score-unoptimized.wasm',wasm)
    metrics=wasm_metrics(wasm.read_bytes())
    if wasm.stat().st_size>10_000_000 or metrics['max_function_bytes']>1024*1024:
        raise ValueError('Scoring WASM exceeds the 10 MB module / 1 MiB function size budget')
    digest=hashlib.sha256(wasm.read_bytes()).hexdigest()
    report=json.loads((args.out/'manifest.json').read_text())
    report['wasm_sha256']=digest
    report['wasm_bytes']=wasm.stat().st_size
    report.update(metrics)
    report['unoptimized_wasm_bytes']=(args.out/'fox-score-unoptimized.wasm').stat().st_size
    report['optimizer']=optimizer
    report['optimizer_flags']=OPTIMIZER_FLAGS
    report['compiler_optimization']='-Os'
    report['sources_sha256']={name:hashlib.sha256((HERE/name).read_bytes()).hexdigest()
                              for name in ['lift.py','machine.h','requirements.txt']}
    report['compiler']=subprocess.check_output([str(args.clang),'--version'],text=True).splitlines()[0]
    (args.out/'manifest.json').write_text(json.dumps(report,indent=2)+'\n')
    if args.install:
        (ESTIMATOR/'artifacts/fox-score.wasm').write_bytes(wasm.read_bytes())
        bindings={k:report[k] for k in ['format','dll_sha256','exports','services','wasm_sha256']}
        (ESTIMATOR/'artifacts/fox-score-bindings.json').write_text(json.dumps(bindings,indent=2)+'\n')
        (HERE/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(f'{wasm}: {wasm.stat().st_size} bytes, SHA-256 {digest}')
if __name__=='__main__':main()
