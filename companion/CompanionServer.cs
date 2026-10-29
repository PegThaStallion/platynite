using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Platynite {
    // Persistent HTTP/1.1 connections: one TCP handshake serves many requests.
    public sealed class CompanionServer : IDisposable {
        private readonly TcpListener listener;
        private readonly string token;
        private readonly Func<object> catalog;
        private readonly Func<Guid, Guid, object> launch;
        private readonly Func<Guid, string, byte[]> artwork;
        private readonly Func<object> status;
        private readonly SemaphoreSlim slots = new SemaphoreSlim(12);
        private volatile bool stopping;

        public CompanionServer(int port, string token, Func<object> catalog,
            Func<Guid, Guid, object> launch, Func<Guid, string, byte[]> artwork, Func<object> status) {
            this.token = token; this.catalog = catalog; this.launch = launch; this.artwork = artwork; this.status = status;
            listener = new TcpListener(IPAddress.Any, port);
        }

        public void Start() { listener.Start(16); Task.Run((Action)Accept); }
        private void Accept() {
            while (!stopping) {
                try {
                    var client = listener.AcceptTcpClient();
                    if (!slots.Wait(0)) { client.Close(); continue; }
                    Task.Run(() => { try { Handle(client); } finally { client.Close(); slots.Release(); } });
                } catch (SocketException) { if (!stopping) Thread.Sleep(100); }
                catch (ObjectDisposedException) { return; }
            }
        }

        private void Handle(TcpClient client) {
            client.ReceiveTimeout = 10000; client.SendTimeout = 10000;
            try {
                var stream = client.GetStream();
                while (true) {
                    var header = new List<byte>(); int b;
                    while (header.Count < 16384 && (b = stream.ReadByte()) >= 0) {
                        header.Add((byte)b); int n = header.Count;
                        if (n >= 4 && header[n-4] == 13 && header[n-3] == 10 && header[n-2] == 13 && header[n-1] == 10) break;
                    }
                    if (header.Count >= 16384) { Reply(stream, 400, new { error = "Unsupported request" }, true); break; }
                    var lines = Encoding.ASCII.GetString(header.ToArray()).Split(new[] { "\r\n" }, StringSplitOptions.None);
                    var first = lines[0].Split(' ');
                    if (first.Length != 3 || !first[1].StartsWith("/")) { Reply(stream, 400, new { error = "Invalid request" }, true); break; }
                    if (first[0] == "OPTIONS") { Reply(stream, 204, null, true); continue; }
                    var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    for (int i = 1; i < lines.Length; i++) {
                        int colon = lines[i].IndexOf(':');
                        if (colon > 0) {
                            var key = lines[i].Substring(0, colon).Trim();
                            if (headers.ContainsKey(key)) { Reply(stream, 400, new { error = "Duplicate header" }, true); break; }
                            headers[key] = lines[i].Substring(colon + 1).Trim();
                        }
                    }
                    if (header.Count >= 16384 || headers.ContainsKey("Transfer-Encoding")) { Reply(stream, 400, new { error = "Unsupported request" }, true); break; }
                    string lengthHeader; int bodyLength = 0;
                    if (headers.TryGetValue("Content-Length", out lengthHeader) && (!int.TryParse(lengthHeader, out bodyLength) || bodyLength < 0 || bodyLength > 4096)) {
                        Reply(stream, 400, new { error = "Invalid body size" }, true); break;
                    }
                    // Drain a bounded body before replying so Windows does not reset the socket.
                    var body = new byte[bodyLength]; int bodyOffset = 0;
                    while (bodyOffset < bodyLength) { int count = stream.Read(body, bodyOffset, bodyLength-bodyOffset); if (count == 0) throw new IOException(); bodyOffset += count; }
                    string authorization;
                    if (!headers.TryGetValue("Authorization", out authorization) || !Equal(authorization, "Bearer " + token)) {
                        Reply(stream, 401, new { error = "Invalid companion token" }, true); break;
                    }
                    string path = first[1].Split('?')[0];
                    bool keepAlive = !headers.ContainsKey("Connection") || !string.Equals(headers["Connection"], "close", StringComparison.OrdinalIgnoreCase);
                    if (first[0] == "GET" && path == "/api/catalog") { Reply(stream, 200, catalog(), keepAlive); continue; }
                    if (first[0] == "GET" && path == "/api/status") { Reply(stream, 200, status(), keepAlive); continue; }
                    if (first[0] == "GET" && path.StartsWith("/api/artwork/")) {
                        var parts = path.Split('/'); Guid id;
                        if (parts.Length != 5 || !Guid.TryParse(parts[3], out id) || (parts[4] != "cover" && parts[4] != "background")) {
                            Reply(stream, 400, new { error = "Invalid artwork request" }, true); break;
                        }
                        var bytes = artwork(id, parts[4]);
                        if (bytes == null) Reply(stream, 404, new { error = "Artwork unavailable" }, keepAlive);
                        else Write(stream, 200, "image/jpeg", bytes, keepAlive);
                        continue;
                    }
                    if (first[0] == "POST" && path == "/api/launch") {
                        if (bodyLength < 2) { Reply(stream, 400, new { error = "Invalid body size" }, true); break; }
                        var data = JObject.Parse(Encoding.UTF8.GetString(body)); Guid id, requestId;
                        if (!Guid.TryParse((string)data["id"], out id) || !Guid.TryParse((string)data["requestId"], out requestId)) {
                            Reply(stream, 400, new { error = "Game id and requestId must be UUIDs" }, true); break;
                        }
                        Reply(stream, 200, launch(id, requestId), true); break;
                    }
                    Reply(stream, 404, new { error = "Endpoint unavailable" }, true); break;
                }
            } catch (ApiException e) { try { Reply(client.GetStream(), e.Status, new { error = e.Message }, true); } catch { } }
              catch (JsonException) { try { Reply(client.GetStream(), 400, new { error = "Invalid JSON" }, true); } catch { } }
              catch (Exception) { try { Reply(client.GetStream(), 503, new { error = "Playnite is busy. Try again." }, true); } catch { } }
        }

        private static bool Equal(string a, string b) {
            int difference = a.Length ^ b.Length;
            for (int i = 0; i < b.Length; i++) difference |= (i < a.Length ? a[i] : 0) ^ b[i];
            return difference == 0;
        }
        private static void Reply(Stream stream, int code, object value, bool keepAlive) {
            Write(stream, code, "application/json; charset=utf-8", value == null ? new byte[0] : Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(value)), keepAlive);
        }
        private static void Write(Stream stream, int code, string type, byte[] bytes, bool keepAlive) {
            var head = Encoding.ASCII.GetBytes("HTTP/1.1 " + code + " " + (code < 300 ? "OK" : "Error") + "\r\nContent-Type: " + type +
                "\r\nContent-Length: " + bytes.Length + "\r\nConnection: " + (keepAlive ? "keep-alive" : "close") + "\r\nCache-Control: no-store\r\n" +
                "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Allow-Private-Network: true\r\nX-Content-Type-Options: nosniff\r\n\r\n");
            stream.Write(head, 0, head.Length); stream.Write(bytes, 0, bytes.Length);
        }
        public void Dispose() { stopping = true; listener.Stop(); }
    }
    public sealed class ApiException : Exception {
        public int Status { get; private set; }
        public ApiException(int status, string message) : base(message) { Status = status; }
    }
}
