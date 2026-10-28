using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Platynite {
    // Public Xbox availability metadata only. Account sign-in stays in the PC browser.
    public sealed class CloudCatalog : IDisposable {
        private readonly string cachePath;
        private readonly string market, locale;
        private Dictionary<string, CloudRoute> names = new Dictionary<string, CloudRoute>();
        private Dictionary<string, CloudRoute> ids = new Dictionary<string, CloudRoute>();
        private Timer timer; private int refreshing;
        public CloudCatalog(string directory, string market, string locale) {
            cachePath = Path.Combine(directory, "xbox-cloud-catalog.json"); this.market = market; this.locale = locale;
            try { Load(JsonConvert.DeserializeObject<List<CloudRoute>>(File.ReadAllText(cachePath))); } catch { }
            timer = new Timer(_ => Task.Run((Action)Refresh), null, 0, 3600000);
        }
        public static string Normalize(string name) { return new string((name ?? "").ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray()); }
        private void Load(List<CloudRoute> routes) {
            var newNames = new Dictionary<string, CloudRoute>(); var newIds = new Dictionary<string, CloudRoute>();
            foreach (var route in routes.OrderBy(r => r.ProductId)) {
                newIds[route.ProductId] = route;
                if (!newNames.ContainsKey(Normalize(route.Name))) newNames[Normalize(route.Name)] = route;
            }
            names = newNames; ids = newIds;
        }
        public CloudRoute Find(string name, string gameId) {
            CloudRoute route;
            if (!string.IsNullOrEmpty(gameId)) {
                foreach (Match match in Regex.Matches(gameId.ToUpperInvariant(), "[A-Z0-9]{12}")) if (ids.TryGetValue(match.Value, out route)) return route;
            }
            return names.TryGetValue(Normalize(name), out route) ? route : null;
        }
        private void Refresh() {
            if (Interlocked.Exchange(ref refreshing, 1) != 0) return;
            try {
                using (var client = new TimedWebClient()) {
                    var list = JArray.Parse(client.DownloadString("https://catalog.gamepass.com/sigls/v2?id=29a81209-df6f-41fd-a528-2ae6b91f719c&market=" + Uri.EscapeDataString(market) + "&language=" + Uri.EscapeDataString(locale)));
                    var productIds = list.Select(item => (string)item["id"]).Where(id => !string.IsNullOrEmpty(id)).ToArray();
                    var result = new List<CloudRoute>();
                    for (int offset = 0; offset < productIds.Length; offset += 80) {
                        var url = "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=" + string.Join(",",productIds.Skip(offset).Take(80)) + "&market=" + Uri.EscapeDataString(market) + "&languages=" + Uri.EscapeDataString(locale) + "&MS-CV=F.1";
                        var response = JObject.Parse(client.DownloadString(url));
                        foreach (var product in response["Products"] ?? new JArray()) {
                            var localized=product["LocalizedProperties"] as JArray;
                            if(localized==null || localized.Count==0)continue;
                            var name = (string)localized[0]["ProductTitle"];
                            var id = (string)product["ProductId"];
                            if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(id)) continue;
                            result.Add(new CloudRoute { ProductId=id, Name=name, Provider="Xbox Cloud", Url="https://www.xbox.com/"+locale+"/play/launch/"+Uri.EscapeDataString(name)+"/"+id });
                        }
                    }
                    if (result.Count > 0) {
                        Load(result); File.WriteAllText(cachePath, JsonConvert.SerializeObject(result));
                        try { Playnite.SDK.LogManager.GetLogger().Info("Platynite loaded " + result.Count + " Xbox cloud catalog titles"); } catch { }
                    }
                }
            } catch (Exception e) { try { Playnite.SDK.LogManager.GetLogger().Warn("Platynite cloud catalog refresh unavailable: " + e.GetType().Name); } catch { } }
            finally { Interlocked.Exchange(ref refreshing, 0); }
        }
        public void Dispose() { if (timer != null) timer.Dispose(); }
        private sealed class TimedWebClient : WebClient {
            protected override WebRequest GetWebRequest(Uri address) { var request=base.GetWebRequest(address); request.Timeout=20000; return request; }
        }
    }
    public sealed class CloudRoute { public string ProductId; public string Name; public string Provider; public string Url; }
}
