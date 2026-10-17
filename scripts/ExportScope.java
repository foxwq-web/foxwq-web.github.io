// Export message virtual methods, their constructors, and immediate constructor callers.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;

public class ExportScope extends GhidraScript {
 public void run() throws Exception {
  String[] args=getScriptArgs(); File out=new File(args[0]); out.mkdirs();
  Map<Function,Set<String>> selected=new LinkedHashMap<>();
  for(String line:Files.readAllLines(Paths.get(args[1]))) {
   String[] fields=line.split("\t");
   Function f=getFunctionContaining(toAddr(fields[0]));
   if(f==null) continue;
   selected.computeIfAbsent(f,k->new LinkedHashSet<>()).add(fields[1]);
   if(fields[1].endsWith("constructor")) {
    for(Reference r:getReferencesTo(f.getEntryPoint())) {
     Function caller=getFunctionContaining(r.getFromAddress());
     if(caller!=null) selected.computeIfAbsent(caller,k->new LinkedHashSet<>()).add("caller of "+fields[1]);
    }
   }
  }
  DecompInterface dec=new DecompInterface(); dec.openProgram(currentProgram);
  try(PrintWriter index=new PrintWriter(new File(out,"index.tsv"))) {
   for(Map.Entry<Function,Set<String>> item:selected.entrySet()) {
    monitor.checkCancelled(); Function f=item.getKey(); String labels=String.join("; ",item.getValue());
    index.println(f.getEntryPoint()+"\t"+f.getName(true)+"\t"+labels); index.flush();
    try(PrintWriter w=new PrintWriter(new File(out,f.getEntryPoint()+".c"))) {
     w.println("/* "+labels+"\n * "+f.getName(true)+" at "+f.getEntryPoint()+"\n * Callers:");
     for(Reference r:getReferencesTo(f.getEntryPoint())) {
      Function c=getFunctionContaining(r.getFromAddress());
      w.println(" * "+r.getFromAddress()+" "+(c==null?"data":c.getEntryPoint()+" "+c.getName(true)));
     }
     w.println(" * Callees:");
     for(Function c:f.getCalledFunctions(monitor)) w.println(" * "+c.getEntryPoint()+" "+c.getName(true));
     w.println(" */");
     DecompileResults result=dec.decompileFunction(f,60,monitor);
     w.println(result.decompileCompleted()?result.getDecompiledFunction().getC():"/* FAILED: "+result.getErrorMessage()+" */");
    }
   }
  } finally {dec.dispose();}
 }
}
