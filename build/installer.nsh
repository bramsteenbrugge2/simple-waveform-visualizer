; Custom NSIS steps for Waveform Visualizer.
; Adds a Windows Firewall rule at install time so the LAN web remote is reachable
; from other devices on the network without a per-run "Allow access" prompt.
; (The installer runs elevated because build.nsis.perMachine is true.)

!macro customInstall
  DetailPrint "Adding firewall rule: Waveform Visualizer (TCP 8080) ..."
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Waveform Visualizer (8080)"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Waveform Visualizer (8080)" dir=in action=allow protocol=TCP localport=8080 profile=private,domain'
!macroend

!macro customUnInstall
  DetailPrint "Removing firewall rule: Waveform Visualizer (8080) ..."
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Waveform Visualizer (8080)"'
!macroend
