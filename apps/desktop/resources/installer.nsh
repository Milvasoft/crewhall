; Removes what the app adds to Windows Explorer (main/send-to.ts) when it is uninstalled.
; An update runs the old uninstaller too: those keep the entries, the app rewrites them at start.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; The virtual drive's folder and its entry in Explorer's navigation pane, while the app is here.
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --remove-virtual-drive'
    DeleteRegKey HKCU "Software\Classes\*\shell\CrewhallUpload"
    DeleteRegKey HKCU "Software\Classes\Directory\shell\CrewhallUpload"
    ; Installed for all users, $APPDATA means ProgramData here, and the shortcut is this person's.
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endIf}
    Delete "$APPDATA\Microsoft\Windows\SendTo\Crewhall.lnk"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endIf}
  ${endIf}
!macroend
