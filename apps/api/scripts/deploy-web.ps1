$ErrorActionPreference = "Stop"
$tmp = Join-Path $env:TEMP ("guildnox-root-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path "$tmp\apps\web" -Force | Out-Null
robocopy "E:\guildchapa\apps\web" "$tmp\apps\web" /E /XD node_modules dist .vercel /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
Set-Location $tmp
npx --yes vercel link --project guildnox --yes --scope favelaas-projects
$env:VITE_API_URL = "https://guildnox.app"
npx --yes vercel deploy --prod --yes --build-env "VITE_API_URL=https://guildnox.app"
Set-Location E:\guildchapa
Write-Output "TMP_WAS $tmp"
