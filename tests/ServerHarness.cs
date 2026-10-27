using System;
using System.Collections.Generic;
using Platynite;
public static class ServerHarness {
    public static void Main(string[] args) {
        var seen = new HashSet<Guid>(); int launches = 0;
        using (var server = new CompanionServer(int.Parse(args[0]), "test-companion-token",
            () => new { version = 1, games = new[] { new { id = "11111111-1111-4111-8111-111111111111", installed = true } } },
            (id, request) => {
                if (id != Guid.Parse("11111111-1111-4111-8111-111111111111")) throw new ApiException(409,"Game is not installed");
                if (seen.Add(request)) launches++;
                return new { launches = launches };
            },
            (id, kind) => id == Guid.Parse("11111111-1111-4111-8111-111111111111") ? new byte[] { 255,216,255,217 } : null)) {
            server.Start(); Console.WriteLine("READY"); Console.ReadLine();
        }
    }
}
