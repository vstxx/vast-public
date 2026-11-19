param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $OldEmail,
  [string] $NewEmail = '106024432+vstxx@users.noreply.github.com',
  [switch] $Execute
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if ($OldEmail -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$' -or $NewEmail -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
  throw 'Both email parameters must be valid email addresses.'
}
if ($OldEmail -eq $NewEmail) { throw 'Old and replacement email addresses must differ.' }

Push-Location $RepoRoot
try {
  $matching = @(git log --all --format='%H%x09%ae%x09%ce' | Select-String -SimpleMatch $OldEmail)
  Write-Host "Commits/refs containing old email: $($matching.Count)"
  Write-Host "Replacement: $NewEmail"

  if (-not $Execute) {
    Write-Host 'Dry run only. Re-run with -Execute after installing git-filter-repo and storing the backup safely.'
    return
  }

  $dirty = @(git status --porcelain)
  if ($dirty.Count -ne 0) { throw 'History rewrite requires a clean, fully committed worktree.' }
  if ($matching.Count -eq 0) { throw 'No matching commit metadata was found; no rewrite was performed.' }

  git filter-repo --version *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'git-filter-repo is required but unavailable.'
  }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupPath = Join-Path (Split-Path $RepoRoot -Parent) "vast-before-email-rewrite-$timestamp.bundle"
  git bundle create $backupPath --all
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
    throw 'Failed to create the pre-rewrite Git bundle.'
  }

  $oldHex = [BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes($OldEmail)).Replace('-', '')
  $newHex = [BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes($NewEmail)).Replace('-', '')
  $callback = @"
old_email = bytes.fromhex('$oldHex')
new_email = bytes.fromhex('$newHex')
if commit.author_email == old_email:
    commit.author_email = new_email
if commit.committer_email == old_email:
    commit.committer_email = new_email
"@
  git filter-repo --force --commit-callback $callback
  if ($LASTEXITCODE -ne 0) {
    throw 'git-filter-repo failed. Restore from the bundle before retrying.'
  }

  $remaining = @(git log --all --format='%H%x09%ae%x09%ce' | Select-String -SimpleMatch $OldEmail)
  if ($remaining.Count -ne 0) {
    throw "Rewrite verification failed: $($remaining.Count) matching entries remain."
  }

  git config user.email $NewEmail
  Write-Host "Backup bundle: $backupPath"
  Write-Host 'Verified: zero author/committer metadata entries contain the old email.'
  Write-Host 'No push was performed. Review docs/GIT_HISTORY_PRIVACY_REWRITE.md.'
} finally {
  Pop-Location
}
