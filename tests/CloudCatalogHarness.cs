using System;using System.IO;using System.Threading;using System.Linq;using System.Collections.Generic;using Newtonsoft.Json;using Platynite;
class CloudCatalogHarness {
    static void Main(string[] args) {
        Directory.CreateDirectory(args[0]);
        using(var catalog=new CloudCatalog(args[0],"US","en-US")) {
            var file=Path.Combine(args[0],"xbox-cloud-catalog.json");
            for(int i=0;i<90&&!File.Exists(file);i++)Thread.Sleep(1000);
            if(!File.Exists(file))throw new Exception("Live cloud catalog did not load");
            var routes=JsonConvert.DeserializeObject<List<CloudRoute>>(File.ReadAllText(file));
            if(routes.Count<50)throw new Exception("Unexpectedly small cloud catalog");
            if(catalog.Find(routes[0].Name,null)==null)throw new Exception("Name lookup failed");
            if(catalog.Find("Not a real game",routes[0].ProductId)==null)throw new Exception("Product lookup failed");
            if(catalog.Find("Platynite nonexistent test game 0123456789",null)!=null)throw new Exception("Unknown game matched");
            if(args.Length>1){var names=JsonConvert.DeserializeObject<List<string>>(File.ReadAllText(args[1]));Console.WriteLine("Playnite titles currently matched to Xbox Cloud: "+names.Count(n=>catalog.Find(n,null)!=null));}
            Console.WriteLine("PASS: live Microsoft cloud catalog, exact normalized name/product lookup, unknown-title rejection; "+routes.Count+" titles");
        }
    }
}
