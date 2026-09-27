[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('bitwarden', 'proton', 'icloud')]
  [string]$Mode
)

$ErrorActionPreference = 'Stop'
if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
  throw 'Run this interactive credential window with powershell -STA.'
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function New-RandomBytes([int]$Count) {
  $bytes = New-Object byte[] $Count
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return ,$bytes
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

$usernameBytes = New-RandomBytes 8
$passwordBytes = New-RandomBytes 24
$script:usernameValue = 'vast-gate-' + ([BitConverter]::ToString($usernameBytes)).Replace('-', '').ToLowerInvariant() + '@example.test'
$script:passwordValue = ([Convert]::ToBase64String($passwordBytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
[Array]::Clear($usernameBytes, 0, $usernameBytes.Length)
[Array]::Clear($passwordBytes, 0, $passwordBytes.Length)

$script:candidatePath = $null
$script:copiedValue = $false
$script:credentialMode = $Mode
$script:outputRoot = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))) '.vast-build\password-manager-gates\credential-hashes'
[IO.Directory]::CreateDirectory($script:outputRoot) | Out-Null
$script:pendingSuffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$script:pendingStamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$script:pendingPath = Join-Path $script:outputRoot "$Mode-pending-$($script:pendingStamp)-$($script:pendingSuffix).json"
$pendingRecord = [ordered]@{
  schemaVersion = 1
  capturedAt = [DateTime]::UtcNow.ToString('o')
  usernameSha256 = Get-Sha256Hex $script:usernameValue
  passwordSha256 = Get-Sha256Hex $script:passwordValue
}
$pendingBytes = [Text.Encoding]::UTF8.GetBytes(($pendingRecord | ConvertTo-Json -Compress) + "`n")
$pendingStream = [IO.File]::Open($script:pendingPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $pendingStream.Write($pendingBytes, 0, $pendingBytes.Length) } finally {
  $pendingStream.Dispose()
  [Array]::Clear($pendingBytes, 0, $pendingBytes.Length)
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Vast gate - new $Mode test credential"
$form.Size = New-Object System.Drawing.Size(620, 330)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$instruction = New-Object System.Windows.Forms.Label
$instruction.Location = New-Object System.Drawing.Point(18, 16)
$instruction.Size = New-Object System.Drawing.Size(570, 56)
$instruction.Text = "Use only a dedicated test vault item. Set its URI to https://login.vast-test.local/ with Host matching; open the fixture with its current port. This window stores only SHA-256 hashes."
$form.Controls.Add($instruction)

$usernameLabel = New-Object System.Windows.Forms.Label
$usernameLabel.Location = New-Object System.Drawing.Point(18, 82)
$usernameLabel.Size = New-Object System.Drawing.Size(95, 20)
$usernameLabel.Text = 'Test username'
$form.Controls.Add($usernameLabel)

$usernameBox = New-Object System.Windows.Forms.TextBox
$usernameBox.Location = New-Object System.Drawing.Point(120, 78)
$usernameBox.Size = New-Object System.Drawing.Size(370, 24)
$usernameBox.ReadOnly = $true
$usernameBox.Text = $script:usernameValue
$form.Controls.Add($usernameBox)

$usernameCopy = New-Object System.Windows.Forms.Button
$usernameCopy.Location = New-Object System.Drawing.Point(500, 77)
$usernameCopy.Size = New-Object System.Drawing.Size(85, 27)
$usernameCopy.Text = 'Copy'
$usernameCopy.Add_Click({
  [System.Windows.Forms.Clipboard]::SetText($script:usernameValue)
  $script:copiedValue = $true
})
$form.Controls.Add($usernameCopy)

$passwordLabel = New-Object System.Windows.Forms.Label
$passwordLabel.Location = New-Object System.Drawing.Point(18, 123)
$passwordLabel.Size = New-Object System.Drawing.Size(95, 20)
$passwordLabel.Text = 'Test password'
$form.Controls.Add($passwordLabel)

$passwordBox = New-Object System.Windows.Forms.TextBox
$passwordBox.Location = New-Object System.Drawing.Point(120, 119)
$passwordBox.Size = New-Object System.Drawing.Size(370, 24)
$passwordBox.ReadOnly = $true
$passwordBox.UseSystemPasswordChar = $true
$passwordBox.Text = $script:passwordValue
$form.Controls.Add($passwordBox)

$passwordCopy = New-Object System.Windows.Forms.Button
$passwordCopy.Location = New-Object System.Drawing.Point(500, 118)
$passwordCopy.Size = New-Object System.Drawing.Size(85, 27)
$passwordCopy.Text = 'Copy'
$passwordCopy.Add_Click({
  [System.Windows.Forms.Clipboard]::SetText($script:passwordValue)
  $script:copiedValue = $true
})
$form.Controls.Add($passwordCopy)

$notice = New-Object System.Windows.Forms.Label
$notice.Location = New-Object System.Drawing.Point(18, 160)
$notice.Size = New-Object System.Drawing.Size(570, 40)
$notice.Text = 'Clipboard may retain a copied test value. Clear it after saving the test item. Closing this window before saving hashes discards the candidate.'
$form.Controls.Add($notice)

$script:confirmedBox = New-Object System.Windows.Forms.CheckBox
$script:confirmedBox.Location = New-Object System.Drawing.Point(18, 205)
$script:confirmedBox.Size = New-Object System.Drawing.Size(560, 25)
$script:confirmedBox.Text = "I saved these exact values in the isolated $Mode test vault item"
$form.Controls.Add($script:confirmedBox)

$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Location = New-Object System.Drawing.Point(353, 245)
$saveButton.Size = New-Object System.Drawing.Size(140, 28)
$saveButton.Text = 'Save hash candidate'
$saveButton.Enabled = $false
$script:confirmedBox.Add_CheckedChanged({ $saveButton.Enabled = $script:confirmedBox.Checked })
$saveButton.Add_Click({
  try {
    $script:candidatePath = Join-Path $script:outputRoot "$($script:credentialMode)-candidate-$($script:pendingStamp)-$($script:pendingSuffix).json"
    Move-Item -LiteralPath $script:pendingPath -Destination $script:candidatePath
    $script:pendingPath = $null
    $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Close()
  } catch {
    $script:candidatePath = $null
    [System.Windows.Forms.MessageBox]::Show('Could not save the hash candidate. No credential values were logged.', 'Vast gate') | Out-Null
  }
})
$form.Controls.Add($saveButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Location = New-Object System.Drawing.Point(500, 245)
$cancelButton.Size = New-Object System.Drawing.Size(85, 28)
$cancelButton.Text = 'Cancel'
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancelButton)
$form.CancelButton = $cancelButton

try {
  $dialogResult = $form.ShowDialog()
  if ($dialogResult -ne [System.Windows.Forms.DialogResult]::OK -or -not $script:candidatePath) {
    throw 'Credential candidate capture was cancelled.'
  }
  Write-Output $script:candidatePath
} finally {
  if ($script:pendingPath -and (Test-Path -LiteralPath $script:pendingPath)) {
    Remove-Item -LiteralPath $script:pendingPath -Force
  }
  if ($script:copiedValue) {
    try {
      if ([System.Windows.Forms.Clipboard]::ContainsText()) {
        $clipboardText = [System.Windows.Forms.Clipboard]::GetText()
        if ($clipboardText -eq $script:usernameValue -or $clipboardText -eq $script:passwordValue) {
          [System.Windows.Forms.Clipboard]::Clear()
        }
      }
    } catch {
      # Clipboard access can fail while another process owns it; no credential is logged.
    }
  }
  $script:usernameValue = $null
  $script:passwordValue = $null
  $form.Dispose()
}
