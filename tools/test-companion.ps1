param([string]$PlaynitePath = "$env:LOCALAPPDATA\Playnite", [string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..").Path
$destination = Join-Path $repo 'build\server-test'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Copy-Item -LiteralPath "$PlaynitePath\Newtonsoft.Json.dll" -Destination $destination
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe "/out:$destination\ServerHarness.exe" "/reference:$PlaynitePath\Newtonsoft.Json.dll" "$repo\companion\CompanionServer.cs" "$repo\tests\ServerHarness.cs"
if ($LASTEXITCODE -ne 0) { throw 'Server harness compilation failed' }
& $Python "$repo\tests\server-test.py" "$destination\ServerHarness.exe"
if ($LASTEXITCODE -ne 0) { throw 'Companion HTTP tests failed' }
