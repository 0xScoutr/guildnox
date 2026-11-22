Set-Location E:\guildchapa\apps\api
$vars = railway variables --json | ConvertFrom-Json
Write-Output ("API_PUBLIC_URL=" + $vars.API_PUBLIC_URL)
Write-Output ("CLIENT_ORIGIN=" + $vars.CLIENT_ORIGIN)
