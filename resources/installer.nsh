; Never kill a browser to update it. Other profiles/copies may still be saving.
; This hook runs before uninstallOldVersion or extraction touches the installation.
!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !ifdef INSTALL_REGISTRY_KEY
      ${If} ${Silent}
        ; Upstream uninstallOldVersion uses registry paths, even with an explicit
        ; /D target. Never silently uninstall a different registered Vast copy.
        ReadRegStr $R2 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
        ${If} $R2 != ""
        ${AndIf} $R2 != $INSTDIR
          SetErrorLevel 2
          Quit
        ${EndIf}
        ReadRegStr $R2 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
        ${If} $R2 != ""
        ${AndIf} $R2 != $INSTDIR
          SetErrorLevel 2
          Quit
        ${EndIf}
      ${EndIf}
    !endif
  !endif
  StrCpy $R1 0
  vast_wait_for_browser:
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 603
      Goto vast_browser_closed
    ${EndIf}
    ${If} $R0 != 0
      ; Unknown process-query result: fail closed, never assume the app is gone.
      SetErrorLevel 2
      Quit
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 < 30
      Sleep 1000
      Goto vast_wait_for_browser
    ${EndIf}
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONINFORMATION "Close all Vast windows, then run the installer again. No files have been changed."
    ${EndIf}
    SetErrorLevel 2
    Quit
  vast_browser_closed:
!macroend

; Canonical registration hooks used by package.json build.nsis.include.
!macro customInstall
  ; Register Vast as an available PDF viewer without taking over the user's
  ; current PDF default. OpenWithProgids is additive and UserChoice is never
  ; written by the installer.
  WriteRegNone HKCU "Software\Classes\.pdf\OpenWithProgids" "VastPDF"
  WriteRegStr HKCU "Software\Classes\VastPDF" "" "PDF Document"
  WriteRegStr HKCU "Software\Classes\VastPDF\DefaultIcon" "" "$appExe,0"
  WriteRegStr HKCU "Software\Classes\VastPDF\shell\open\command" "" '$\"$appExe$\" $\"%1$\"'
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".pdf" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend

!macro customUnInstall
  ; Created by src/main/default-browser.ts when the user opens Vast's
  ; "Make default" flow. These keys advertise Vast to Windows Default Apps.
  DeleteRegValue HKCU "Software\RegisteredApplications" "Vast"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Vast"
  DeleteRegKey HKCU "Software\Classes\VastHTML"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "VastPDF"
  DeleteRegKey HKCU "Software\Classes\VastPDF"
  DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend
