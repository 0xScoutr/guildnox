$ErrorActionPreference = "Stop"
try {
  Invoke-WebRequest -Uri "https://api-production-3740.up.railway.app/auth/discord" -MaximumRedirection 0 -UseBasicParsing | Out-Null
} catch {
  $resp = $_.Exception.Response
  if (-not $resp) { throw }
  Write-Output ("Status=" + [int]$resp.StatusCode)
  Write-Output ("Location=" + $resp.Headers["Location"])
  Write-Output ("Set-Cookie=" + $resp.Headers["Set-Cookie"])
}
