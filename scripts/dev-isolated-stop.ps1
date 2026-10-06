# Stop every node/cmd process started from THIS checkout (matched by path),
# leaving other checkouts of the project running.
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$procs = Get-CimInstance Win32_Process |
  Where-Object { ($_.Name -in @("node.exe", "cmd.exe")) -and $_.CommandLine -and $_.CommandLine.Contains($root) }
foreach ($p in $procs) {
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Host "stopped $($p.ProcessId)" } catch {}
}
