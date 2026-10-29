using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Windows;
using Newtonsoft.Json;
using Playnite.SDK;
using Playnite.SDK.Events;
using Playnite.SDK.Plugins;
using Playnite.SDK.Models;

namespace Platynite {
    public sealed class PlatyniteCompanion : GenericPlugin {
        public override Guid Id { get { return Guid.Parse("7a36cbe2-014b-467a-99d5-cef25c692a15"); } }
        private CompanionServer server;
        private string settingsPath;
        private Connection settings;
        private CloudCatalog cloud;
        private readonly Dictionary<Guid, CloudBackup> cloudBackups = new Dictionary<Guid, CloudBackup>();
        private readonly Dictionary<Guid, LaunchRecord> requests = new Dictionary<Guid, LaunchRecord>();
        private readonly Dictionary<Guid, DateTime> recentLaunches = new Dictionary<Guid, DateTime>();
        private readonly Dictionary<string, byte[]> artMemory = new Dictionary<string, byte[]>();
        private readonly object artLock = new object();
        private string artCacheDir;
        public PlatyniteCompanion(IPlayniteAPI api) : base(api) { Properties = new GenericPluginProperties { HasSettings = false }; }
        public override void OnApplicationStarted(OnApplicationStartedEventArgs args) {
            try {
                settingsPath = Path.Combine(GetPluginUserDataPath(), "connection.json");
                Directory.CreateDirectory(Path.GetDirectoryName(settingsPath));
                settings = File.Exists(settingsPath) ? JsonConvert.DeserializeObject<Connection>(File.ReadAllText(settingsPath)) : new Connection();
                if (string.IsNullOrWhiteSpace(settings.Token)) {
                    var bytes = new byte[32]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
                    settings.Token = Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
                }
                settings.Address = "http://" + GetLanAddress() + ":" + settings.Port;
                File.WriteAllText(settingsPath, JsonConvert.SerializeObject(settings, Formatting.Indented));
                cloud = new CloudCatalog(GetPluginUserDataPath(), settings.XboxMarket, settings.XboxLocale);
                artCacheDir = Path.Combine(GetPluginUserDataPath(), "artwork-cache");
                try { Directory.CreateDirectory(artCacheDir); PruneArtCache(); } catch { }
                try {
                    var backups = JsonConvert.DeserializeObject<Dictionary<Guid, CloudBackup>>(File.ReadAllText(Path.Combine(GetPluginUserDataPath(), "cloud-launch-backup.json")));
                    foreach (var entry in backups) cloudBackups[entry.Key] = entry.Value;
                } catch { }
                server = new CompanionServer(settings.Port, settings.Token, Catalog, Detail, Launch, Artwork, Status);
                server.Start();
                Playnite.SDK.LogManager.GetLogger().Info("Platynite Companion listening on port " + settings.Port);
            } catch (Exception e) { Playnite.SDK.LogManager.GetLogger().Error(e, "Platynite Companion could not start"); }
        }
        public override void OnApplicationStopped(OnApplicationStoppedEventArgs args) { if (server != null) server.Dispose(); if (cloud != null) cloud.Dispose(); }
        public override IEnumerable<MainMenuItem> GetMainMenuItems(GetMainMenuItemsArgs args) {
            yield return new MainMenuItem { MenuSection = "@Platynite", Description = "Show TV connection details", Action = a => {
                if (settings == null) { PlayniteApi.Dialogs.ShowMessage("Companion did not start. See playnite.log.", "Platynite"); return; }
                PlayniteApi.Dialogs.ShowMessage("Companion address: " + settings.Address + "\n\nAccess token:\n" + settings.Token +
                    "\n\nEnter these in Platynite > Connect Playnite. Keep Playnite running.\nConnection file: " + settingsPath, "Platynite Companion");
            }};
            yield return new MainMenuItem { MenuSection="@Platynite", Description="Restore original cloud launch setup", Action=a=>{
                foreach(var entry in cloudBackups) {
                    var game=PlayniteApi.Database.Games.Get(entry.Key);if(game==null)continue;
                    if(game.GameActions!=null)foreach(var action in game.GameActions.Where(x=>x.Name=="Platynite · Xbox Cloud").ToList())game.GameActions.Remove(action);
                    game.IncludeLibraryPluginAction=entry.Value.IncludeLibrary;
                    if(string.IsNullOrEmpty(game.InstallDirectory) || !Directory.Exists(game.InstallDirectory))game.IsInstalled=entry.Value.Installed;
                    PlayniteApi.Database.Games.Update(game);
                }
                cloudBackups.Clear();File.WriteAllText(Path.Combine(GetPluginUserDataPath(),"cloud-launch-backup.json"),"{}");
                PlayniteApi.Dialogs.ShowMessage("Platynite's generated cloud launch actions were removed and the original library launch settings restored.","Platynite");
            }};
        }
        private T UI<T>(Func<T> work) {
            if (Application.Current.Dispatcher.CheckAccess()) return work();
            return Application.Current.Dispatcher.Invoke(work);
        }
        private object Status() {
            return UI<object>(() => {
                var running = PlayniteApi.Database.Games.FirstOrDefault(g => g.IsRunning || g.IsLaunching);
                return new {
                    host = Environment.MachineName,
                    online = true,
                    gameCount = PlayniteApi.Database.Games.Count,
                    runningGame = running == null ? null : new { id = running.Id.ToString(), name = running.Name,
                        installed = running.IsInstalled, hidden = running.Hidden, cloudProvider = (CloudRouteFor(running) == null ? null : CloudRouteFor(running).Provider) }
                };
            });
        }
        private object Catalog() {
            return UI<object>(() => {
                var games = PlayniteApi.Database.Games.Select(g => {
                    var route = CloudRouteFor(g);
                    return new {
                        id = g.Id.ToString(), name = g.Name ?? "Untitled", installed = g.IsInstalled && !cloudBackups.ContainsKey(g.Id),
                        canPlay = g.IsInstalled || route != null, cloudProvider = route == null ? null : route.Provider,
                        cloudUrl = route == null ? null : route.Url,
                        hidden = g.Hidden, favorite = g.Favorite, running = g.IsRunning, launching = g.IsLaunching,
                        playtime = g.Playtime, lastActivity = g.LastActivity,
                        platforms = g.PlatformIds == null ? new string[0] : g.PlatformIds.Select(p => PlayniteApi.Database.Platforms.Get(p)).Where(p => p != null).Select(p => p.Name).ToArray(),
                        source = PlayniteApi.Database.Sources.Get(g.SourceId) == null ? "" : PlayniteApi.Database.Sources.Get(g.SourceId).Name,
                        cover = string.IsNullOrEmpty(g.CoverImage) ? null : "/api/artwork/" + g.Id + "/cover",
                        background = string.IsNullOrEmpty(g.BackgroundImage) ? null : "/api/artwork/" + g.Id + "/background",
                        artworkVersion = g.Modified.HasValue ? g.Modified.Value.ToUniversalTime().Ticks.ToString() : "0"
                    };
                }).OrderBy(g => g.name).ToArray();
                var addons = new List<object>();
                if (PlayniteApi.Addons.Plugins.Any(p => p.GetType().Name.IndexOf("StartPage", StringComparison.OrdinalIgnoreCase) >= 0)) addons.Add(new { id="startpage", name="StartPage", view="home" });
                if (PlayniteApi.Addons.Plugins.Any(p => p.GetType().Name.IndexOf("GameActivity", StringComparison.OrdinalIgnoreCase) >= 0)) addons.Add(new { id="gameactivity", name="GameActivity", view="activity" });
                string revision;
                using (var sha=SHA256.Create()) revision=Convert.ToBase64String(sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(new { games, addons }))));
                return new {
                version = 1, updatedAt = DateTime.UtcNow.ToString("o"), host = Environment.MachineName,
                revision = revision, games = games, addons = addons
                };
            });
        }
        private object Detail(Guid id) {
            return UI<object>(() => {
                var game = PlayniteApi.Database.Games.Get(id);
                if (game == null) throw new ApiException(404, "Game no longer exists in Playnite");
                var route = CloudRouteFor(game);
                return new {
                    id = game.Id.ToString(), name = game.Name ?? "Untitled",
                    description = Plain(game.Description),
                    installed = game.IsInstalled && !cloudBackups.ContainsKey(game.Id),
                    canPlay = game.IsInstalled || route != null,
                    cloudProvider = route == null ? null : route.Provider,
                    cloudUrl = route == null ? null : route.Url
                };
            });
        }
        private CloudRoute CloudRouteFor(Game game) {
            if (game.GameActions != null) foreach (var action in game.GameActions.Where(a => a.IsPlayAction)) {
                if(action.Type==GameActionType.File && !File.Exists(Environment.ExpandEnvironmentVariables(PlayniteApi.ExpandGameVariables(game,action).Path)))continue;
                string text = (action.Name+" "+action.Path+" "+action.Arguments).ToLowerInvariant();
                if (text.Contains("xbox.com/") && text.Contains("/play/")) return new CloudRoute { Provider="Xbox Cloud" };
                if (text.Contains("psplus") || text.Contains("psnow") || text.Contains("playstationplus") || text.Contains("playstation plus")) return new CloudRoute { Provider="PlayStation Plus" };
            }
            return cloud == null ? null : cloud.Find(game.Name, game.GameId);
        }
        private void PrepareCloudLaunch(Game game, CloudRoute route) {
            // Cloud launchers are virtual installed Playnite actions, not game downloads.
            // Back up the original launch configuration before modifying it through the SDK.
            if (!cloudBackups.ContainsKey(game.Id)) {
                cloudBackups[game.Id] = new CloudBackup { Installed=game.IsInstalled, IncludeLibrary=game.IncludeLibraryPluginAction,
                    Actions=game.GameActions == null ? new List<GameAction>() : game.GameActions.Select(a => a.GetCopy()).ToList() };
                File.WriteAllText(Path.Combine(GetPluginUserDataPath(), "cloud-launch-backup.json"), JsonConvert.SerializeObject(cloudBackups, Formatting.Indented));
            }
            if (route.Url != null) {
                if (game.GameActions == null) game.GameActions = new ObservableCollection<GameAction>();
                var edge = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe");
                if (!File.Exists(edge)) edge = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe");
                var action = new GameAction { Name="Platynite · Xbox Cloud", IsPlayAction=true, Type=File.Exists(edge)?GameActionType.File:GameActionType.URL,
                    Path=File.Exists(edge)?edge:route.Url, Arguments=File.Exists(edge)?"--start-fullscreen --app=\""+route.Url+"\"":"", TrackingMode=TrackingMode.Process };
                game.GameActions.Add(action);
            }
            if(route.Provider=="Xbox Cloud")game.IncludeLibraryPluginAction=false;
            game.IsInstalled = true;
            PlayniteApi.Database.Games.Update(game);
        }
        private object Launch(Guid id, Guid requestId) {
            return UI<object>(() => {
                LaunchRecord prior;
                if (requests.TryGetValue(requestId, out prior)) {
                    if (prior.Id != id) throw new ApiException(409, "Request id belongs to another game");
                    return new { status = "already-requested", id = id.ToString() };
                }
                var game = PlayniteApi.Database.Games.Get(id);
                if (game == null) throw new ApiException(404, "Game no longer exists in Playnite");
                var route = CloudRouteFor(game);
                if (!game.IsInstalled && route == null) throw new ApiException(409, "No local installation or supported cloud launch is configured");
                var busy = PlayniteApi.Database.Games.FirstOrDefault(g => g.Id != id && (g.IsRunning || g.IsLaunching));
                if (busy != null) throw new ApiException(409, "Another game is running: " + busy.Name + ". Resume the desktop or close it first.");
                DateTime last;
                bool already = game.IsRunning || game.IsLaunching || (recentLaunches.TryGetValue(id, out last) && (DateTime.UtcNow-last).TotalSeconds < 60);
                if (!already) {
                    if (!game.IsInstalled && route != null) PrepareCloudLaunch(game, route);
                    // Mark before dispatch so a repeated request cannot start the same game twice.
                    recentLaunches[id] = DateTime.UtcNow;
                    try { PlayniteApi.StartGame(id); } catch { recentLaunches.Remove(id); throw; }
                }
                if (requests.Count >= 1024) requests.Clear();
                requests[requestId] = new LaunchRecord { Id = id };
                return new { status = already ? "already-running" : "launch-requested", id = id.ToString() };
            });
        }
        private byte[] Artwork(Guid id, string kind) {
            if (kind != "cover" && kind != "background") return null;
            string memKey = id.ToString("N") + "/" + kind;
            lock (artLock) { byte[] hit; if (artMemory.TryGetValue(memKey, out hit)) return hit; }
            var info = UI(() => {
                var game = PlayniteApi.Database.Games.Get(id);
                if (game == null) return null;
                var relative = kind == "background" ? game.BackgroundImage : game.CoverImage;
                if (string.IsNullOrEmpty(relative)) return null;
                if (relative.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                    return new ArtInfo { Remote = relative, Version = game.Modified.HasValue ? game.Modified.Value.ToUniversalTime().Ticks.ToString() : "0" };
                var full = PlayniteApi.Database.GetFullFilePath(relative);
                return string.IsNullOrEmpty(full) ? null : new ArtInfo { Local = full,
                    Version = game.Modified.HasValue ? game.Modified.Value.ToUniversalTime().Ticks.ToString() : "0" };
            });
            if (info == null) return null;
            try {
                string disk = artCacheDir == null ? null : Path.Combine(artCacheDir, id.ToString("N") + "-" + kind + "-" + info.Version + ".jpg");
                byte[] bytes = (disk != null && File.Exists(disk)) ? File.ReadAllBytes(disk) : null;
                if (bytes == null) {
                    using (var image = info.Remote != null ? DownloadImage(info.Remote) : Image.FromFile(info.Local)) {
                        if (image == null) return null;
                        bytes = ResizeArt(image, kind);
                    }
                    if (disk != null) { try { File.WriteAllBytes(disk, bytes); } catch { } }
                }
                lock (artLock) { if (artMemory.Count >= 50) artMemory.Clear(); artMemory[memKey] = bytes; }
                return bytes;
            } catch { return null; }
        }
        private static byte[] ResizeArt(Image image, string kind) {
            int maxW = kind == "background" ? 1280 : 360, maxH = kind == "background" ? 720 : 540;
            double ratio = Math.Min(1.0, Math.Min((double)maxW/image.Width, (double)maxH/image.Height));
            using (var thumb = new Bitmap(Math.Max(1, (int)(image.Width*ratio)), Math.Max(1, (int)(image.Height*ratio))))
            using (var graphics = Graphics.FromImage(thumb))
            using (var output = new MemoryStream()) {
                graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                graphics.DrawImage(image, 0, 0, thumb.Width, thumb.Height);
                thumb.Save(output, ImageFormat.Jpeg); return output.ToArray();
            }
        }
        private static Image DownloadImage(string url) {
            try {
                using (var client = new CappedWebClient()) {
                    var data = client.DownloadData(url);
                    if (data == null || data.Length == 0 || data.Length > 12 * 1024 * 1024) return null;
                    return Image.FromStream(new MemoryStream(data));
                }
            } catch { return null; }
        }
        private void PruneArtCache() {
            try {
                var files = new DirectoryInfo(artCacheDir).GetFiles("*.jpg");
                long total = 0; var ordered = new List<FileInfo>(files);
                ordered.Sort((a, b) => a.LastWriteTimeUtc.CompareTo(b.LastWriteTimeUtc));
                foreach (var f in ordered) {
                    if ((DateTime.UtcNow - f.LastWriteTimeUtc).TotalDays > 30) { try { f.Delete(); } catch { } continue; }
                    total += f.Length;
                }
                foreach (var f in ordered) {
                    if (total <= 400L * 1024 * 1024 || !File.Exists(f.FullName)) continue;
                    total -= f.Length; try { f.Delete(); } catch { }
                }
            } catch { }
        }
        private sealed class ArtInfo { public string Local; public string Remote; public string Version; }
        private sealed class CappedWebClient : WebClient {
            protected override WebRequest GetWebRequest(Uri address) { var request = base.GetWebRequest(address); request.Timeout = 15000; return request; }
        }
        private static string Plain(string html) { return WebUtility.HtmlDecode(Regex.Replace(html ?? "", "<[^>]+>", " ")).Trim(); }
        private static string GetLanAddress() {
            try { using (var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp)) {
                socket.Connect("192.0.2.1", 1); return ((IPEndPoint)socket.LocalEndPoint).Address.ToString();
            }} catch { return "127.0.0.1"; }
        }
        public sealed class Connection { public string Address; public string Token; public int Port = 19822; public string XboxMarket="US"; public string XboxLocale="en-US"; }
        public sealed class CloudBackup { public bool Installed; public bool IncludeLibrary; public List<GameAction> Actions; }
        private sealed class LaunchRecord { public Guid Id; }
    }
}
