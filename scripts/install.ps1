#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet("Install", "Check", "Uninstall", "Purge")]
    [string]$Action = "Install",
    [string]$PackageSpec = $env:OPENCODEX_PACKAGE_SPEC,
    [string]$ExpectedSha256 = $env:OPENCODEX_PACKAGE_SHA256,
    [string]$InstallPrefix = $env:OPENCODEX_INSTALL_PREFIX,
    [string]$ShimDirectory = $env:OPENCODEX_BIN_DIR
)

$ErrorActionPreference = "Stop"
$PackageName = "opencodex-universal"

if ([string]::IsNullOrWhiteSpace($PackageSpec)) {
    $PackageSpec = "$PackageName@preview"
}
if ([string]::IsNullOrWhiteSpace($InstallPrefix)) {
    $InstallPrefix = Join-Path $env:LOCALAPPDATA "OpenCodexUniversal\npm"
}
if ([string]::IsNullOrWhiteSpace($ShimDirectory)) {
    $ShimDirectory = Join-Path $env:LOCALAPPDATA "OpenCodexUniversal\bin"
}
if ([string]::IsNullOrWhiteSpace($env:OPENCODEX_HOME)) {
    $StateDirectory = Join-Path $env:USERPROFILE ".opencodex"
} else {
    $StateDirectory = [System.IO.Path]::GetFullPath($env:OPENCODEX_HOME)
}

