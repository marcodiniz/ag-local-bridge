# dev-deploy.ps1 — Deploy ag-local-bridge source to ALL local Antigravity extension directories
# Usage: pwsh scripts/dev-deploy.ps1
# After running, reload the Antigravity window (Ctrl+Shift+P → "Developer: Reload Window")

param(
    [switch]$SkipSyntaxCheck
)

$ErrorActionPreference = "Stop"

# Resolve repo root portably (no hardcoded paths):
#   1. If run as a script, $PSScriptRoot is .../scripts/ → parent is repo root
#   2. If run via 'npm run dev:deploy', $env:INIT_CWD is the npm project root
#   3. Fall back to the current working directory
$repo = $null
if ($PSScriptRoot -and (Test-Path (Join-Path (Split-Path -Parent $PSScriptRoot) "src\extension.js"))) {
    $repo = Split-Path -Parent $PSScriptRoot
} elseif ($env:INIT_CWD -and (Test-Path (Join-Path $env:INIT_CWD "src\extension.js"))) {
    $repo = $env:INIT_CWD
} elseif (Test-Path (Join-Path $PWD "src\extension.js")) {
    $repo = $PWD.Path
} else {
    Write-Error "Could not locate repo root. Run this script from the ag-local-bridge directory, or via 'npm run dev:deploy'."
    exit 1
}

$extBase = "$env:USERPROFILE\.antigravity\extensions"

# Find ALL installed extension directories (handles multiple versions)
$candidates = @()
$candidates += Get-ChildItem $extBase -Directory -Filter "*ag-local-bridge*" -ErrorAction SilentlyContinue
$candidates += Get-ChildItem $extBase -Directory -Filter "antigravity-bridge*" -ErrorAction SilentlyContinue
$candidates = $candidates | Select-Object -Unique

if ($candidates.Count -eq 0) {
    Write-Error "No ag-local-bridge extension found in $extBase"
    exit 1
}

Write-Host "=== AG Local Bridge Dev Deploy ===" -ForegroundColor Cyan
Write-Host "Source: $repo\src" -ForegroundColor Gray
Write-Host "Found $($candidates.Count) extension dir(s):" -ForegroundColor Gray
foreach ($c in $candidates) { Write-Host "  → $($c.FullName)" -ForegroundColor Gray }
Write-Host ""

# 1. Syntax check all JS files
if (-not $SkipSyntaxCheck) {
    Write-Host "[1/4] Syntax checking..." -ForegroundColor Yellow
    $jsFiles = Get-ChildItem "$repo\src" -Filter "*.js" -Recurse
    foreach ($f in $jsFiles) {
        $result = & node -c $f.FullName 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Syntax error in $($f.Name): $result"
            exit 1
        }
    }
    Write-Host "  ✅ All $($jsFiles.Count) files pass syntax check" -ForegroundColor Green
} else {
    Write-Host "[1/4] Skipping syntax check (-SkipSyntaxCheck)" -ForegroundColor DarkYellow
}

# Deploy to EACH extension directory
foreach ($extDir in $candidates) {
    $dest = $extDir.FullName
    Write-Host ""
    Write-Host "--- Deploying to: $dest ---" -ForegroundColor Cyan

    # 2. Backup old extension.js if it exists (only first time)
    $oldExt = "$dest\extension.js"
    if (Test-Path $oldExt) {
        Write-Host "[2/4] Backing up monolithic extension.js → extension.js.bak" -ForegroundColor Yellow
        Rename-Item $oldExt "extension.js.bak" -ErrorAction SilentlyContinue
        Write-Host "  ✅ Backed up" -ForegroundColor Green
    } else {
        Write-Host "[2/4] No monolithic extension.js to backup" -ForegroundColor DarkYellow
    }

    # 3. Copy src/ and package.json
    Write-Host "[3/4] Deploying src/ and package.json..." -ForegroundColor Yellow
    Remove-Item "$dest\src" -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item "$repo\src" -Destination "$dest\src" -Recurse -Force
    Copy-Item "$repo\package.json" -Destination "$dest\package.json" -Force

    $deployed = (Get-ChildItem "$dest\src" -File -Recurse).Count
    Write-Host "  ✅ Deployed $deployed files" -ForegroundColor Green

    # 4. Verify critical files
    Write-Host "[4/4] Verifying deployment..." -ForegroundColor Yellow
    $checks = @(
        @{ Path = "$dest\src\extension.js"; Label = "src/extension.js exists" },
        @{ Path = "$dest\src\sidecar\raw.js"; Label = "raw.js exists" },
        @{ Path = "$dest\src\sidecar\rpc.js"; Label = "rpc.js exists" },
        @{ Path = "$dest\src\handlers\chat.js"; Label = "chat.js exists" }
    )

    foreach ($check in $checks) {
        if (Test-Path $check.Path) {
            Write-Host "  ✅ $($check.Label)" -ForegroundColor Green
        } else {
            Write-Host "  ❌ MISSING: $($check.Label)" -ForegroundColor Red
        }
    }

    # Verify package.json main entry
    $pkgContent = Get-Content "$dest\package.json" -Raw
    if ($pkgContent -match '"main"\s*:\s*"\./src/extension\.js"') {
        Write-Host "  ✅ package.json main → ./src/extension.js" -ForegroundColor Green
    } else {
        Write-Host "  ❌ package.json main is NOT ./src/extension.js" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "🎉 Deploy complete! Reload Antigravity window to apply." -ForegroundColor Cyan
Write-Host "   Ctrl+Shift+P → 'Developer: Reload Window'" -ForegroundColor Gray
