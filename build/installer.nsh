; Vast NSIS customizations used by electron-builder.
; electron-builder automatically includes build/installer.nsh when present.
;
; Keep this cleanup narrowly scoped to registry state owned by Vast. Do not
; remove generic HTTP/HTTPS class keys or Windows UserChoice state.

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
