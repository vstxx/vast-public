param(
  [string] $Executable,
  [int] $TimeoutSeconds = 120,
  [switch] $KeepProfile,
  [switch] $WorkspaceMenuFixture,
  [string] $ReportPath
)

. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $Executable) {
  $out = Join-Path (Get-VastChromiumSrc) (Get-VastChromiumOut)
  $vast = Join-Path $out 'Vast.exe'
  $Executable = if (Test-Path -LiteralPath $vast) { $vast } else { Join-Path $out 'chrome.exe' }
}
$Executable = [System.IO.Path]::GetFullPath($Executable)
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "Browser executable not found: $Executable"
}
if (-not $ReportPath) { $ReportPath = New-VastReportPath 'vast-toolbar-smoke' }

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$testRoot = Join-Path $tempRoot ("VastToolbarSmoke-" + [guid]::NewGuid().ToString('N'))
$profile = Join-Path $testRoot 'profile'
New-Item -ItemType Directory -Path $profile | Out-Null
$fixtureDataText = $null
if ($WorkspaceMenuFixture) {
  $fixtureConfig = Join-Path $testRoot 'fixture-config'
  $fixtureData = Join-Path $testRoot 'fixture-data'
  $transactionParent = Join-Path $testRoot 'transactions'
  New-Item -ItemType Directory -Path $fixtureConfig, $fixtureData, $transactionParent | Out-Null
  $fixtureDataText = @{
    schemaVersion = 5
    activeWorkspaceId = 'workspace-alpha'
    workspaces = @(
      @{ id = 'workspace-alpha'; name = 'Alpha'; icon = 'home'; color = '#123456'; order = 0; isPrivate = $false }
      @{ id = 'workspace-beta'; name = 'Beta'; icon = 'briefcase'; color = '#abcdef'; order = 1; isPrivate = $true }
    )
    tabGroups = @()
    tabs = @()
    bookmarks = @()
    bookmarkFolders = @()
    history = @()
    downloads = @()
    notes = @()
    readingList = @()
    quickLinks = @()
    settings = @{ theme = 'dark'; layoutMode = 'horizontal' }
  } | ConvertTo-Json -Depth 8 -Compress
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText(
    (Join-Path $fixtureData 'vast-data.json'), $fixtureDataText, $utf8NoBom
  )
  [System.IO.File]::WriteAllText(
    (Join-Path $fixtureConfig 'data-root.json'),
    (@{ customDataRoot = $fixtureData } | ConvertTo-Json -Compress),
    $utf8NoBom
  )
}
$process = $null
$workspaceMenuVerified = $false
$workspaceSelectionPersistedAfterRestart = $false
$nativeTabGroupsVerified = $false
$workspaceGroupRegistryVerified = $false
$nativeTabGroupsRestoredAfterRestart = $false
$registeredGroupTokensRetainedAfterRestart = $false
$lastActiveTabRestoredAfterRestart = $false

function Wait-VastMainBrowserProcess {
  param(
    [string] $ProfilePath,
    [string] $ExecutablePath,
    [datetime] $ProcessDeadline
  )
  while ((Get-Date) -lt $ProcessDeadline) {
    $candidate = Get-CimInstance Win32_Process | Where-Object {
      $_.Name -eq [System.IO.Path]::GetFileName($ExecutablePath) -and
      $_.ExecutablePath -eq $ExecutablePath -and
      $_.CommandLine -like "*--user-data-dir=$ProfilePath*" -and
      $_.CommandLine -notlike '*--type=*'
    } | Select-Object -First 1
    if ($candidate) {
      return Get-Process -Id $candidate.ProcessId -ErrorAction Stop
    }
    Start-Sleep -Milliseconds 200
  }
  throw 'Timed out waiting for the real Vast browser process.'
}

function Stop-VastDisposableProfileProcesses {
  param([string] $ProfilePath)
  $profileProcesses = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -like "*$ProfilePath*" -and
    $_.Name -in @('chrome.exe', 'Vast.exe')
  }
  $processIds = @($profileProcesses | Select-Object -ExpandProperty ProcessId)
  if ($processIds.Count) {
    Stop-Process -Id $processIds -Force -ErrorAction SilentlyContinue
  }
  $deadline = (Get-Date).AddSeconds(10)
  do {
    $remaining = @(Get-CimInstance Win32_Process | Where-Object {
      $_.CommandLine -like "*$ProfilePath*" -and
      $_.Name -in @('chrome.exe', 'Vast.exe')
    })
    if (-not $remaining.Count) { return }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  throw "Disposable Vast profile still owns processes: $ProfilePath"
}

