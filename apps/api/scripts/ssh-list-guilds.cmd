@echo off
cd /d E:\guildchapa\apps\api
railway ssh -- node -e "const {Pool}=require('pg'); const p=new Pool({connectionString:process.env.DATABASE_URL}); p.query('SELECT id, name FROM guilds ORDER BY id').then(r=>{console.log(JSON.stringify(r.rows)); return p.end();}).catch(e=>{console.error(e); process.exit(1);})"
