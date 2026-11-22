$html = (Invoke-WebRequest -Uri "https://guildnox.app/" -UseBasicParsing).Content
if ($html -notmatch 'src="(/assets/[^"]+\.js)"') {
  Write-Output "no_js_bundle"
  Write-Output $html.Substring(0, [Math]::Min(500, $html.Length))
  exit 1
}
$js = $Matches[1]
Write-Output ("bundle=" + $js)
$code = (Invoke-WebRequest -Uri ("https://guildnox.app" + $js) -UseBasicParsing).Content
$urls = [regex]::Matches($code, 'https://[a-zA-Z0-9._\-:/]+') | ForEach-Object { $_.Value } | Select-Object -Unique
$urls | Where-Object { $_ -match 'railway|guildnox|api|vercel' } | ForEach-Object { Write-Output $_ }
Write-Output "---api_literal---"
if ($code -match 'api-production[^"''`]+') { Write-Output $Matches[0] }
if ($code -match 'VITE_API|up\.railway\.app') { Write-Output "found_railway_ref" }
# Look near auth/discord usage
$idx = $code.IndexOf("auth/discord")
if ($idx -ge 0) {
  $start = [Math]::Max(0, $idx - 120)
  Write-Output ("near_auth=" + $code.Substring($start, [Math]::Min(240, $code.Length - $start)))
}
