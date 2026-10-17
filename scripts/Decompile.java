// Export selected functions and their direct callers/callees from an analyzed project.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.io.*;
import java.util.*;

public class Decompile extends GhidraScript {
 public void run() throws Exception {
  String[] args = getScriptArgs();
  File out = new File(args[0]); out.mkdirs();
  Set<Function> selected = new LinkedHashSet<>();
  for (int i=1;i<args.length;i++) {
   Function f = getFunctionAt(toAddr(args[i]));
   if (f != null) selected.add(f);
  }
  DecompInterface dec = new DecompInterface(); dec.openProgram(currentProgram);
  try (PrintWriter index = new PrintWriter(new File(out,"index.tsv"))) {
   for (Function f : selected) {
    monitor.checkCancelled();
    String name=f.getEntryPoint().toString()+".c";
    index.println(f.getEntryPoint()+"\t"+f.getName(true)+"\t"+name);
    try (PrintWriter w = new PrintWriter(new File(out,name))) {
     w.println("/* "+f.getName(true)+" at "+f.getEntryPoint()+" */");
     w.println("/* Callers:");
     for (Reference r : getReferencesTo(f.getEntryPoint())) {
      Function caller=getFunctionContaining(r.getFromAddress());
      w.println(" * "+r.getFromAddress()+" "+(caller==null?"data":caller.getEntryPoint()+" "+caller.getName(true)));
     }
     w.println(" * Callees:");
     for(Function c:f.getCalledFunctions(monitor)) w.println(" * "+c.getEntryPoint()+" "+c.getName(true));
     w.println(" */");
     DecompileResults result=dec.decompileFunction(f,90,monitor);
     w.println(result.decompileCompleted()?result.getDecompiledFunction().getC():"/* FAILED: "+result.getErrorMessage()+" */");
    }
   }
  } finally { dec.dispose(); }
 }
}
