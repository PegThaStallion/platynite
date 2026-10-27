param(
  [Parameter(Mandatory)][string]$Package,
  [Parameter(Mandatory)][string]$Signer,
  [string]$CertificateDirectory = "$env:APPDATA\Apps2Samsung\Certificate\Jelly2Sams - Partner"
)
$ErrorActionPreference = 'Stop'
$password = (Get-Content -LiteralPath (Join-Path $CertificateDirectory 'password.txt') -Raw).Trim()
& $Signer resign $Package (Join-Path $CertificateDirectory 'author.p12') (Join-Path $CertificateDirectory 'distributor.p12') $password
if ($LASTEXITCODE -ne 0) { throw 'Widget signing failed' }
Remove-Variable password
