import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;
import java.io.*;
public class Instructions extends GhidraScript {
 public void run() throws Exception {
  String[] args=getScriptArgs(); File out=new File(args[0]);out.mkdirs();
  for(int i=1;i<args.length;i++) {
   Function f=getFunctionAt(toAddr(args[i]));if(f==null)continue;
   try(PrintWriter w=new PrintWriter(new File(out,f.getEntryPoint()+".asm"))) {
    for(Instruction ins:currentProgram.getListing().getInstructions(f.getBody(),true))w.println(ins.getAddress()+"  "+ins);
   }
  }
 }
}
