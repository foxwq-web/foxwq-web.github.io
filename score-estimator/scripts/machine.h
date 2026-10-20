
#include <stdint.h>
#include <stddef.h>
#define MEM_SIZE (64u * 1024u * 1024u)
static uint8_t guest[MEM_SIZE];
static uint32_t r[8], flags = 2, pc, fault, fuel;
static uint8_t xmm[8][16];
static uint32_t trace_return, trace_board;
__attribute__((import_module("env"), import_name("trace")))
extern void trace(uint32_t stage, uint32_t board);
__attribute__((import_module("env"), import_name("service")))
extern void service(uint32_t address);
static void fail(uint32_t code) { if (!fault) fault = code; }

static __attribute__((noinline)) unsigned step(uint32_t address) {
  pc=address;
  if(fault)return 0;
  if(!fuel){fail(3);return 0;}
  fuel--;return 1;
}
static uint32_t mask(unsigned bits) { return bits == 32 ? UINT32_MAX : (1u << bits) - 1; }
static int32_t signed_value(uint32_t value, unsigned bits) {
  return (int32_t)(value << (32 - bits)) >> (32 - bits);
}
static __attribute__((noinline)) uint32_t rd(uint32_t a, unsigned n) {
  if (a > MEM_SIZE - n) { fail(1); return 0; }
  uint32_t v = 0; for (unsigned i = 0; i < n; i++) v |= (uint32_t)guest[a+i] << (i*8);
  return v;
}
static __attribute__((noinline)) void wr(uint32_t a, uint32_t v, unsigned n) {
  if (a > MEM_SIZE - n) { fail(1); return; }
  for (unsigned i = 0; i < n; i++) guest[a+i] = v >> (i*8);
}
static __attribute__((noinline)) void push(uint32_t v, unsigned n) { r[4] -= n; wr(r[4], v, n); }
static __attribute__((noinline)) uint32_t pop(unsigned n) { uint32_t v=rd(r[4],n); r[4]+=n; return v; }
static void szp(uint32_t v, unsigned bits) {
  v &= mask(bits);
  unsigned parity = (__builtin_parity(v & 255) == 0);
  flags = (flags & ~(4u|64u|128u)) | parity*4u | (v==0)*64u | ((v>>(bits-1))&1)*128u;
}

