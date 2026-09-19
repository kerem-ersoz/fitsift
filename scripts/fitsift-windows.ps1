[CmdletBinding()]
param(
    [ValidateSet("start", "stop", "status", "install")]
    [string]$Command = "start"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Distro = if ($env:FITSIFT_WSL_DISTRO) { $env:FITSIFT_WSL_DISTRO } else { "Ubuntu" }

function ConvertTo-WslPath([string]$WindowsPath) {
    if ($WindowsPath -notmatch '^([A-Za-z]):\\(.*)$') {
        throw "The launcher requires a local Windows drive path: $WindowsPath"
    }
    $drive = $Matches[1].ToLowerInvariant()
    $rest = $Matches[2].Replace('\', '/')
    return "/mnt/$drive/$rest"
}

$WslRepo = if ($env:FITSIFT_WSL_REPO) {
    $env:FITSIFT_WSL_REPO
}
else {
    ConvertTo-WslPath $RepoRoot
}
$WslFit2Json = if ($env:FITSIFT_WSL_FIT2JSON) {
    $env:FITSIFT_WSL_FIT2JSON
}
else {
    '$HOME/fitsift/.venv/bin/fit2json'
}
$Port = if ($env:FITSIFT_PORT) { $env:FITSIFT_PORT } else { "8000" }
$Url = "http://localhost:$Port"

function ConvertTo-BashLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "'\''") + "'"
}

function Invoke-FitSiftWsl([string]$FitSiftCommand) {
    Write-Host "FitSift WSL: $FitSiftCommand"
    $repo = ConvertTo-BashLiteral $WslRepo
    $fit2json = ConvertTo-BashLiteral $WslFit2Json
    $script = "export FIT2JSON_BIN=$fit2json; export PYTHONPATH=$repo/src; cd $repo && bash ./scripts/fitsift $FitSiftCommand"
    @() | & wsl.exe -d $Distro -- bash -lc "`"$script`""
    if ($LASTEXITCODE -ne 0) {
        throw "FitSift WSL command failed: $FitSiftCommand"
    }
}

function Assert-WslSetup {
    $fit2json = ConvertTo-BashLiteral $WslFit2Json
    $script = "test -x $fit2json && test -x /usr/local/bin/copilot"
    @() | & wsl.exe -d $Distro -- bash -lc "`"$script`""
    if ($LASTEXITCODE -ne 0) {
        throw "The FitSift Python environment or Copilot CLI is missing in WSL distro '$Distro'."
    }
}

function Start-FitSift {
    Write-Host "Checking the FitSift WSL installation..."
    Assert-WslSetup

    # A launch always replaces the existing stack; the file lock serializes rapid clicks.
    Invoke-FitSiftWsl "stop && bash ./scripts/fitsift local"

    $healthy = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
            $healthy = $true
            break
        }
        catch {
            Start-Sleep -Seconds 1
        }
    }

    if (-not $healthy) {
        throw "The WSL web service did not become healthy on port $Port."
    }

    Start-Process -FilePath "$env:SystemRoot\explorer.exe" -ArgumentList $Url
    Write-Host "FitSift is running from WSL at $Url"
}

function Install-Launcher {
    $programs = [Environment]::GetFolderPath("Programs")
    $shortcutPath = Join-Path $programs "FitSift.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" start"
    $shortcut.WorkingDirectory = $RepoRoot
    $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,137"
    $shortcut.Description = "Restart FitSift in WSL and open it in the browser"
    $shortcut.Save()

    Write-Host "Installed the FitSift shortcut in the Start menu."
    Write-Host "Search for FitSift, right-click it, and choose 'Pin to taskbar'."
}

switch ($Command) {
    "start" {
        $lockPath = Join-Path $env:TEMP "FitSiftLauncher.lock"
        $lockStream = $null
        try {
            while (-not $lockStream) {
                try {
                    $lockStream = [System.IO.File]::Open(
                        $lockPath,
                        [System.IO.FileMode]::OpenOrCreate,
                        [System.IO.FileAccess]::ReadWrite,
                        [System.IO.FileShare]::None
                    )
                }
                catch [System.IO.IOException] {
                    Start-Sleep -Milliseconds 250
                }
            }
            Start-FitSift
        }
        finally {
            if ($lockStream) {
                $lockStream.Dispose()
            }
        }
    }
    "stop" { Invoke-FitSiftWsl "stop" }
    "status" { Invoke-FitSiftWsl "status" }
    "install" { Install-Launcher }
}
