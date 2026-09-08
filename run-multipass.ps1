#Requires -Version 5.1
# Quick start SmartBoard in Multipass VM "smart-board" via Docker.
# - start VM if needed
# - check project mount (docker-compose.yml / package.json / server.js)
# - remount if broken
# - sync SMARTBOARD_PUBLIC_URL in .env to VM LAN IP
# - docker compose up --build with live logs
#
# Usage (PowerShell needs .\ prefix):
#   .\run-multipass.ps1
#   .\run-multipass.ps1 -Detach
#   .\run-multipass.ps1 -NoBuild
#   .\run-multipass.ps1 -PublicUrl http://192.168.99.175:3000
[CmdletBinding()]
param(
    [string]$VmName = 'smart-board',
    [string]$GuestPath = '/home/ubuntu/SmartBoard',
    [string]$PublicUrl = '',
    [int]$AppPort = 3000,
    [switch]$Detach,
    [switch]$NoBuild,
    [switch]$SkipMountCheck,
    [switch]$SkipEnvSync
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "OK  $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
    Write-Host "!!  $Message" -ForegroundColor Yellow
}

function Assert-Multipass {
    if (-not (Get-Command multipass -ErrorAction SilentlyContinue)) {
        throw 'multipass not found in PATH'
    }
}

function Get-HostProjectPath {
    # Works from repo root (.\run-multipass.ps1) or from scripts\ folder.
    if (Test-Path (Join-Path $PSScriptRoot 'docker-compose.yml')) {
        return (Resolve-Path $PSScriptRoot).Path
    }
    $parent = Join-Path $PSScriptRoot '..'
    if (Test-Path (Join-Path $parent 'docker-compose.yml')) {
        return (Resolve-Path $parent).Path
    }
    throw 'docker-compose.yml not found near script'
}

function Get-VmState([string]$Name) {
    $line = multipass list --format csv |
        Select-Object -Skip 1 |
        Where-Object { $_ -match ("^" + [regex]::Escape($Name) + ",") } |
        Select-Object -First 1
    if (-not $line) { return $null }
    return ($line -split ',')[1].Trim()
}

function Ensure-VmRunning([string]$Name) {
    Write-Step ("Check VM " + $Name)
    $state = Get-VmState $Name
    if (-not $state) {
        throw ("VM '" + $Name + "' not found. Create: multipass launch -n " + $Name + " --cpus 2 --memory 2G --disk 10G")
    }
    Write-Host ("State: " + $state)
    if ($state -ne 'Running') {
        Write-Warn 'Starting VM...'
        multipass start $Name
        Start-Sleep -Seconds 2
        $state = Get-VmState $Name
        if ($state -ne 'Running') {
            throw ("Failed to start VM '" + $Name + "' (state=" + $state + ")")
        }
    }
    Write-Ok 'VM Running'
}