static __attribute__((noinline)) uint32_t alu(unsigned op, uint32_t a, uint32_t b, unsigned bits) {
  uint32_t m=mask(bits), sign=1u<<(bits-1), carry=flags&1;
  a&=m; b&=m; uint32_t v; unsigned cf=0, of=0;
  if (op<4) {
    uint32_t c=(op>=2)?carry:0;
    if (op==0 || op==2) {
      uint64_t w=(uint64_t)a+b+c; v=w&m; cf=(w>>bits)&1;
      of=((~(a^b)&(a^v)&sign)!=0);
    } else {
      uint64_t w=(uint64_t)b+c; v=(a-w)&m; cf=(uint64_t)a<w;
      of=(((a^b)&(a^v)&sign)!=0);
    }
    flags=(flags & ~(1u|16u|2048u)) | cf | ((a^b^v)&16u) | of*2048u;
  } else {
    v=(op==4?a&b:op==5?a|b:a^b)&m; flags &= ~(1u|2048u);
  }
  szp(v,bits); return v;
}
static __attribute__((noinline)) uint32_t incdec(uint32_t a, unsigned bits, unsigned dec) {
  unsigned cf=flags&1; uint32_t v=alu(dec?1:0,a,1,bits); flags=(flags&~1u)|cf; return v;
}
static __attribute__((noinline)) uint32_t shift(unsigned op,uint32_t a,uint32_t count,unsigned bits) {
  a &= mask(bits); count &= 31; if (!count) return a;
  unsigned cf=flags&1, oldsign=a>>(bits-1), n=count;

  if(op==3 || op==4) n%=bits;
  if(op>=5 && bits<32) n%=(bits+1);
  if (!n) { if(op==3||op==4)flags=(flags&~1u)|(op==3?(a&1):(a>>(bits-1))); return a; }
  for(unsigned i=0;i<n;i++) {
    unsigned next;
    if(op==0 || op==3 || op==5) {
      next=a>>(bits-1); a=((a<<1)|(op==3?next:op==5?cf:0))&mask(bits);
    } else {
      next=a&1; a=(a>>1)|((op==2?(a>>(bits-1)):op==4?next:op==6?cf:0)<<(bits-1));
    }
    cf=next;
  }
  flags=(flags&~1u)|cf;
  if(count==1) {
    unsigned of=op==0||op==3||op==5?((a>>(bits-1))^cf):
      op==1?oldsign:op==2?0:((a>>(bits-1))^(a>>(bits-2)))&1;
    flags=(flags&~2048u)|of*2048u;
  }
  if(op<3)szp(a,bits); return a;
}
static __attribute__((noinline)) unsigned cond(unsigned c) {
  unsigned cf=flags&1,z=(flags>>6)&1,s=(flags>>7)&1,o=(flags>>11)&1,p=(flags>>2)&1;
  switch(c) {
    case 0:return o;case 1:return !o;case 2:return cf;case 3:return !cf;
    case 4:return z;case 5:return !z;case 6:return cf||z;case 7:return !cf&&!z;
    case 8:return s;case 9:return !s;case 10:return p;case 11:return !p;
    case 12:return s!=o;case 13:return s==o;case 14:return z||s!=o;case 15:return !z&&s==o;
  } return 0;
}
static __attribute__((noinline)) void multiply(uint32_t a,uint32_t b,unsigned bits,unsigned is_signed,unsigned implicit) {
  uint64_t w=is_signed?(uint64_t)((int64_t)signed_value(a,bits)*signed_value(b,bits)):
    (uint64_t)(a&mask(bits))*(b&mask(bits));
  uint32_t low=w&mask(bits), high=(w>>bits)&mask(bits);
  unsigned overflow=is_signed? (int64_t)w!=(int64_t)signed_value(low,bits):high!=0;
  flags=(flags&~(1u|2048u))|overflow*(1u|2048u);
  if(implicit) {
    if(bits==8) r[0]=(r[0]&0xffff0000u)|(w&65535);
    else {r[0]=(r[0]&~mask(bits))|low;r[2]=(r[2]&~mask(bits))|high;}
  } else r[0]=low;
}
static __attribute__((noinline)) void divide(uint32_t b,unsigned bits,unsigned is_signed) {
  b&=mask(bits); if(!b){fail(2);return;}
  uint64_t dividend=bits==8?r[0]&65535:((uint64_t)(r[2]&mask(bits))<<bits)|(r[0]&mask(bits));
  uint32_t q,rem;
  if(is_signed) {
    int64_t a=bits==32?(int64_t)dividend:(int64_t)(int32_t)((uint32_t)dividend<<(32-bits*2))>>(32-bits*2);
    int64_t d=signed_value(b,bits);
    if(a==INT64_MIN&&d==-1){fail(2);return;}
    int64_t v=a/d, t=a%d;
    if(v<-(1ll<<(bits-1))||v>((1ll<<(bits-1))-1)){fail(2);return;}
    q=v&mask(bits);rem=t&mask(bits);
  }else{
    uint64_t v=dividend/b; if(v>mask(bits)){fail(2);return;}
    q=v;rem=dividend%b;
  }
  if(bits==8)r[0]=(r[0]&0xffff0000u)|q|(rem<<8);
  else {r[0]=(r[0]&~mask(bits))|q;r[2]=(r[2]&~mask(bits))|rem;}
}
static __attribute__((noinline)) void strings(unsigned op,unsigned n,unsigned repeat) {

  uint32_t count=repeat?r[1]:1;
  while(count--) {
    if(!fuel){fail(3);return;} fuel--;
    uint32_t a,b;
    if(op==0){a=rd(r[6],n);wr(r[7],a,n);}
    if(op==1)wr(r[7],r[0],n);
    if(op==2)r[0]=(r[0]&~mask(n*8))|rd(r[6],n);
    if(op==3)alu(1,r[0],rd(r[7],n),n*8);
    if(op==4){a=rd(r[6],n);b=rd(r[7],n);alu(1,a,b,n*8);}
    int32_t step=(flags&1024)?-(int32_t)n:(int32_t)n;
    if(op==0||op==2||op==4)r[6]+=step;
    if(op==0||op==1||op==3||op==4)r[7]+=step;
    if(repeat){r[1]--;if(op>=3&&((flags&64)!=0)!=(repeat==1))break;}
    if(fault)break;
  }
}
__attribute__((export_name("guest_base"))) uint32_t guest_base(void){return (uint32_t)(uintptr_t)guest;}
__attribute__((export_name("register_base"))) uint32_t register_base(void){return (uint32_t)(uintptr_t)r;}
__attribute__((export_name("get_pc"))) uint32_t get_pc(void){return pc;}
__attribute__((export_name("set_pc"))) void set_pc(uint32_t v){pc=v;}
__attribute__((export_name("get_flags"))) uint32_t get_flags(void){return flags;}
__attribute__((export_name("set_flags"))) void set_flags(uint32_t v){flags=v;}
__attribute__((export_name("get_fault"))) uint32_t get_fault(void){return fault;}
