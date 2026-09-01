# Open Jarvis — the agent activity display — from whichever Clipper is running.
# (Jarvis is its own page; Clipper's process just happens to serve it.)
#
# The desktop app picks its web port at launch, so a shortcut cannot hold a
# fixed URL. This probes instead: every loopback listener gets one quick
# request to /api/settings, and the first one that answers with Clipper's
# settings JSON (fingerprint: "censorAllowList") is the app. The dev server's
# fixed port 3000 is tried first so development wins when both are up.

$ErrorActionPreference = "SilentlyContinue"

$ports = @(3000)
$ports += Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalAddress -in @("127.0.0.1", "0.0.0.0", "::", "::1") } |
  ForEach-Object LocalPort
$ports = $ports | Select-Object -Unique | Where-Object { $_ -ge 1024 }

foreach ($port in $ports) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$port/api/settings"
    if ($r.StatusCode -eq 200 -and $r.Content -like '*censorAllowList*') {
      Start-Process "http://127.0.0.1:$port/brain?monitor=1"
      exit 0
    }
  } catch {}
}

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show(
  "Jarvis has no feed to show. Start Clipper (or the dev server), then try again.",
  "Jarvis") | Out-Null
exit 1