function Test-GuestFile([string]$Name, [string]$RelativePath) {
    $guestFile = ($GuestPath.TrimEnd('/') + '/' + $RelativePath.TrimStart('/')) -replace '\\', '/'
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & multipass exec $Name -- test -f $guestFile 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Get-InfoMountLine([string]$Name) {
    $info = multipass info $Name 2>&1 | Out-String
    if ($info -match '(?m)^\s*Mounts:\s*(.+)$') {
        return $Matches[1].Trim()
    }
    return ''
}

function Test-ProjectMountHealthy([string]$Name, [string]$HostPath) {
    $required = @('docker-compose.yml', 'package.json', 'server.js', 'Dockerfile')
    foreach ($rel in $required) {
        if (-not (Test-GuestFile $Name $rel)) {
            Write-Warn ("Missing in VM: " + $GuestPath + "/" + $rel)
            return $false
        }
    }

    $mountLine = Get-InfoMountLine $Name
    if (-not $mountLine -or $mountLine -eq '--') {
        Write-Warn 'No Mounts in multipass info'
        return $false
    }

    $normHost = [System.IO.Path]::GetFullPath($HostPath).TrimEnd('\', '/').ToLowerInvariant()
    $normMount = $mountLine.Split('=>')[0].Trim().TrimEnd('\', '/').ToLowerInvariant()
    if ($normMount -and ($normMount -ne $normHost)) {
        Write-Warn 'Mounted path differs from project path:'
        Write-Warn ("  now:  " + $mountLine)
        Write-Warn ("  need: " + $HostPath + " => " + $GuestPath)
        return $false
    }

    return $true
}

function Ensure-ProjectMount([string]$Name, [string]$HostPath) {
    Write-Step 'Check project mount'
    Write-Host ("Host:  " + $HostPath)
    Write-Host ("Guest: " + $Name + ":" + $GuestPath)

    if (Test-ProjectMountHealthy $Name $HostPath) {
        Write-Ok 'Project mount is healthy'
        return
    }

    Write-Warn 'Mount broken or missing - remounting...'

    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & multipass umount $Name 2>&1 | Out-Host
    } finally {
        $ErrorActionPreference = $prev
    }

    # One-liners via argv array (safer under Multipass on Windows).
    $cleanupCmd = 'GP=''' + $GuestPath + '''; if [ -d "$GP" ] && ! mountpoint -q "$GP" 2>/dev/null && [ ! -f "$GP/docker-compose.yml" ]; then echo Removing stale guest dir...; sudo rm -rf "$GP"; fi; mkdir -p "$GP"'
    $mpClean = @('exec', $Name, '--', 'bash', '-lc', $cleanupCmd)
    & multipass @mpClean

    Write-Host ("multipass mount `"$HostPath`" " + $Name + ":" + $GuestPath)
    multipass mount $HostPath ($Name + ':' + $GuestPath)
    Start-Sleep -Seconds 1

    if (-not (Test-ProjectMountHealthy $Name $HostPath)) {
        Write-Host ''
        Write-Host ("Contents of " + $GuestPath + " after mount:") -ForegroundColor Yellow
        $lsCmd = "ls -la '" + $GuestPath + "' | head -40"
        $mpLs = @('exec', $Name, '--', 'bash', '-lc', $lsCmd)
        & multipass @mpLs
        throw 'Failed to mount project. Check Multipass mount / Windows permissions.'
    }

    Write-Ok 'Mount restored'
}

function Invoke-GuestBash([string]$Name, [string]$Command) {
    # Pass command as a single argv element (PowerShell array call).
    $mpArgs = @('exec', $Name, '--', 'bash', '-lc', $Command)
    & multipass @mpArgs
    if ($LASTEXITCODE -ne 0) {
        throw ("Command failed in VM (exit " + $LASTEXITCODE + ")")
    }
}

function Test-IsDockerBridgeIp([string]$Ip) {
    return $Ip -match '^172\.(1[7-9]|2\d|3[01])\.'
}

function Test-IsPrivateLanIp([string]$Ip) {
    return $Ip -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)'
}

function Get-VmIpv4List([string]$Name) {
    $jsonText = multipass info $Name --format json | Out-String
    $info = $jsonText | ConvertFrom-Json
    $ips = @($info.info.$Name.ipv4)
    if (-not $ips -or $ips.Count -eq 0) {
        # Fallback parse from text
        $text = multipass info $Name | Out-String
        $ips = [regex]::Matches($text, '\b(?:\d{1,3}\.){3}\d{1,3}\b') | ForEach-Object { $_.Value } | Select-Object -Unique
    }
    return @($ips | Where-Object { $_ -and $_ -ne '127.0.0.1' })
}

function Get-PreferredVmLanIp([string]$Name) {
    $ips = @(Get-VmIpv4List $Name)
    if ($ips.Count -eq 0) { return $null }

    # Prefer real LAN (192.168/10), skip docker bridges (172.17-31 often virtual).
    $lan192 = $ips | Where-Object { $_ -match '^192\.168\.' } | Select-Object -First 1
    if ($lan192) { return $lan192 }

    $lan10 = $ips | Where-Object { $_ -match '^10\.' } | Select-Object -First 1
    if ($lan10) { return $lan10 }

    $otherPrivate = $ips | Where-Object { (Test-IsPrivateLanIp $_) -and -not (Test-IsDockerBridgeIp $_) } | Select-Object -First 1
    if ($otherPrivate) { return $otherPrivate }

    return $ips[0]
}

function Sync-PublicUrlEnv([string]$HostPath, [string]$Url) {
    $envFile = Join-Path $HostPath '.env'
    $line = 'SMARTBOARD_PUBLIC_URL=' + $Url
    # Read/write as bytes via .NET to avoid PowerShell encoding mojibake on comments.
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    $raw = ''
    if (Test-Path $envFile) {
        $raw = [System.IO.File]::ReadAllText($envFile)
    }
    if ($raw -match '(?m)^\s*SMARTBOARD_PUBLIC_URL\s*=') {
        $updated = [regex]::Replace($raw, '(?m)^\s*SMARTBOARD_PUBLIC_URL\s*=.*$', $line)
    } elseif ([string]::IsNullOrEmpty($raw)) {
        $updated = "# URL for server access (LAN IP). Auto-updated by scripts/run-multipass.ps1`r`n" + $line + "`r`n"
    } else {
        $nl = if ($raw.EndsWith("`n")) { '' } else { "`r`n" }
        $updated = $raw + $nl + $line + "`r`n"
    }
    if ($updated -ne $raw) {
        [System.IO.File]::WriteAllText($envFile, $updated, $utf8NoBom)
        Write-Ok ('.env updated: ' + $line)
    } else {
        Write-Ok ('.env already has: ' + $line)
    }
}

function Resolve-PublicUrl([string]$Name, [string]$HostPath) {
    Write-Step 'SMARTBOARD_PUBLIC_URL'
    if ($PublicUrl -and $PublicUrl.Trim()) {
        $url = $PublicUrl.Trim().TrimEnd('/')
        Write-Host ('Using -PublicUrl: ' + $url)
        if (-not $SkipEnvSync) { Sync-PublicUrlEnv $HostPath $url }
        return $url
    }

    $ip = Get-PreferredVmLanIp $Name
    if (-not $ip) {
        Write-Warn 'No VM IPv4 found; leaving .env as is'
        return ''
    }

    $url = 'http://' + $ip + ':' + $AppPort
    Write-Host ('Detected LAN IP: ' + $ip)
    Write-Host ('Public URL:     ' + $url)
    if (-not $SkipEnvSync) { Sync-PublicUrlEnv $HostPath $url }
    return $url
}

function Start-SmartBoardDocker([string]$Name, [string]$Url) {
    Write-Step 'Docker Compose in VM'
    $composeArgs = @('up')
    if (-not $NoBuild) { $composeArgs += '--build' }
    if ($Detach) { $composeArgs += '-d' }
    # Recreate so env SMARTBOARD_PUBLIC_URL is applied even without image rebuild.
    $composeArgs += '--force-recreate'
    $argLine = ($composeArgs -join ' ')

    $envPrefix = ''
    if ($Url) {
        $envPrefix = 'SMARTBOARD_PUBLIC_URL=' + $Url + ' '
    }

    Write-Host ("cd " + $GuestPath + " && " + $envPrefix + "docker compose " + $argLine)
    if ($Detach) {
        Write-Host '(detached; use compose logs -f for follow)'
    } else {
        Write-Host '(live logs; Ctrl+C stops compose)'
    }
    Write-Host ''

    # Avoid bash { } groups - they break when forwarded via Multipass on Windows.
    $runCmd = "set -e; cd '" + $GuestPath + "'; test -f docker-compose.yml; export SMARTBOARD_PUBLIC_URL='" + $Url + "'; if docker info >/dev/null 2>&1; then docker compose " + $argLine + "; elif sudo docker info >/dev/null 2>&1; then sudo docker compose " + $argLine + "; else echo 'ERROR: Docker unavailable'; exit 1; fi"
    Invoke-GuestBash $Name $runCmd
}

Assert-Multipass
$hostPath = Get-HostProjectPath

if (-not (Test-Path (Join-Path $hostPath 'docker-compose.yml'))) {
    throw ("docker-compose.yml missing on host: " + $hostPath)
}

Ensure-VmRunning $VmName

if (-not $SkipMountCheck) {
    Ensure-ProjectMount $VmName $hostPath
} else {
    Write-Warn 'Skipping mount check (-SkipMountCheck)'
}

Write-Step 'VM network'
multipass info $VmName | Select-String -Pattern 'IPv4|Mounts' | ForEach-Object { Write-Host $_.Line.Trim() }

$resolvedUrl = Resolve-PublicUrl $VmName $hostPath
Start-SmartBoardDocker $VmName $resolvedUrl

if ($Detach) {
    Write-Step 'Container is detached'
    Write-Host ("  multipass exec " + $VmName + " -- bash -lc `"cd '" + $GuestPath + "' && docker compose logs -f`"")
    Write-Host ''
    if ($resolvedUrl) {
        Write-Host ('Open: ' + $resolvedUrl) -ForegroundColor Green
    } else {
        Write-Host 'Open: http://<VM-IPv4>:3000' -ForegroundColor Green
    }
} else {
    if ($resolvedUrl) {
        Write-Host ''
        Write-Host ('Open: ' + $resolvedUrl) -ForegroundColor Green
    }
}
