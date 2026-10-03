# DSH orphan blank-session cleanup.
#
# Removes never-used blank sessions (never received a first prompt) from the
# workspace registry, the projection cache, and their session folders.
# Blankness is read from the projection cache, NOT from the session log:
# in this build session.v4.jsonl.zstd holds only a header even for real
# conversations, so log length is not a valid blankness signal.
#
# Preview mode is the default; nothing is written without -Apply.
#
# Usage (in a terminal, after fully quitting DeepSeek Harness):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-cleanup-blank-sessions.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-cleanup-blank-sessions.ps1 -Apply

[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$Force,   # skip the running-app check (preview only; never combine with -Apply)
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh')
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$storePath = Join-Path $DshHome 'storages\workspace.json'
$projDir   = Join-Path $DshHome 'storages\session_projcache\sessions'
$sessRoot  = Join-Path $DshHome 'sessions'
$backupDir = Join-Path $DshHome ('cleanup-backup-' + $stamp)

if (-not (Test-Path -LiteralPath $storePath)) { throw "not found: $storePath" }

# ---------- 1. safety: the app must be stopped ----------
$running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    if ($Force -and -not $Apply) {
        Write-Warning ('app is running (PID: ' + (($running | ForEach-Object { $_.Id }) -join ', ') + '); -Force preview only, nothing will be written')
    } else {
        Write-Host ''
        Write-Host ('!! DeepSeek Harness is still running (PID: ' + (($running | ForEach-Object { $_.Id }) -join ', ') + ')')
        Write-Host '   Quit it completely (including the tray icon), then run this script again.'
        exit 2
    }
}

Write-Host ("DSH_HOME : " + $DshHome)
Write-Host ("Mode     : " + $(if ($Apply) { 'APPLY (writes changes)' } else { 'PREVIEW (no changes)' }))
Write-Host ''

# ---------- 2. classify blankness from the projection cache ----------
# blank  <=> sessionListMetadata.blank is true
#        AND no stored title
#        AND titleInput.count == 0 (no first prompt ever submitted)
$blankIds = New-Object System.Collections.Generic.HashSet[string]
$allIds   = New-Object System.Collections.Generic.HashSet[string]

foreach ($f in Get-ChildItem -LiteralPath $projDir -Filter '*.json' -File -ErrorAction SilentlyContinue) {
    try { $rec = (Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json).record } catch { continue }
    if ($null -eq $rec.rows) { continue }
    $id = $null
    if ($rec.identity -and $rec.identity.sessionId) { $id = [string]$rec.identity.sessionId }
    if (-not $id) { $id = [System.IO.Path]::GetFileNameWithoutExtension($f.Name) }
    [void]$allIds.Add($id)

    $blank       = $rec.rows.sessionListMetadata.val.blank
    $title       = $rec.rows.title.val
    $inputCount  = 0
    if ($rec.rows.titleInput.val -and $null -ne $rec.rows.titleInput.val.count) { $inputCount = [int]$rec.rows.titleInput.val.count }

    if ($blank -eq $true -and (-not $title) -and $inputCount -eq 0) { [void]$blankIds.Add($id) }
}

Write-Host ("Sessions with a projection record : " + $allIds.Count)
Write-Host ("Classified as unused blank        : " + $blankIds.Count)

# ---------- 3. targets = blank sessions listed in the workspace registry ----------
$json = (Get-Content -LiteralPath $storePath -Raw -Encoding UTF8) | ConvertFrom-Json

$targets = @()
foreach ($wsProp in $json.tables.workspaces.PSObject.Properties) {
    foreach ($id in @($wsProp.Value.sessionIds)) {
        if ($blankIds.Contains($id)) {
            $targets += [pscustomobject]@{
                Workspace   = $wsProp.Value.title
                WorkspaceId = $wsProp.Name
                SessionId   = $id
            }
        }
    }
}

# blank sessions on disk that the registry does not list (orphans in folders only)
$extraFolders = @()
foreach ($wsDir in Get-ChildItem -LiteralPath $sessRoot -Directory -ErrorAction SilentlyContinue) {
    foreach ($d in Get-ChildItem -LiteralPath $wsDir.FullName -Directory -ErrorAction SilentlyContinue) {
        if ($blankIds.Contains($d.Name)) {
            $listed = $false
            foreach ($wsProp in $json.tables.workspaces.PSObject.Properties) {
                if (@($wsProp.Value.sessionIds) -contains $d.Name) { $listed = $true; break }
            }
            if (-not $listed) { $extraFolders += $d.FullName }
        }
    }
}

if ($targets.Count -eq 0 -and $extraFolders.Count -eq 0) { Write-Host 'Nothing to clean up.'; exit 0 }

Write-Host ''
Write-Host ('Registry entries to remove: ' + $targets.Count)
if ($targets.Count -gt 0) { $targets | Format-Table -AutoSize }
if ($extraFolders.Count -gt 0) {
    Write-Host ('Blank session folders not in the registry (folders only): ' + $extraFolders.Count)
    $extraFolders | ForEach-Object { Write-Host ('  ' + $_) }
}

if (-not $Apply) {
    Write-Host ''
    Write-Host 'Preview only. Re-run with -Apply to perform the cleanup.'
    exit 0
}

# ---------- 4. apply ----------
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item -LiteralPath $storePath -Destination (Join-Path $backupDir 'workspace.json') -Force
Copy-Item -LiteralPath $projDir -Destination (Join-Path $backupDir 'session_projcache') -Recurse -Force

# 4a. registry
foreach ($wsProp in $json.tables.workspaces.PSObject.Properties) {
    $wsProp.Value.sessionIds = @($wsProp.Value.sessionIds | Where-Object { -not $blankIds.Contains($_) })
}
$json.global.pinnedSessionIds   = @($json.global.pinnedSessionIds   | Where-Object { -not $blankIds.Contains($_) })
$json.global.archivedSessionIds = @($json.global.archivedSessionIds | Where-Object { -not $blankIds.Contains($_) })

$newJson = $json | ConvertTo-Json -Depth 32
[System.IO.File]::WriteAllText($storePath, $newJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("Updated registry: " + $storePath)

# 4b. projection cache
foreach ($id in $blankIds) {
    $p = Join-Path $projDir ($id + '.json')
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
}

# 4c. session folders
$removed = 0
$failed = @()
$victims = @()
foreach ($t in $targets) {
    foreach ($wsDir in Get-ChildItem -LiteralPath $sessRoot -Directory -ErrorAction SilentlyContinue) {
        $d = Join-Path $wsDir.FullName $t.SessionId
        if (Test-Path -LiteralPath $d) { $victims += $d }
    }
}
$victims += $extraFolders
foreach ($d in ($victims | Sort-Object -Unique)) {
    try { Remove-Item -LiteralPath $d -Recurse -Force; $removed++ }
    catch { $failed += ($d + '  (' + $_.Exception.Message + ')') }
}

Write-Host ''
Write-Host ("Done. Registry entries removed: " + $targets.Count + "; session folders deleted: " + $removed)
Write-Host ("Backup: " + $backupDir)
if ($failed.Count -gt 0) {
    Write-Host ''
    Write-Host 'These folders could not be deleted (still locked). Re-run after a restart:'
    $failed | ForEach-Object { Write-Host ('  ' + $_) }
}
