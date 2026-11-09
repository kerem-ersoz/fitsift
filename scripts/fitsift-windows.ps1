[CmdletBinding()]
param(
    [ValidateSet("start", "stop", "status", "install")]
    [string]$Command = "start",

    # The Start-menu shortcut has no terminal to report errors in, so keep its window open.
    [switch]$PauseOnError
)

$ErrorActionPreference = "Stop"

# Run from a checkout, this script runs that checkout (handy while developing). The copy that
# `install` places under %LOCALAPPDATA% has no checkout next to it, so it runs the WSL install
# instead; the shortcut then survives deleted checkouts such as Copilot worktrees.
$IsInstalledCopy = -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "fitsift"))
$InstallDir = Join-Path $env:LOCALAPPDATA "FitSift"
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
elseif ($IsInstalledCopy) {
    '$HOME/fitsift'
}
else {
    ConvertTo-WslPath (Split-Path -Parent $PSScriptRoot)
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

# Runs a bash command line from the WSL repo root, using the WSL Python environment.
function Invoke-FitSiftWsl([string]$BashCommand, [string]$Label = $BashCommand) {
    Write-Host "FitSift WSL: $Label"
    $repo = ConvertTo-BashLiteral $WslRepo
    $fit2json = ConvertTo-BashLiteral $WslFit2Json
    $script = "export FIT2JSON_BIN=$fit2json; export PYTHONPATH=$repo/src; cd $repo && $BashCommand"
    @() | & wsl.exe -d $Distro -- bash -lc "`"$script`""
    if ($LASTEXITCODE -ne 0) {
        throw "FitSift WSL command failed: $Label"
    }
}

function Assert-WslSetup {
    $repo = ConvertTo-BashLiteral $WslRepo
    $fit2json = ConvertTo-BashLiteral $WslFit2Json
    $script = "test -f $repo/scripts/fitsift && test -x $fit2json && test -x /usr/local/bin/copilot"
    @() | & wsl.exe -d $Distro -- bash -lc "`"$script`""
    if ($LASTEXITCODE -ne 0) {
        throw "WSL distro '$Distro' is missing the FitSift checkout ($WslRepo), its Python environment ($WslFit2Json), or the Copilot CLI."
    }
}

function Update-WslInstall {
    # Fast-forward only, so local work in the WSL clone is never overwritten. If updating fails
    # (offline, diverged, local edits in the way), the current version still starts.
    $warning = "Could not update FitSift; starting the current version."
    Invoke-FitSiftWsl -Label "update from upstream" -BashCommand (
        "{ GIT_TERMINAL_PROMPT=0 timeout 60 git pull --ff-only --quiet || echo '$warning'; } && " +
        "git --no-pager log -1 --format='Running FitSift %h: %s'"
    )
}

function Start-FitSift {
    Write-Host "Checking the FitSift WSL installation..."
    Assert-WslSetup

    if ($IsInstalledCopy) {
        Update-WslInstall
    }

    # A launch always replaces the existing stack; the file lock serializes rapid clicks.
    Invoke-FitSiftWsl "bash ./scripts/fitsift stop && bash ./scripts/fitsift local"

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
        throw "The WSL web service did not become healthy on port $Port; see ~/.fit2json/logs/web.log in WSL."
    }

    Start-Process -FilePath "$env:SystemRoot\explorer.exe" -ArgumentList $Url
    Write-Host "FitSift is running from WSL at $Url"
}

function Install-Launcher {
    if ($IsInstalledCopy) {
        throw "Run 'FitSift.cmd install' from a FitSift checkout to install or update the launcher."
    }

    # Copy the launcher out of the checkout so the shortcut outlives it.
    $launcher = Join-Path $InstallDir "fitsift-windows.ps1"
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Copy-Item -LiteralPath $PSCommandPath -Destination $launcher -Force

    $shell = New-Object -ComObject WScript.Shell
    $shortcutPaths = @(Join-Path ([Environment]::GetFolderPath("Programs")) "FitSift.lnk")
    # Re-point an existing taskbar pin too, so it doesn't have to be unpinned and pinned again.
    $pinPath = Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\FitSift.lnk"
    $hasPin = (Test-Path -LiteralPath $pinPath) -and
        ($shell.CreateShortcut($pinPath).Arguments -like "*fitsift-windows.ps1*")
    if ($hasPin) {
        $shortcutPaths += $pinPath
    }

    foreach ($shortcutPath in $shortcutPaths) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" start -PauseOnError"
        $shortcut.WorkingDirectory = $InstallDir
        $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,137"
        $shortcut.Description = "Update FitSift in WSL, restart it, and open it in the browser"
        $shortcut.Save()
    }

    Write-Host "Installed the FitSift launcher in $InstallDir and the Start menu."
    if ($hasPin) {
        Write-Host "Updated the existing FitSift taskbar pin."
    }
    else {
        Write-Host "Search for FitSift, right-click it, and choose 'Pin to taskbar'."
    }
}

try {
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
        "stop" { Invoke-FitSiftWsl "bash ./scripts/fitsift stop" }
        "status" { Invoke-FitSiftWsl "bash ./scripts/fitsift status" }
        "install" { Install-Launcher }
    }
}
catch {
    if (-not $PauseOnError) {
        throw
    }
    Write-Host ""
    Write-Host "FitSift $Command failed: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host "Press Enter to close" | Out-Null
    exit 1
}
