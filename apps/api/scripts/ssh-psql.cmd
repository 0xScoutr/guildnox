@echo off
cd /d E:\guildchapa\apps\api
railway ssh -p 18f7838c-3820-4588-a95b-99857193a536 -e production -s Postgres -- psql -U postgres -d railway -c "SELECT id, name FROM guilds ORDER BY id;"
