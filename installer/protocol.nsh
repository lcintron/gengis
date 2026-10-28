; GenGIS Windows installer: gengis:// links open GenGIS (electron/links.js). electron-builder registers the scheme
; itself on macOS and Linux (package.json: build.protocols), not in the Windows installer: here, for the same user (or
; machine) the app is installed for, and removed again on uninstall.

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\gengis" "" "URL:GenGIS link"
  WriteRegStr SHELL_CONTEXT "Software\Classes\gengis" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\gengis\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\gengis\shell\open\command" "" '"$appExe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "Software\Classes\gengis"
!macroend