$InstallPrefix = [System.IO.Path]::GetFullPath($InstallPrefix)
$ShimDirectory = [System.IO.Path]::GetFullPath($ShimDirectory)
$PathMarker = Join-Path $ShimDirectory ".opencodex-universal-path"
$InstallRoot = [System.IO.Path]::GetPathRoot($InstallPrefix)
$UserProfilePath = [System.IO.Path]::GetFullPath($env:USERPROFILE)
if ([string]::IsNullOrWhiteSpace($InstallPrefix) -or
    $InstallPrefix -eq $InstallRoot -or
    $InstallPrefix.TrimEnd("\") -eq $UserProfilePath.TrimEnd("\")) {
    throw "Refusing unsafe install prefix '$InstallPrefix'."
}
if ((Test-Path -LiteralPath $InstallPrefix) -and
    (Get-Item -LiteralPath $InstallPrefix -Force).Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
    throw "Install prefix must be a real directory, not a reparse point: $InstallPrefix"
}

function Get-ExternalApplication {
    param(
        [Parameter(Mandatory = $true)][string[]]$Names,
        [Parameter(Mandatory = $true)][string]$Purpose
    )
    foreach ($Name in $Names) {
        $matches = @(Get-Command $Name -CommandType Application -All -ErrorAction SilentlyContinue)
        foreach ($match in $matches) {
            if ($match.Source -and (Test-Path -LiteralPath $match.Source -PathType Leaf)) {
                return $match.Source
            }
        }
    }
    throw "$Purpose was not found as an executable application."
}

function Get-LauncherPath {
    param([Parameter(Mandatory = $true)][string]$Prefix)
    return (Join-Path $Prefix "ocxu.cmd")
}

function Invoke-Launcher {
    param(
        [Parameter(Mandatory = $true)][string]$Launcher,
        [Parameter(Mandatory = $false)][string[]]$Arguments = @(),
        [switch]$Quiet
    )
    if ($Quiet) {
        & $Launcher @Arguments *> $null
    } else {
        & $Launcher @Arguments
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Launcher failed with exit code $LASTEXITCODE`: $Launcher $($Arguments -join ' ')"
    }
}

function Write-CommandShim {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Target
    )
    if (-not (Test-Path -LiteralPath $ShimDirectory)) {
        New-Item -ItemType Directory -Path $ShimDirectory -Force | Out-Null
    }
    $destination = Join-Path $ShimDirectory "$Name.cmd"
    $temporary = "$destination.$PID.tmp"
    $content = "@echo off`r`ncall `"$Target`" %*`r`nexit /b %ERRORLEVEL%`r`n"
    [System.IO.File]::WriteAllText($temporary, $content, [System.Text.Encoding]::ASCII)
    Move-Item -LiteralPath $temporary -Destination $destination -Force
}

function Install-CommandShims {
    $target = Get-LauncherPath -Prefix $InstallPrefix
    Write-CommandShim -Name "ocxu" -Target $target
    Write-CommandShim -Name "opencodex-universal" -Target (Join-Path $InstallPrefix "opencodex-universal.cmd")

    $existingOcx = Get-Command ocx.cmd -CommandType Application -ErrorAction SilentlyContinue
    $managedOcx = Join-Path $ShimDirectory "ocx.cmd"
    if (-not $existingOcx -or $existingOcx.Source -eq $managedOcx) {
        Write-CommandShim -Name "ocx" -Target (Join-Path $InstallPrefix "ocx.cmd")
    } else {
        Write-Host "Existing ocx left untouched: $($existingOcx.Source)" -ForegroundColor Yellow
    }

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $segments = @($userPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $normalizedShim = $ShimDirectory.Trim().TrimEnd("\")
    $containsShim = @($segments | Where-Object {
        $_.Trim().TrimEnd("\") -ieq $normalizedShim
    }).Count -gt 0
    if (-not $containsShim) {
        $newUserPath = (@($segments) + $ShimDirectory) -join ";"
        $markerPayload = @{
            version = 1
            previousUserPath = $userPath
        } | ConvertTo-Json -Compress
        $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
        [System.IO.File]::WriteAllText($PathMarker, $markerPayload, $utf8NoBom)
        try {
            [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
        } catch {
            Remove-Item -LiteralPath $PathMarker -Force -ErrorAction SilentlyContinue
            throw
        }
    }
    $processSegments = @($env:Path -split ";")
    if ($processSegments -notcontains $ShimDirectory) {
        $env:Path = "$env:Path;$ShimDirectory"
    }
}

function Remove-ManagedShims {
    foreach ($name in @("ocxu.cmd", "opencodex-universal.cmd", "ocx.cmd")) {
        $path = Join-Path $ShimDirectory $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            continue
        }
        $content = [System.IO.File]::ReadAllText($path)
        if ($content.Contains($InstallPrefix)) {
            Remove-Item -LiteralPath $path -Force
        }
    }
}

function Remove-ShimDirectoryFromUserPath {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ([string]::IsNullOrWhiteSpace($userPath)) {
        return
    }
    $normalizedShim = $ShimDirectory.TrimEnd("\")
    $defaultShim = [System.IO.Path]::GetFullPath(
        (Join-Path $env:LOCALAPPDATA "OpenCodexUniversal\bin")
    ).TrimEnd("\")
    $hasMarker = Test-Path -LiteralPath $PathMarker -PathType Leaf
    if (-not $hasMarker -and $normalizedShim -ine $defaultShim) {
        return
    }
    $unmanagedEntries = @(
        Get-ChildItem -LiteralPath $ShimDirectory -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -ine $PathMarker }
    )
    if ($unmanagedEntries.Count -gt 0) {
        Write-Warning "Keeping user PATH entry because the shim directory contains unmanaged files: $ShimDirectory"
        return
    }
    $restoredExactPath = $false
    if ($hasMarker) {
        try {
            $markerState = Get-Content -LiteralPath $PathMarker -Raw | ConvertFrom-Json
            $previousPathProperty = $markerState.PSObject.Properties["previousUserPath"]
            if ($markerState.version -eq 1 -and $null -ne $previousPathProperty) {
                $previousUserPath = $previousPathProperty.Value
                $previousSegments = @($previousUserPath -split ";" | Where-Object {
                    -not [string]::IsNullOrWhiteSpace($_)
                })
                $expectedInstalledPath = (@($previousSegments) + $ShimDirectory) -join ";"
                if ($userPath -ceq $expectedInstalledPath) {
                    [Environment]::SetEnvironmentVariable("Path", $previousUserPath, "User")
                    $restoredExactPath = $true
                }
            }
        } catch {
            # Legacy or malformed marker: remove only our segment below.
        }
    }
    if (-not $restoredExactPath) {
        $segments = @($userPath -split ";" | Where-Object {
            -not [string]::IsNullOrWhiteSpace($_) -and
            $_.Trim().TrimEnd("\") -ine $normalizedShim
        })
        [Environment]::SetEnvironmentVariable("Path", ($segments -join ";"), "User")
    }
    if ($hasMarker) {
        Remove-Item -LiteralPath $PathMarker -Force
    }
    if ((Test-Path -LiteralPath $ShimDirectory -PathType Container) -and
        @(Get-ChildItem -LiteralPath $ShimDirectory -Force).Count -eq 0) {
        Remove-Item -LiteralPath $ShimDirectory -Force
    }
}

function Test-InstalledRuntime {
    $launcher = Get-LauncherPath -Prefix $InstallPrefix
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw "Runtime is not installed at $InstallPrefix."
    }
    Invoke-Launcher -Launcher $launcher -Arguments @("help") -Quiet
    $version = (& $launcher --version 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0) {
        $version = "opencodex-universal"
    }
    Write-Host "OK: $version ($launcher, Node $script:NodeVersion, Windows/$script:NodeArchitecture)" -ForegroundColor Green
}

if ($Action -in @("Uninstall", "Purge")) {
    $launcher = Get-LauncherPath -Prefix $InstallPrefix
    if (Test-Path -LiteralPath $launcher -PathType Leaf) {
        if ($Action -eq "Purge") {
            Invoke-Launcher -Launcher $launcher -Arguments @("uninstall")
        } else {
            try {
                Invoke-Launcher -Launcher $launcher -Arguments @("stop") -Quiet
            } catch {
                Write-Warning "Runtime stop was best-effort: $($_.Exception.Message)"
            }
        }
    }
    Remove-ManagedShims
    Remove-ShimDirectoryFromUserPath
    if (Test-Path -LiteralPath $InstallPrefix) {
        Remove-Item -LiteralPath $InstallPrefix -Recurse -Force
    }
    if ($Action -eq "Purge") {
        Write-Host "Removed runtime and local opencodex state." -ForegroundColor Green
    } else {
        Write-Host "Removed runtime; ~/.opencodex was preserved." -ForegroundColor Green
    }
    exit 0
}

$Node = Get-ExternalApplication -Names @("node.exe", "node") -Purpose "Node.js 18+"
$Npm = Get-ExternalApplication -Names @("npm.cmd", "npm") -Purpose "npm"

$script:NodeVersion = (& $Node -p "process.versions.node").Trim()
if ($LASTEXITCODE -ne 0) {
    throw "Could not query the Node.js version from $Node."
}
$nodeMajor = [int]($script:NodeVersion.Split(".")[0])
if ($nodeMajor -lt 18) {
    throw "Node.js 18+ is required. Current version: v$script:NodeVersion"
}

$script:NodeArchitecture = (& $Node -p "process.arch").Trim()
if ($LASTEXITCODE -ne 0 -or $script:NodeArchitecture -notin @("x64", "arm64")) {
    throw "Use an x64 or arm64 Node.js build. Detected: $script:NodeArchitecture"
}

if ($Action -eq "Check") {
    Test-InstalledRuntime
    exit 0
}

Write-Host "Installing $PackageSpec for Windows/$script:NodeArchitecture with Node v$script:NodeVersion..." -ForegroundColor Cyan

$prefixParent = Split-Path -Parent $InstallPrefix
if (-not (Test-Path -LiteralPath $prefixParent)) {
    New-Item -ItemType Directory -Path $prefixParent -Force | Out-Null
}
$stagingPrefix = "$InstallPrefix.next.$PID"
$rollbackPrefix = "$InstallPrefix.rollback.$PID"
if ((Test-Path -LiteralPath $stagingPrefix) -or (Test-Path -LiteralPath $rollbackPrefix)) {
    throw "A stale installer transaction exists. Check that no installer is running, then remove '$stagingPrefix' / '$rollbackPrefix'."
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ocxu-install-$PID-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
$script:swapped = $false
$script:serviceWasInstalled = $false
$script:serviceBackend = ""
$script:proxyWasRunning = $false

function Restore-PreviousInstall {
    if (-not $script:swapped) {
        return
    }
    $newLauncher = Get-LauncherPath -Prefix $InstallPrefix
    if (Test-Path -LiteralPath $newLauncher -PathType Leaf) {
        try {
            Invoke-Launcher -Launcher $newLauncher -Arguments @("stop") -Quiet
        } catch {
            Write-Warning "New runtime could not be stopped before rollback: $($_.Exception.Message)"
        }
    }
    Remove-ManagedShims
    $failedPrefix = "$InstallPrefix.failed.$PID"
    if (Test-Path -LiteralPath $InstallPrefix) {
        Move-Item -LiteralPath $InstallPrefix -Destination $failedPrefix -Force
    }
    if (Test-Path -LiteralPath $rollbackPrefix) {
        Move-Item -LiteralPath $rollbackPrefix -Destination $InstallPrefix -Force
    }
    if (Test-Path -LiteralPath $failedPrefix) {
        Remove-Item -LiteralPath $failedPrefix -Recurse -Force
    }
    $oldLauncher = Get-LauncherPath -Prefix $InstallPrefix
    if (Test-Path -LiteralPath $oldLauncher -PathType Leaf) {
        Install-CommandShims
        if ($script:serviceWasInstalled) {
            try {
                if ($script:serviceBackend -eq "native") {
                    Invoke-Launcher -Launcher $oldLauncher -Arguments @("service", "install", "--native")
                } else {
                    Invoke-Launcher -Launcher $oldLauncher -Arguments @("service", "install")
                }
            } catch {
                Write-Warning "Previous service could not be restarted automatically: $($_.Exception.Message)"
            }
        } elseif ($script:proxyWasRunning) {
            try {
                Invoke-Launcher -Launcher $oldLauncher -Arguments @("ensure")
            } catch {
                Write-Warning "Previous proxy could not be restarted automatically: $($_.Exception.Message)"
            }
        }
    }
}

try {
    $installSource = $PackageSpec
    $isHttps = $PackageSpec.StartsWith("https://", [System.StringComparison]::OrdinalIgnoreCase)
    $isHttp = $PackageSpec.StartsWith("http://", [System.StringComparison]::OrdinalIgnoreCase)
    $isLocal = Test-Path -LiteralPath $PackageSpec -PathType Leaf

    if ($isHttp -and -not $isHttps) {
        throw "Plain HTTP package URLs are not allowed."
    }
    if ($isHttps) {
        if ([string]::IsNullOrWhiteSpace($ExpectedSha256)) {
            throw "ExpectedSha256 / OPENCODEX_PACKAGE_SHA256 is required for an HTTPS release artifact."
        }
        $installSource = Join-Path $temporaryRoot "package.tgz"
        $previousProtocol = [Net.ServicePointManager]::SecurityProtocol
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -UseBasicParsing -Uri $PackageSpec -OutFile $installSource
        } finally {
            [Net.ServicePointManager]::SecurityProtocol = $previousProtocol
        }
    } elseif ($isLocal) {
        if ([string]::IsNullOrWhiteSpace($ExpectedSha256)) {
            throw "ExpectedSha256 / OPENCODEX_PACKAGE_SHA256 is required for a local release artifact."
        }
        $installSource = [System.IO.Path]::GetFullPath($PackageSpec)
    } elseif (-not [string]::IsNullOrWhiteSpace($ExpectedSha256)) {
        throw "SHA-256 pinning is supported only for local or HTTPS .tgz artifacts."
    }

    if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256)) {
        $actualSha256 = (Get-FileHash -LiteralPath $installSource -Algorithm SHA256).Hash.ToLowerInvariant()
        $expectedNormalized = $ExpectedSha256.Trim().ToLowerInvariant()
        if ($actualSha256 -ne $expectedNormalized) {
            throw "SHA-256 mismatch (expected $expectedNormalized, got $actualSha256)."
        }
        Write-Host "SHA-256 verified: $actualSha256" -ForegroundColor Green
    }

    $serviceStatePath = Join-Path $StateDirectory "service-state.json"
    if (Test-Path -LiteralPath $serviceStatePath -PathType Leaf) {
        $script:serviceWasInstalled = $true
        try {
            $serviceState = Get-Content -LiteralPath $serviceStatePath -Raw | ConvertFrom-Json
            if ($serviceState.backend -eq "native") {
                $script:serviceBackend = "native"
            }
        } catch {
            $script:serviceBackend = ""
        }
    }

    $oldLauncher = Get-LauncherPath -Prefix $InstallPrefix
    if (Test-Path -LiteralPath $oldLauncher -PathType Leaf) {
        try {
            $statusText = (& $oldLauncher status --json 2>$null | Out-String)
            if ($LASTEXITCODE -eq 0) {
                $status = $statusText | ConvertFrom-Json
                $script:proxyWasRunning = $status.proxy.running -eq $true
            }
        } catch {
            $script:proxyWasRunning = $false
        }
    }

    & $Npm install -g --prefix $stagingPrefix --no-audit --fund=false $installSource
    if ($LASTEXITCODE -ne 0) {
        throw "npm installation into staging failed with exit code $LASTEXITCODE; active runtime was not changed."
    }
    $stagedLauncher = Get-LauncherPath -Prefix $stagingPrefix
    if (-not (Test-Path -LiteralPath $stagedLauncher -PathType Leaf)) {
        throw "Staged package did not provide the ocxu.cmd launcher."
    }
    Invoke-Launcher -Launcher $stagedLauncher -Arguments @("help") -Quiet

    if (Test-Path -LiteralPath $oldLauncher -PathType Leaf) {
        Invoke-Launcher -Launcher $oldLauncher -Arguments @("stop") -Quiet
        Start-Sleep -Milliseconds 250
    }

    if (Test-Path -LiteralPath $InstallPrefix) {
        Move-Item -LiteralPath $InstallPrefix -Destination $rollbackPrefix
    }
    Move-Item -LiteralPath $stagingPrefix -Destination $InstallPrefix
    $script:swapped = $true

    $finalLauncher = Get-LauncherPath -Prefix $InstallPrefix
    Invoke-Launcher -Launcher $finalLauncher -Arguments @("help") -Quiet
    Install-CommandShims

    if ($script:serviceWasInstalled) {
        if ($script:serviceBackend -eq "native") {
            Invoke-Launcher -Launcher $finalLauncher -Arguments @("service", "install", "--native")
        } else {
            Invoke-Launcher -Launcher $finalLauncher -Arguments @("service", "install")
        }
        Write-Host "Refreshed the existing background service." -ForegroundColor Green
    } elseif ($script:proxyWasRunning) {
        Invoke-Launcher -Launcher $finalLauncher -Arguments @("ensure")
        Write-Host "Restarted the proxy that was running before the upgrade." -ForegroundColor Green
    }

    Test-InstalledRuntime
    if (Test-Path -LiteralPath $rollbackPrefix) {
        Remove-Item -LiteralPath $rollbackPrefix -Recurse -Force
    }
    $script:swapped = $false
    Write-Host "Installed successfully. Open a new PowerShell, then run: ocxu init" -ForegroundColor Green
} catch {
    if ($script:swapped) {
        try {
            Restore-PreviousInstall
            Write-Warning "The new runtime failed validation; the previous runtime was restored."
        } catch {
            Write-Warning "Automatic rollback also failed: $($_.Exception.Message)"
        }
    }
    throw
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $stagingPrefix) {
        Remove-Item -LiteralPath $stagingPrefix -Recurse -Force -ErrorAction SilentlyContinue
    }
}
