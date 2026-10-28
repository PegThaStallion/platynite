param([string]$PlaynitePath = "$env:LOCALAPPDATA\Playnite", [string]$Destination = "$PSScriptRoot\..\build\companion")
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..").Path
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$compiler = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$wpf = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\WPF"
$refs = @("$PlaynitePath\Playnite.SDK.dll", "$PlaynitePath\Newtonsoft.Json.dll", "$wpf\PresentationFramework.dll", "$wpf\WindowsBase.dll", "$wpf\PresentationCore.dll", 'System.Xaml.dll', 'System.Drawing.dll', 'System.Core.dll')
$arguments = @('/nologo', '/target:library', '/optimize+', "/out:$Destination\PlatyniteCompanion.dll")
$arguments += $refs | ForEach-Object { "/reference:$_" }
$arguments += @("$repo\companion\CompanionServer.cs", "$repo\companion\CloudCatalog.cs", "$repo\companion\PlatyniteCompanion.cs")
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'Companion compilation failed' }
Copy-Item -LiteralPath "$repo\companion\extension.yaml" -Destination $Destination
Copy-Item -LiteralPath "$repo\res\icon.png" -Destination "$Destination\icon.png"
Copy-Item -LiteralPath "$repo\LICENSE" -Destination "$Destination\LICENSE.txt"
$archive = Join-Path (Split-Path $Destination) 'PlatyniteCompanion.zip'
Compress-Archive -Path "$Destination\*" -DestinationPath $archive -Force
Move-Item -LiteralPath $archive -Destination (Join-Path (Split-Path $Destination) 'PlatyniteCompanion.pext') -Force
