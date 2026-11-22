@echo off
cd /d E:\guildchapa\apps\api
railway ssh -- node scripts/rename-chapa-guilds.js > %TEMP%\rename-out.txt 2>&1
echo EXIT=%ERRORLEVEL%
type %TEMP%\rename-out.txt
