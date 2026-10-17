import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;
import ghidra.program.model.scalar.Scalar;
import java.io.*;
public class FindScalar extends GhidraScript {
 public void run() throws Exception {
  String[] a=getScriptArgs();long target=Long.decode(a[1]);
  try(PrintWriter w=new PrintWriter(a[0])) {
   InstructionIterator it=currentProgram.getListing().getInstructions(true);
   while(it.hasNext()) {Instruction i=it.next();boolean found=false;
    for(int n=0;n<i.getNumOperands();n++)for(Object o:i.getOpObjects(n))if(o instanceof Scalar && ((Scalar)o).getUnsignedValue()==target)found=true;
    if(found){Function f=getFunctionContaining(i.getAddress());w.println((f==null?"?":f.getEntryPoint())+"\t"+i.getAddress()+"\t"+i);}
   }
  }
 }
}