try {
  $arguments = @(
    "--user-data-dir=$profile",
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check'
  )
  if ($WorkspaceMenuFixture) {
    $arguments += @(
      "--vast-migration-fixture=$fixtureConfig",
      "--vast-migration-transaction-parent=$transactionParent",
      '--vast-enable-migration-fixture-commit'
    )
  }
  $arguments += 'data:text/html,<title>Vast%20Toolbar%20Smoke</title><h1>Vast%20Toolbar%20Smoke</h1>'
  if ($WorkspaceMenuFixture) {
    $commitHarness = Join-Path (Get-VastPortRoot) 'tests\commit-vast-fixture.mjs'
    $prepareOutput = @(
      & node.exe $commitHarness `
        "--executable=$Executable" `
        "--profile=$profile" `
        "--fixture=$fixtureConfig" `
        "--transaction-parent=$transactionParent"
    )
    if ($LASTEXITCODE -ne 0) {
      throw "Vast fixture preparation exited with code $LASTEXITCODE."
    }
    $prepareResultLine = $prepareOutput |
      Where-Object { $_ -is [string] -and $_.TrimStart().StartsWith('{') } |
      Select-Object -Last 1
    if (-not $prepareResultLine) {
      throw 'Vast fixture preparation did not return JSON.'
    }
    $prepareResult = $prepareResultLine | ConvertFrom-Json
    if ($prepareResult.activeWorkspaceId -ne 'workspace-alpha') {
      throw "Fixture activated an unexpected workspace: $($prepareResult.activeWorkspaceId)"
    }
    Stop-VastDisposableProfileProcesses -ProfilePath $profile
    # The hidden commit helper only prepares product data. Its browser window
    # and native group registry are not part of the fixture under test.
    $preparationState = @(
      (Join-Path $profile 'Default\Sessions'),
      (Join-Path $profile 'Default\VastProductData\workspace-tab-groups.json')
    )
    $resolvedProfile = [System.IO.Path]::GetFullPath($profile).TrimEnd(
      [System.IO.Path]::DirectorySeparatorChar
    )
    foreach ($candidate in $preparationState) {
      $resolvedCandidate = [System.IO.Path]::GetFullPath($candidate)
      if (-not $resolvedCandidate.StartsWith(
          $resolvedProfile + [System.IO.Path]::DirectorySeparatorChar,
          [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clear preparation state outside the disposable profile: $resolvedCandidate"
      }
      Remove-Item -LiteralPath $resolvedCandidate -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  # This is intentionally a visible browser window: Windows UI Automation
  # verifies native Chromium Views rather than renderer-owned page content.
  $portFile = Join-Path $profile 'DevToolsActivePort'
  Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
  $launcherProcess = Start-Process -FilePath $Executable -ArgumentList $arguments -PassThru
  $process = $launcherProcess
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $portFile)) {
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-Path -LiteralPath $portFile)) {
    throw 'Timed out waiting for DevToolsActivePort.'
  }
  $port = [int](Get-Content -LiteralPath $portFile | Select-Object -First 1)
  $process = Wait-VastMainBrowserProcess `
    -ProfilePath $profile `
    -ExecutablePath $Executable `
    -ProcessDeadline $deadline
  if ($WorkspaceMenuFixture) {
    $encodedVastUrl = [System.Uri]::EscapeDataString('chrome://vast/')
    Invoke-RestMethod `
      -Method Put `
      -Uri "http://127.0.0.1:$port/json/new?$encodedVastUrl" `
      -TimeoutSec 10 | Out-Null
  }

  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class VastNativeInput {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(System.IntPtr window);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(System.IntPtr window, int command);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(
      System.IntPtr window, System.IntPtr insertAfter, int x, int y,
      int width, int height, uint flags);
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(
      uint flags, uint dx, uint dy, uint data, System.UIntPtr extraInfo);
}
'@
  function Wait-ProcessAutomationElement {
    param(
      [int] $BrowserProcessId,
      [System.Windows.Automation.ControlType] $ControlType,
      [string] $Name,
      [datetime] $ElementDeadline
    )
    $typeCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      $ControlType
    )
    $nameCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $Name
    )
    if ($ControlType -in @(
      [System.Windows.Automation.ControlType]::MenuItem,
      [System.Windows.Automation.ControlType]::RadioButton
    )) {
      # Native Views menus are hosted in a transient popup whose UIA process
      # identity is not stable across Windows versions.
      $conditions = New-Object System.Windows.Automation.AndCondition(
        $typeCondition, $nameCondition
      )
    } else {
      $processCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        $BrowserProcessId
      )
      $conditions = New-Object System.Windows.Automation.AndCondition(
        $processCondition, $typeCondition, $nameCondition
      )
    }
    while ((Get-Date) -lt $ElementDeadline) {
      $element = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $conditions
      )
      if ($element) { return $element }
      Start-Sleep -Milliseconds 200
    }
    throw "Timed out waiting for native element '$Name'."
  }

  function Invoke-AutomationElement {
    param([System.Windows.Automation.AutomationElement] $Element)
    $pattern = $Element.GetCurrentPattern(
      [System.Windows.Automation.InvokePattern]::Pattern
    )
    if (-not $pattern) {
      throw "Automation element '$($Element.Current.Name)' is not invokable."
    }
    $pattern.Invoke()
  }

  function Wait-ProcessSelectedAutomationElement {
    param(
      [int] $BrowserProcessId,
      [string] $Name,
      [datetime] $ElementDeadline,
      [System.Windows.Automation.AutomationElement] $SearchRoot
    )
    $processCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
      $BrowserProcessId
    )
    $lastSelected = @()
    while ((Get-Date) -lt $ElementDeadline) {
      try {
        $elements = if ($SearchRoot) {
          $SearchRoot.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
          )
        } else {
          [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $processCondition
          )
        }
      } catch {
        Start-Sleep -Milliseconds 200
        continue
      }
      $lastSelected = @()
      foreach ($element in @($elements)) {
        try {
          $selection = $element.GetCurrentPattern(
            [System.Windows.Automation.SelectionItemPattern]::Pattern
          )
          if ($selection -and $selection.Current.IsSelected) {
            $lastSelected += $element.Current.Name
            if ($element.Current.Name -eq $Name -or
                $element.Current.Name -like "$Name *Part of*group*") {
              return $element
            }
          }
        } catch {}
      }
      Start-Sleep -Milliseconds 200
    }
    throw "Timed out waiting for selected native element '$Name'. Selected: $($lastSelected -join '; ')."
  }

  function Wait-ProcessWindowByBounds {
    param(
      [int] $BrowserProcessId,
      [pscustomobject] $Bounds,
      [datetime] $ElementDeadline
    )
    $processCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
      $BrowserProcessId
    )
    $bestScore = [double]::PositiveInfinity
    while ((Get-Date) -lt $ElementDeadline) {
      try {
        $elements = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          $processCondition
        )
      } catch {
        Start-Sleep -Milliseconds 200
        continue
      }
      foreach ($element in @($elements)) {
        if ($element.Current.ControlType -ne
            [System.Windows.Automation.ControlType]::Window) {
          continue
        }
        $rectangle = $element.Current.BoundingRectangle
        $score = [Math]::Abs($rectangle.Left - $Bounds.left) +
          [Math]::Abs($rectangle.Top - $Bounds.top) +
          [Math]::Abs($rectangle.Width - $Bounds.width) +
          [Math]::Abs($rectangle.Height - $Bounds.height)
        if ($score -lt $bestScore) { $bestScore = $score }
        if ($score -le 80) { return $element }
      }
      Start-Sleep -Milliseconds 200
    }
    throw "Timed out waiting for the target browser window bounds; best score=$bestScore."
  }

  function Click-AutomationElement {
    param([System.Windows.Automation.AutomationElement] $Element)
    $bounds = $Element.Current.BoundingRectangle
    if ($bounds.IsEmpty) {
      throw "Automation element '$($Element.Current.Name)' has no screen bounds."
    }
    $x = [int]($bounds.Left + ($bounds.Width / 2))
    $y = [int]($bounds.Top + ($bounds.Height / 2))
    [VastNativeInput]::SetCursorPos($x, $y) | Out-Null
    [VastNativeInput]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
    [VastNativeInput]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
  }

  function Select-AutomationElement {
    param([System.Windows.Automation.AutomationElement] $Element)
    try {
      $selectionPattern = $Element.GetCurrentPattern(
        [System.Windows.Automation.SelectionItemPattern]::Pattern
      )
      if ($selectionPattern) {
        $selectionPattern.Select()
        return
      }
    } catch {}
    try {
      Invoke-AutomationElement $Element
      return
    } catch {}
    Click-AutomationElement $Element
  }

  function Select-VastWorkspaceFromNativeMenu {
    param(
      [int] $BrowserProcessId,
      [string] $ActiveButtonName,
      [string] $TargetItemName,
      [datetime] $ElementDeadline,
      [System.Windows.Automation.AutomationElement] $SearchRoot
    )
    $menuItem = $null
    while ((Get-Date) -lt $ElementDeadline -and -not $menuItem) {
      $processCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        $BrowserProcessId
      )
      try {
        $elements = if ($SearchRoot) {
          $SearchRoot.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
          )
        } else {
          [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $processCondition
          )
        }
      } catch {
        Start-Sleep -Milliseconds 200
        continue
      }
      $activeButtons = @($elements) | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
        $_.Current.Name -eq $ActiveButtonName
      }
      foreach ($activeButton in $activeButtons) {
        try {
          Invoke-AutomationElement $activeButton
          $menuDeadline = (Get-Date).AddSeconds(2)
          if ($menuDeadline -gt $ElementDeadline) { $menuDeadline = $ElementDeadline }
          $menuItem = Wait-ProcessAutomationElement `
            -BrowserProcessId $BrowserProcessId `
            -ControlType ([System.Windows.Automation.ControlType]::RadioButton) `
            -Name $TargetItemName `
            -ElementDeadline $menuDeadline
        } catch {}
        if ($menuItem) { break }
      }
      if (-not $menuItem) { Start-Sleep -Milliseconds 200 }
    }
    if (-not $menuItem) {
      throw "No native workspace chip '$ActiveButtonName' opened '$TargetItemName'."
    }
    Select-AutomationElement $menuItem
  }

  function Wait-VastNativeTabGroups {
    param(
      [int] $BrowserProcessId,
      [datetime] $ElementDeadline,
      [switch] $RequireAlphaGroup,
      [switch] $RequireAlphaMember,
      [switch] $RejectUnnamedGroup
    )
    $lastSummaries = @()
    while ((Get-Date) -lt $ElementDeadline) {
      $processCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        $BrowserProcessId
      )
      try {
        $elements = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          $processCondition
        )
      } catch {
        Start-Sleep -Milliseconds 200
        continue
      }
      $lastSummaries = @($elements) | Where-Object {
        $_.Current.Name -like '*Vast*' -or
        $_.Current.Name -like '*Alpha*' -or
        $_.Current.Name -like '*Beta*'
      } | ForEach-Object {
        "$($_.Current.ControlType.ProgrammaticName):$($_.Current.Name)"
      }
      $alphaGroups = @($lastSummaries | Where-Object {
        $_ -like 'ControlType.Tab:*group Vast*Alpha*'
      })
      $alphaGroup = $alphaGroups | Select-Object -First 1
      $alphaGroupWithMember = $alphaGroups | Where-Object {
        $_ -like '*and * other tab*'
      } | Select-Object -First 1
      $betaGroup = $lastSummaries | Where-Object {
        $_ -like 'ControlType.Tab:*group Vast*Beta*'
      } | Select-Object -First 1
      $crashed = $lastSummaries | Where-Object { $_ -like '*Crashed*' } |
        Select-Object -First 1
      $unnamedGroup = $lastSummaries | Where-Object {
        $_ -like 'ControlType.Tab:unnamed group*'
      } | Select-Object -First 1
      $alphaMemberVerified = -not $RequireAlphaMember -or
        $alphaGroupWithMember
      $alphaGroupVerified = -not $RequireAlphaGroup -or $alphaGroup
      $unnamedGroupVerified = -not $RejectUnnamedGroup -or -not $unnamedGroup
      if ($betaGroup -and -not $crashed -and $alphaGroupVerified -and
          $alphaMemberVerified -and $unnamedGroupVerified) {
        return [pscustomobject]@{
          alpha = if ($alphaGroupWithMember) { $alphaGroupWithMember } else { $alphaGroup }
          beta = $betaGroup
          summaries = $lastSummaries
        }
      }
      Start-Sleep -Milliseconds 200
    }
    throw "Native Vast tab groups were incomplete or crashed: $($lastSummaries -join '; ')"
  }

  $button = $null
  $expectedInitialButtonName = if ($WorkspaceMenuFixture) {
    'Vast workspace: Alpha'
  } else {
    'Open Vast workspace hub'
  }
  while ((Get-Date) -lt $deadline -and -not $button) {
    $process.Refresh()
    if ($process.HasExited) { throw "Browser exited early with code $($process.ExitCode)." }
    if ($process.MainWindowHandle -ne 0) {
      $window = [System.Windows.Automation.AutomationElement]::FromHandle(
        [IntPtr]$process.MainWindowHandle
      )
      if ($window) {
        $buttons = $window.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          [System.Windows.Automation.Condition]::TrueCondition
        )
        $button = @($buttons) | Where-Object {
          $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
          $_.Current.Name -eq $expectedInitialButtonName
        } | Select-Object -First 1
      }
    }
    if (-not $button) { Start-Sleep -Milliseconds 200 }
  }
  if (-not $button) {
    throw 'The native Vast workspace button was not exposed by Windows UI Automation.'
  }
  $initialAccessibleName = $button.Current.Name

  $invokePattern = $button.GetCurrentPattern(
    [System.Windows.Automation.InvokePattern]::Pattern
  )
  if (-not $invokePattern) { throw 'The native Vast workspace button is not invokable.' }
  if (-not $WorkspaceMenuFixture) {
    $invokePattern.Invoke()
  }

  $vastPage = $null
  while ((Get-Date) -lt $deadline -and -not $vastPage) {
    try {
      $pages = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 5
      $vastPage = $pages | Where-Object {
        $_.type -eq 'page' -and $_.url -eq 'chrome://vast/' -and $_.title -eq 'Vast'
      } | Select-Object -First 1
    } catch {
      $process.Refresh()
      if ($process.HasExited) { throw "Browser exited early with code $($process.ExitCode)." }
    }
    if (-not $vastPage) { Start-Sleep -Milliseconds 200 }
  }
  if (-not $vastPage) {
    throw 'Invoking the native Vast workspace button did not open chrome://vast/.'
  }

  if ($WorkspaceMenuFixture) {
    $betaMenuItem = $null
    while ((Get-Date) -lt $deadline -and -not $betaMenuItem) {
      $processCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        $process.Id
      )
      $buttons = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $processCondition
      )
      $activeButtons = @($buttons) | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
        $_.Current.Name -eq 'Vast workspace: Alpha'
      }
      foreach ($activeButton in $activeButtons) {
        try {
          Invoke-AutomationElement $activeButton
          $menuDeadline = (Get-Date).AddSeconds(2)
          if ($menuDeadline -gt $deadline) { $menuDeadline = $deadline }
          $betaMenuItem = Wait-ProcessAutomationElement `
            -BrowserProcessId $process.Id `
            -ControlType ([System.Windows.Automation.ControlType]::RadioButton) `
            -Name 'Beta (private)' `
            -ElementDeadline $menuDeadline
        } catch {}
        if ($betaMenuItem) { break }
      }
      if (-not $betaMenuItem) { Start-Sleep -Milliseconds 200 }
    }
    if (-not $betaMenuItem) {
      throw 'No native Alpha workspace chip opened the Beta radio menu.'
    }
    Select-AutomationElement $betaMenuItem

    $selectedButton = Wait-ProcessAutomationElement `
      -BrowserProcessId $process.Id `
      -ControlType ([System.Windows.Automation.ControlType]::Button) `
      -Name 'Private Vast workspace: Beta' `
      -ElementDeadline $deadline
    $nativeGroups = Wait-VastNativeTabGroups `
      -BrowserProcessId $process.Id `
      -ElementDeadline $deadline `
      -RequireAlphaGroup `
      -RequireAlphaMember `
      -RejectUnnamedGroup
    Write-Host "Verified native Vast tab groups: $($nativeGroups.alpha); $($nativeGroups.beta)"
    $nativeTabGroupsVerified = $true
    $sessionDirectory = Join-Path $profile 'Default\Sessions'
    $sessionStateBeforeMutation = @(
      Get-ChildItem -LiteralPath $sessionDirectory -File -ErrorAction SilentlyContinue |
        Sort-Object Name |
        ForEach-Object { "$($_.Name):$($_.Length):$($_.LastWriteTimeUtc.Ticks)" }
    ) -join ','

    $betaResumeTitle = 'Vast Beta Resume'
    $betaResumePath = Join-Path $testRoot 'vast-beta-resume.html'
    [System.IO.File]::WriteAllText(
      $betaResumePath,
      '<!doctype html><title>Vast Beta Resume</title><h1>Vast Beta Resume</h1>',
      $utf8NoBom
    )
    $betaResumeUrl = ([System.Uri]::new($betaResumePath)).AbsoluteUri
    $betaResumeTarget = Invoke-RestMethod `
      -Method Put `
      -Uri "http://127.0.0.1:$port/json/new?$([System.Uri]::EscapeDataString($betaResumeUrl))" `
      -TimeoutSec 10
    if (-not $betaResumeTarget.id) {
      throw 'Could not create the Beta resume-tab fixture.'
    }

    $betaOtherPath = Join-Path $testRoot 'vast-beta-other.html'
    [System.IO.File]::WriteAllText(
      $betaOtherPath,
      '<!doctype html><title>Vast Beta Other</title><h1>Vast Beta Other</h1>',
      $utf8NoBom
    )
    $betaOtherUrl = ([System.Uri]::new($betaOtherPath)).AbsoluteUri
    $betaOtherTarget = Invoke-RestMethod `
      -Method Put `
      -Uri "http://127.0.0.1:$port/json/new?$([System.Uri]::EscapeDataString($betaOtherUrl))" `
      -TimeoutSec 10
    if (-not $betaOtherTarget.id) {
      throw 'Could not create the second Beta tab fixture.'
    }

    Invoke-RestMethod `
      -Uri "http://127.0.0.1:$port/json/activate/$($betaResumeTarget.id)" `
      -TimeoutSec 10 | Out-Null
    $resumeReadyDeadline = (Get-Date).AddSeconds(15)
    $resumeReady = $false
    while ((Get-Date) -lt $resumeReadyDeadline -and -not $resumeReady) {
      $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 5
      $resumeReady = @($targets | Where-Object {
        $_.id -eq $betaResumeTarget.id -and $_.title -eq $betaResumeTitle
      }).Count -eq 1
      if (-not $resumeReady) { Start-Sleep -Milliseconds 200 }
    }
    if (-not $resumeReady) {
      throw 'The Beta resume-tab fixture did not finish loading.'
    }
    $selectedBetaResume = Wait-ProcessSelectedAutomationElement `
      -BrowserProcessId $process.Id `
      -Name $betaResumeTitle `
      -ElementDeadline $deadline

    $selectionPath = Join-Path $profile 'Default\VastProductData\workspace-selection.json'
    if (-not (Test-Path -LiteralPath $selectionPath -PathType Leaf)) {
      throw 'Native workspace menu did not persist its profile-local selection.'
    }
    $selection = Get-Content -LiteralPath $selectionPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($selection.workspaceId -ne 'workspace-beta') {
      throw "Native workspace menu selected an unexpected workspace: $($selection.workspaceId)"
    }

    Select-VastWorkspaceFromNativeMenu `
      -BrowserProcessId $process.Id `
      -ActiveButtonName 'Private Vast workspace: Beta' `
      -TargetItemName 'Alpha' `
      -ElementDeadline $deadline
    $selectedAlphaButton = Wait-ProcessAutomationElement `
      -BrowserProcessId $process.Id `
      -ControlType ([System.Windows.Automation.ControlType]::Button) `
      -Name 'Vast workspace: Alpha' `
      -ElementDeadline $deadline
    $alphaSelectionDeadline = (Get-Date).AddSeconds(15)
    do {
      $selection = Get-Content -LiteralPath $selectionPath -Raw -Encoding utf8 |
        ConvertFrom-Json
      if ($selection.workspaceId -eq 'workspace-alpha') { break }
      Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $alphaSelectionDeadline)
    if ($selection.workspaceId -ne 'workspace-alpha') {
      throw 'The pre-restart Alpha workspace selection was not persisted.'
    }
    if ((Get-Content -LiteralPath (Join-Path $fixtureData 'vast-data.json') -Raw -Encoding utf8) -ne $fixtureDataText) {
      throw 'Native workspace selection modified the source fixture.'
    }
    $registryPath = Join-Path $profile 'Default\VastProductData\workspace-tab-groups.json'
    $registryDeadline = (Get-Date).AddSeconds(15)
    $registry = $null
    while ((Get-Date) -lt $registryDeadline -and -not $registry) {
      try {
        $candidateRegistry = Get-Content -LiteralPath $registryPath -Raw -Encoding utf8 |
          ConvertFrom-Json
        $groups = @($candidateRegistry.groups)
        $workspaceIds = @($groups | Select-Object -ExpandProperty workspaceId)
        $tokens = @($groups | Select-Object -ExpandProperty groupToken)
        $validTokens = @($tokens | Where-Object {
          $_ -match '^[0-9A-F]{32}$' -and $_ -ne ('0' * 32)
        })
        $invalidActiveTabIndices = @($groups | Where-Object {
          $null -ne $_.lastActiveTabIndex -and
          ($_.lastActiveTabIndex -isnot [int] -or $_.lastActiveTabIndex -lt 0)
        })
        $betaResumeRegistrations = @($groups | Where-Object {
          $_.workspaceId -eq 'workspace-beta' -and
          $null -ne $_.lastActiveTabIndex -and $_.lastActiveTabIndex -gt 0
        })
        if ($candidateRegistry.formatVersion -eq 1 -and
            $candidateRegistry.journalPath -eq $selection.journalPath -and
            $workspaceIds -contains 'workspace-alpha' -and
            $workspaceIds -contains 'workspace-beta' -and
            $tokens.Count -eq $validTokens.Count -and
            @($tokens | Sort-Object -Unique).Count -eq $tokens.Count -and
            $invalidActiveTabIndices.Count -eq 0 -and
            $betaResumeRegistrations.Count -ge 1) {
          $registry = $candidateRegistry
        }
      } catch {}
      if (-not $registry) { Start-Sleep -Milliseconds 200 }
    }
    if (-not $registry) {
      throw 'Native workspace groups were not persisted in a valid journal-scoped registry.'
    }
    $stableRegistryDeadline = (Get-Date).AddSeconds(15)
    $stableRegistrySamples = 0
    $previousRegistryStateKey = $null
    while ((Get-Date) -lt $stableRegistryDeadline -and
           $stableRegistrySamples -lt 5) {
      $latestRegistry = Get-Content -LiteralPath $registryPath -Raw -Encoding utf8 |
        ConvertFrom-Json
      $latestStates = @(
        @($latestRegistry.groups) |
          ForEach-Object { "$($_.groupToken):$($_.lastActiveTabIndex)" } |
          Sort-Object
      )
      $latestStateKey = $latestStates -join ','
      if ($latestStateKey -eq $previousRegistryStateKey) {
        ++$stableRegistrySamples
      } else {
        $stableRegistrySamples = 1
        $previousRegistryStateKey = $latestStateKey
      }
      $registry = $latestRegistry
      if ($stableRegistrySamples -lt 5) { Start-Sleep -Milliseconds 200 }
    }
    if ($stableRegistrySamples -lt 5) {
      throw 'Workspace group registry did not reach a stable pre-restart state.'
    }
    $registryTokensBeforeRestart = @(
      @($registry.groups) | Select-Object -ExpandProperty groupToken | Sort-Object
    )
    $betaActiveTabIndicesBeforeRestart = @(
      @($registry.groups) |
        Where-Object {
          $_.workspaceId -eq 'workspace-beta' -and
          $null -ne $_.lastActiveTabIndex
        } |
        Select-Object -ExpandProperty lastActiveTabIndex -Unique
    )
    if ($betaActiveTabIndicesBeforeRestart.Count -ne 1) {
      throw 'Beta workspace registrations disagree about the last-active tab before restart.'
    }
    $betaActiveTabIndexBeforeRestart = $betaActiveTabIndicesBeforeRestart[0]
    $workspaceGroupRegistryVerified = $true
    $workspaceMenuVerified = $true

    $sessionFlushDeadline = (Get-Date).AddSeconds(30)
    $stableSessionSamples = 0
    $previousSessionState = $null
    while ((Get-Date) -lt $sessionFlushDeadline -and
           $stableSessionSamples -lt 15) {
      $sessionState = @(
        Get-ChildItem -LiteralPath $sessionDirectory -File -ErrorAction SilentlyContinue |
          Sort-Object Name |
          ForEach-Object { "$($_.Name):$($_.Length):$($_.LastWriteTimeUtc.Ticks)" }
      ) -join ','
      $sessionChanged = $sessionState -and
        $sessionState -ne $sessionStateBeforeMutation
      if ($sessionChanged -and $sessionState -eq $previousSessionState) {
        ++$stableSessionSamples
      } elseif ($sessionChanged) {
        $stableSessionSamples = 1
        $previousSessionState = $sessionState
      } else {
        $stableSessionSamples = 0
      }
      if ($stableSessionSamples -lt 15) { Start-Sleep -Milliseconds 200 }
    }
    if ($stableSessionSamples -lt 15) {
      throw 'Chromium session files did not flush after the workspace fixtures changed.'
    }

    Stop-VastDisposableProfileProcesses -ProfilePath $profile
    Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
    $restartArguments = @($arguments | Where-Object {
      $_ -notlike 'data:text/html,<title>Vast%20Toolbar%20Smoke*'
    })
    $launcherProcess = Start-Process `
      -FilePath $Executable `
      -ArgumentList $restartArguments `
      -PassThru
    $process = $launcherProcess
    $restartDeadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $restartDeadline -and -not (Test-Path -LiteralPath $portFile)) {
      Start-Sleep -Milliseconds 200
    }
    if (-not (Test-Path -LiteralPath $portFile)) {
      throw 'Timed out waiting for restarted DevToolsActivePort.'
    }
    $restartPort = [int](Get-Content -LiteralPath $portFile | Select-Object -First 1)
    $process = Wait-VastMainBrowserProcess `
      -ProfilePath $profile `
      -ExecutablePath $Executable `
      -ProcessDeadline $restartDeadline
    $restartedButton = Wait-ProcessAutomationElement `
      -BrowserProcessId $process.Id `
      -ControlType ([System.Windows.Automation.ControlType]::Button) `
      -Name 'Vast workspace: Alpha' `
      -ElementDeadline $restartDeadline
    $restoredGroups = Wait-VastNativeTabGroups `
      -BrowserProcessId $process.Id `
      -ElementDeadline $restartDeadline `
      -RequireAlphaGroup `
      -RejectUnnamedGroup
    Write-Host "Restored registered Vast tab groups: $($restoredGroups.alpha); $($restoredGroups.beta)"
    Start-Sleep -Milliseconds 500
    $registryAfterRestart = Get-Content -LiteralPath $registryPath -Raw -Encoding utf8 |
      ConvertFrom-Json
    $registryTokensAfterRestart = @(
      @($registryAfterRestart.groups) |
        Select-Object -ExpandProperty groupToken |
        Sort-Object
    )
    $missingRegisteredTokens = @($registryTokensBeforeRestart | Where-Object {
      $registryTokensAfterRestart -notcontains $_
    })
    if ($missingRegisteredTokens.Count) {
      throw "Registered workspace group tokens were lost during session restoration: $($missingRegisteredTokens -join ',')"
    }
    $betaRegistrationsAfterRestart = @($registryAfterRestart.groups | Where-Object {
      $_.workspaceId -eq 'workspace-beta'
    })
    $changedBetaRegistrations = @($betaRegistrationsAfterRestart | Where-Object {
      $null -eq $_.lastActiveTabIndex -or
      $_.lastActiveTabIndex -ne $betaActiveTabIndexBeforeRestart
    })
    if (-not $betaRegistrationsAfterRestart.Count -or
        $changedBetaRegistrations.Count) {
      throw 'Beta workspace did not preserve one consistent last-active position across token remapping.'
    }

    $restoredBetaTargetDeadline = (Get-Date).AddSeconds(15)
    $restoredBetaTarget = $null
    while ((Get-Date) -lt $restoredBetaTargetDeadline -and
           -not $restoredBetaTarget) {
      $targetsAfterRestart = Invoke-RestMethod `
        -Uri "http://127.0.0.1:$restartPort/json/list" `
        -TimeoutSec 5
      $restoredBetaTarget = @($targetsAfterRestart | Where-Object {
        $_.type -eq 'page' -and $_.title -eq $betaResumeTitle
      }) | Select-Object -First 1
      if (-not $restoredBetaTarget) { Start-Sleep -Milliseconds 200 }
    }
    if (-not $restoredBetaTarget) {
      throw 'The Beta resume-tab fixture was not restored by Chromium.'
    }
    $targetWindowHelper = Join-Path (Get-VastPortRoot) 'tests\get-target-window.mjs'
    $targetWindowOutput = @(
      & node.exe $targetWindowHelper `
        "--port=$restartPort" `
        "--target-id=$($restoredBetaTarget.id)"
    )
    if ($LASTEXITCODE -ne 0) {
      throw "Target-window helper exited with code $LASTEXITCODE."
    }
    $targetWindowResultLine = $targetWindowOutput |
      Where-Object { $_ -is [string] -and $_.TrimStart().StartsWith('{') } |
      Select-Object -Last 1
    if (-not $targetWindowResultLine) {
      throw 'Target-window helper did not return JSON.'
    }
    $targetWindowResult = $targetWindowResultLine | ConvertFrom-Json
    $resumeBrowserWindow = Wait-ProcessWindowByBounds `
      -BrowserProcessId $process.Id `
      -Bounds $targetWindowResult.bounds `
      -ElementDeadline $restartDeadline
    $selectedResumeDeadline = (Get-Date).AddSeconds(20)
    Select-VastWorkspaceFromNativeMenu `
      -BrowserProcessId $process.Id `
      -ActiveButtonName 'Vast workspace: Alpha' `
      -TargetItemName 'Beta (private)' `
      -ElementDeadline $restartDeadline `
      -SearchRoot $resumeBrowserWindow
    $restoredBetaResume = Wait-ProcessSelectedAutomationElement `
      -BrowserProcessId $process.Id `
      -Name $betaResumeTitle `
      -ElementDeadline $selectedResumeDeadline `
      -SearchRoot $resumeBrowserWindow
    $workspaceSelectionPersistedAfterRestart = $true
    $nativeTabGroupsRestoredAfterRestart = $true
    $registeredGroupTokensRetainedAfterRestart = $true
    $lastActiveTabRestoredAfterRestart = $true
  }

  $report = [ordered]@{
    schemaVersion = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    executable = $Executable
    nativeButtonFound = $true
    accessibleName = $initialAccessibleName
    invokePattern = $true
    navigatedToVast = $true
    targetUrl = $vastPage.url
    targetTitle = $vastPage.title
    workspaceMenuVerified = $workspaceMenuVerified
    workspaceSelectionPersistedAfterRestart = $workspaceSelectionPersistedAfterRestart
    nativeTabGroupsVerified = $nativeTabGroupsVerified
    workspaceGroupRegistryVerified = $workspaceGroupRegistryVerified
    nativeTabGroupsRestoredAfterRestart = $nativeTabGroupsRestoredAfterRestart
    registeredGroupTokensRetainedAfterRestart = $registeredGroupTokensRetainedAfterRestart
    lastActiveTabRestoredAfterRestart = $lastActiveTabRestoredAfterRestart
    emptyWorkspaceUrl = 'chrome://vast/'
    temporaryProfile = $true
  }
  $report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ReportPath -Encoding utf8
  Write-Host "PASS native Vast toolbar button; target=$($vastPage.url); report=$ReportPath"
} finally {
  if (Test-Path -LiteralPath $profile) {
    Stop-VastDisposableProfileProcesses -ProfilePath $profile
  }
  if (-not $KeepProfile) {
    $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
    if (-not $resolvedTestRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove a test root outside the temp directory: $resolvedTestRoot"
    }
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
