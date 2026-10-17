// Ghidra headless post-analysis inventory.
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.io.*;

public class Inventory extends GhidraScript {
 public void run() throws Exception {
  File out = new File(getScriptArgs()[0]); out.mkdirs();
  try (PrintWriter w = new PrintWriter(new File(out, "functions.tsv"))) {
   for (Function f : currentProgram.getFunctionManager().getFunctions(true))
    w.println(f.getEntryPoint()+"\t"+f.getName(true)+"\t"+f.getBody().getNumAddresses());
  }
  try (PrintWriter w = new PrintWriter(new File(out, "strings-xrefs.tsv"))) {
   for (Data d : currentProgram.getListing().getDefinedData(true)) {
    if (!d.hasStringValue()) continue;
    String s = d.getValue().toString();
    if (!s.matches("(?is).*(proto\\.|login|match|setpiece|socket|send|recv|connect|\\.fox|weiqi|wq\\.|https?://).*")) continue;
    w.println("STRING\t"+d.getAddress()+"\t"+s.replace('\n',' '));
    for (Reference r : getReferencesTo(d.getAddress())) {
     Function f = getFunctionContaining(r.getFromAddress());
     w.println("REF\t"+r.getFromAddress()+"\t"+(f == null ? "data" : f.getEntryPoint()+" "+f.getName(true)));
    }
   }
  }
 }
}
