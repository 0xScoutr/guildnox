@echo off
cd /d E:\guildchapa\apps\api
railway up --detach
timeout /t 50 /nobreak
railway ssh -- node scripts/check-apps.js
