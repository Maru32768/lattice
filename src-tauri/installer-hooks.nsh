!define LATTICE_INSTALLER_HOOK_DIR "${__FILEDIR__}"
!include "${LATTICE_INSTALLER_HOOK_DIR}\..\target\windows-runtime\runtime.nsh"
!include "WordFunc.nsh"
!include "LogicLib.nsh"

!macro LATTICE_CHECK_VC_RUNTIME READY_LABEL
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ReadRegStr $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Version"
  SetRegView lastused
  ${If} $0 == "1"
  ${AndIf} $1 != ""
    StrCpy $2 $1 1
    ${If} $2 == "v"
      StrCpy $1 $1 "" 1
    ${EndIf}
    ${VersionCompare} "$1" "${LATTICE_VC_RUNTIME_VERSION}" $2
    ${If} $2 == "0"
    ${OrIf} $2 == "1"
      Goto ${READY_LABEL}
    ${EndIf}
  ${EndIf}

  SetRegView 32
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ReadRegStr $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Version"
  SetRegView lastused
  ${If} $0 == "1"
  ${AndIf} $1 != ""
    StrCpy $2 $1 1
    ${If} $2 == "v"
      StrCpy $1 $1 "" 1
    ${EndIf}
    ${VersionCompare} "$1" "${LATTICE_VC_RUNTIME_VERSION}" $2
    ${If} $2 == "0"
    ${OrIf} $2 == "1"
      Goto ${READY_LABEL}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\lattice-cli.exe" "Lattice CLI / MCP"
  Push $0
  Push $1
  Push $2
  Push $3
  !insertmacro LATTICE_CHECK_VC_RUNTIME lattice_runtime_ready

  InitPluginsDir
  StrCpy $3 $OUTDIR
  SetOutPath "$PLUGINSDIR"
  File /oname=vc_redist.x64.exe "${LATTICE_VC_REDIST}"
  File /oname=install-windows-runtime.ps1 "${LATTICE_VC_INSTALL_SCRIPT}"
  SetOutPath "$3"
  DetailPrint "Installing Microsoft Visual C++ x64 runtime ${LATTICE_VC_RUNTIME_VERSION}..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\install-windows-runtime.ps1" -Installer "$PLUGINSDIR\vc_redist.x64.exe"'
  Pop $0
  Pop $1
  DetailPrint "$1"
  StrCmp $0 "0" lattice_runtime_verify
  StrCmp $0 "3010" lattice_runtime_reboot
  StrCmp $0 "1641" lattice_runtime_reboot lattice_runtime_failed

lattice_runtime_reboot:
  SetRebootFlag true
lattice_runtime_verify:
  !insertmacro LATTICE_CHECK_VC_RUNTIME lattice_runtime_ready
lattice_runtime_failed:
  MessageBox MB_OK|MB_ICONSTOP "Lattice requires Microsoft Visual C++ x64 runtime ${LATTICE_VC_RUNTIME_VERSION} or newer. Installation failed or was cancelled. Setup will stop."
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Abort
lattice_runtime_ready:
  ClearErrors
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetOutPath "$INSTDIR"
  File /oname=lattice-cli.exe "${LATTICE_INSTALLER_HOOK_DIR}\..\target\release\lattice-cli.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\lattice-cli.exe" "Lattice CLI / MCP"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\lattice-cli.exe"
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RMDir /r "$APPDATA\Lattice"
    RMDir /r "$LOCALAPPDATA\Lattice\logs"
  ${EndIf}
  RMDir "$INSTDIR"
!macroend
