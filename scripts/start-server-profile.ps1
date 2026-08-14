param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('run', 'movement-lab')]
    [string]$Profile
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$settings = if ($Profile -eq 'run') {
    @{ Directory = 'mc-server-run'; Config = 'run.properties'; Port = 25565 }
} else {
    @{ Directory = 'mc-server-26-2-test'; Config = 'movement-lab.properties'; Port = 25566 }
}
$server = Join-Path $root $settings.Directory
$config = Join-Path $root (Join-Path 'config\servers' $settings.Config)
$jar = Join-Path $server 'server.jar'
$sourceJar = Join-Path $root 'mc-server-26-2-test\server.jar'

if (-not (Test-Path -LiteralPath $jar)) {
    if (-not (Test-Path -LiteralPath $sourceJar)) {
        throw "Paper 26.2 server.jar was not found at $sourceJar"
    }
    New-Item -ItemType Directory -Path $server -Force | Out-Null
    Copy-Item -LiteralPath $sourceJar -Destination $jar
}
if (Get-NetTCPConnection -State Listen -LocalPort $settings.Port -ErrorAction SilentlyContinue) {
    throw "Port $($settings.Port) is already in use"
}

Copy-Item -LiteralPath $config -Destination (Join-Path $server 'server.properties') -Force
Set-Content -LiteralPath (Join-Path $server 'eula.txt') -Value 'eula=true' -Encoding ascii

Write-Host "[SORIM] Starting $Profile server on port $($settings.Port)"
Push-Location $server
try {
    & java -Xms1G -Xmx2G -jar server.jar --nogui
} finally {
    Pop-Location
}
