# Process-level end-to-end check for xtna-vault.
# Starts the HTTP upstream as its own OS process, drives the gateway over real
# stdio pipes one request at a time, and asserts redaction, cache replay and
# placeholder rehydration. Run from the gateway directory:
#   pwsh -NoProfile -File test-fixture/e2e-process.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

Remove-Item -Recurse -Force .test-cache -ErrorAction SilentlyContinue
$up = Start-Process -FilePath "node" -ArgumentList "test-fixture/fake-upstream-http.mjs" -PassThru -WindowStyle Hidden
try {
  $open = $false
  for ($i = 0; $i -lt 25; $i++) {
    if (Test-NetConnection -ComputerName 127.0.0.1 -Port 43191 -InformationLevel Quiet -WarningAction SilentlyContinue) {
      $open = $true
      break
    }
    Start-Sleep -Milliseconds 400
  }
  if (-not $open) { throw "upstream did not open port 43191" }

  $env:MCP_VAULT_NONCE = "aaaaaa"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "node"
  $psi.Arguments = "dist/index.js --config test-fixture/config-http.json"
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.WorkingDirectory = $root
  $proc = [System.Diagnostics.Process]::Start($psi)

  function Ask([string]$json) {
    $proc.StandardInput.WriteLine($json)
    $proc.StandardInput.Flush()
    return $proc.StandardOutput.ReadLine()
  }

  $null = Ask '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}'
  $first = Ask '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"leak","arguments":{}}}'
  $second = Ask '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"leak","arguments":{}}}'
  $echo = Ask '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"echo","arguments":{"value":"<vault:1:aaaaaa>"}}}'
  $stats = Ask '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"vault_stats","arguments":{}}}'
  $proc.Kill()

  $checks = @(
    @{ name = "first call is redacted"; ok = ($first -notmatch "AKIAIOSFODNN7EXAMPLE") -and ($first -match "<vault:1:aaaaaa>") },
    @{ name = "first call reached the upstream"; ok = ($first -match "calls=1") },
    @{ name = "second call replayed from cache"; ok = ($second -match "calls=1") },
    @{ name = "placeholder rehydrated for the upstream"; ok = ($echo -match '\\"verdict\\":\\"REAL\\"') },
    @{ name = "stats report two placeholders"; ok = ($stats -match '\\"placeholders\\":2') },
    @{ name = "stats report cache hits"; ok = ($stats -match '\\"hits\\":2') }
  )

  $failed = 0
  foreach ($check in $checks) {
    if ($check.ok) { "ok   $($check.name)" } else { "FAIL $($check.name)"; $failed++ }
  }
  ""
  "$($checks.Count - $failed)/$($checks.Count) checks passed"
  if ($failed -gt 0) { exit 1 }
}
finally {
  if ($up -and -not $up.HasExited) { Stop-Process -Id $up.Id -Force -ErrorAction SilentlyContinue }
}
