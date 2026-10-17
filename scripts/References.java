import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.io.*;
public class References extends GhidraScript {
 public void run() throws Exception {
  String[] args=getScriptArgs();
  try(PrintWriter w=new PrintWriter(args[0])) {
   for(int i=1;i<args.length;i++)for(Reference r:getReferencesTo(toAddr(args[i]))) {
    Function f=getFunctionContaining(r.getFromAddress());
    if(f!=null)w.println(f.getEntryPoint()+"\treference to global "+args[i]+" at "+r.getFromAddress());
   }
  }
 }
}
