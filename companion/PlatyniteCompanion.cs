using System;
using System.Collections.Generic;
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

namespace Platynite {
    public sealed class PlatyniteCompanion : GenericPlugin {
        public override Guid Id { get { return Guid.Parse("7a36cbe2-014b-467a-99d5-cef25c692a15"); } }
        private CompanionServer server;
        private string settingsPath;
        private Connection settings;
        private readonly Dictionary<Guid, LaunchRecord> requests = new Dictionary<Guid, LaunchRecord>();
        private readonly Dictionary<Guid, DateTime> recentLaunches = new Dictionary<Guid, DateTime>();
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
                server = new CompanionServer(settings.Port, settings.Token, Catalog, Launch, Artwork);
                server.Start();
                Playnite.SDK.LogManager.GetLogger().Info("Platynite Companion listening on port " + settings.Port);
            } catch (Exception e) { Playnite.SDK.LogManager.GetLogger().Error(e, "Platynite Companion could not start"); }
        }
        public override void OnApplicationStopped(OnApplicationStoppedEventArgs args) { if (server != null) server.Dispose(); }
        public override IEnumerable<MainMenuItem> GetMainMenuItems(GetMainMenuItemsArgs args) {
            yield return new MainMenuItem { MenuSection = "@Platynite", Description = "Show TV connection details", Action = a => {
                if (settings == null) { PlayniteApi.Dialogs.ShowMessage("Companion did not start. See playnite.log.", "Platynite"); return; }
                PlayniteApi.Dialogs.ShowMessage("Companion address: " + settings.Address + "\n\nAccess token:\n" + settings.Token +
                    "\n\nEnter these in Platynite > Connect Playnite. Keep Playnite running.\nConnection file: " + settingsPath, "Platynite Companion");
            }};
        }
        private T UI<T>(Func<T> work) {
            if (Application.Current.Dispatcher.CheckAccess()) return work();
            return Application.Current.Dispatcher.Invoke(work);
        }
        private object Catalog() {
            return UI<object>(() => new {
                version = 1, updatedAt = DateTime.UtcNow.ToString("o"), host = Environment.MachineName,
                games = PlayniteApi.Database.Games.Select(g => new {
                    id = g.Id.ToString(), name = g.Name ?? "Untitled", installed = g.IsInstalled,
                    hidden = g.Hidden, favorite = g.Favorite, running = g.IsRunning, launching = g.IsLaunching,
                    description = Plain(g.Description), playtime = g.Playtime, lastActivity = g.LastActivity,
                    platforms = g.PlatformIds == null ? new string[0] : g.PlatformIds.Select(p => PlayniteApi.Database.Platforms.Get(p)).Where(p => p != null).Select(p => p.Name).ToArray(),
                    source = PlayniteApi.Database.Sources.Get(g.SourceId) == null ? "" : PlayniteApi.Database.Sources.Get(g.SourceId).Name,
                    cover = string.IsNullOrEmpty(g.CoverImage) ? null : "/api/artwork/" + g.Id + "/cover",
                    background = string.IsNullOrEmpty(g.BackgroundImage) ? null : "/api/artwork/" + g.Id + "/background",
                    artworkVersion = g.Modified.HasValue ? g.Modified.Value.ToUniversalTime().Ticks.ToString() : "0"
                }).OrderBy(g => g.name).ToArray()
            });
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
                if (!game.IsInstalled) throw new ApiException(409, "Game is not installed");
                var busy = PlayniteApi.Database.Games.FirstOrDefault(g => g.Id != id && (g.IsRunning || g.IsLaunching));
                if (busy != null) throw new ApiException(409, "Another game is running: " + busy.Name + ". Resume the desktop or close it first.");
                DateTime last;
                bool already = game.IsRunning || game.IsLaunching || (recentLaunches.TryGetValue(id, out last) && (DateTime.UtcNow-last).TotalSeconds < 60);
                if (!already) {
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
            string path = UI(() => {
                var game = PlayniteApi.Database.Games.Get(id);
                if (game == null) return null;
                var relative = kind == "background" ? game.BackgroundImage : game.CoverImage;
                return string.IsNullOrEmpty(relative) || relative.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? null : PlayniteApi.Database.GetFullFilePath(relative);
            });
            if (path == null || !File.Exists(path)) return null;
            try {
                using (var image = Image.FromFile(path)) {
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
            } catch { return null; }
        }
        private static string Plain(string html) { return WebUtility.HtmlDecode(Regex.Replace(html ?? "", "<[^>]+>", " ")).Trim(); }
        private static string GetLanAddress() {
            try { using (var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp)) {
                socket.Connect("192.0.2.1", 1); return ((IPEndPoint)socket.LocalEndPoint).Address.ToString();
            }} catch { return "127.0.0.1"; }
        }
        public sealed class Connection { public string Address; public string Token; public int Port = 19822; }
        private sealed class LaunchRecord { public Guid Id; }
    }
}
