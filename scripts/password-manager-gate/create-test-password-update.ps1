[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('bitwarden', 'proton', 'icloud')]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$ExistingCredentialHashFile
)

$ErrorActionPreference = 'Stop'
if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
  throw 'Run this interactive credential window with powershell -STA.'
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ExistingPath = [IO.Path]::GetFullPath($ExistingCredentialHashFile)
$Existing = Get-Content -LiteralPath $ExistingPath -Raw | ConvertFrom-Json
if ($Existing.usernameSha256 -notmatch '^[a-f0-9]{64}$' -or $Existing.passwordSha256 -notmatch '^[a-f0-9]{64}$') {
  throw 'Existing controlled credential hash file is malformed.'
}

function Get-Sha256Hex([string]$Value) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

$passwordBytes = New-Object byte[] 24
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($passwordBytes) } finally { $generator.Dispose() }
$script:passwordValue = ([Convert]::ToBase64String($passwordBytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
[Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
$script:candidatePath = $null
$script:copiedValue = $false
$OutputRoot = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))) '.vast-build\password-manager-gates\credential-hashes'

$form = New-Object System.Windows.Forms.Form
$form.Text = "Vast gate - update $Mode test password"
$form.Size = New-Object System.Drawing.Size(620, 285)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$instruction = New-Object System.Windows.Forms.Label
$instruction.Location = New-Object System.Drawing.Point(18, 16)
$instruction.Size = New-Object System.Drawing.Size(570, 55)
$instruction.Text = 'Keep the existing test username unchanged. Replace only its password with this value, submit the form, and accept the password-manager update prompt.'
$form.Controls.Add($instruction)

$passwordLabel = New-Object System.Windows.Forms.Label
$passwordLabel.Location = New-Object System.Drawing.Point(18, 88)
$passwordLabel.Size = New-Object System.Drawing.Size(95, 20)
$passwordLabel.Text = 'New password'
$form.Controls.Add($passwordLabel)

$passwordBox = New-Object System.Windows.Forms.TextBox
$passwordBox.Location = New-Object System.Drawing.Point(120, 84)
$passwordBox.Size = New-Object System.Drawing.Size(370, 24)
$passwordBox.ReadOnly = $true
$passwordBox.UseSystemPasswordChar = $true
$passwordBox.Text = $script:passwordValue
$form.Controls.Add($passwordBox)

$copyButton = New-Object System.Windows.Forms.Button
$copyButton.Location = New-Object System.Drawing.Point(500, 83)
$copyButton.Size = New-Object System.Drawing.Size(85, 27)
$copyButton.Text = 'Copy'
$copyButton.Add_Click({
  [System.Windows.Forms.Clipboard]::SetText($script:passwordValue)
  $script:copiedValue = $true
})
$form.Controls.Add($copyButton)

$script:confirmedBox = New-Object System.Windows.Forms.CheckBox
$script:confirmedBox.Location = New-Object System.Drawing.Point(18, 140)
$script:confirmedBox.Size = New-Object System.Drawing.Size(560, 25)
$script:confirmedBox.Text = "I accepted the $Mode update prompt for the existing isolated test item"
$form.Controls.Add($script:confirmedBox)

$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Location = New-Object System.Drawing.Point(353, 185)
$saveButton.Size = New-Object System.Drawing.Size(140, 28)
$saveButton.Text = 'Save hash candidate'
$saveButton.Enabled = $false
$script:confirmedBox.Add_CheckedChanged({ $saveButton.Enabled = $script:confirmedBox.Checked })
$saveButton.Add_Click({
  try {
    [IO.Directory]::CreateDirectory($OutputRoot) | Out-Null
    $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
    $script:candidatePath = Join-Path $OutputRoot "$Mode-update-candidate-$stamp-$suffix.json"
    $record = [ordered]@{
      schemaVersion = 1
      capturedAt = [DateTime]::UtcNow.ToString('o')
      usernameSha256 = $Existing.usernameSha256
      passwordSha256 = Get-Sha256Hex $script:passwordValue
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress) + "`n")
    $stream = [IO.File]::Open($script:candidatePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length) } finally {
      $stream.Dispose()
      [Array]::Clear($bytes, 0, $bytes.Length)
    }
    $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Close()
  } catch {
    $script:candidatePath = $null
    [System.Windows.Forms.MessageBox]::Show('Could not save the update hash candidate. No credential value was logged.', 'Vast gate') | Out-Null
  }
})
$form.Controls.Add($saveButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Location = New-Object System.Drawing.Point(500, 185)
$cancelButton.Size = New-Object System.Drawing.Size(85, 28)
$cancelButton.Text = 'Cancel'
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancelButton)
$form.CancelButton = $cancelButton

try {
  $dialogResult = $form.ShowDialog()
  if ($dialogResult -ne [System.Windows.Forms.DialogResult]::OK -or -not $script:candidatePath) {
    throw 'Credential update candidate capture was cancelled.'
  }
  Write-Output $script:candidatePath
} finally {
  if ($script:copiedValue) {
    try {
      if ([System.Windows.Forms.Clipboard]::ContainsText() -and
          [System.Windows.Forms.Clipboard]::GetText() -eq $script:passwordValue) {
        [System.Windows.Forms.Clipboard]::Clear()
      }
    } catch {}
  }
  $script:passwordValue = $null
  $form.Dispose()
}
