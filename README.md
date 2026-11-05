# guildchapa

Hall da guilda **guildchapa** para o jogo **Vampir**. A primeira versão entra com Discord, mostra o painel da guilda e a lista de membros.

| Parte | Onde publica | Pasta |
|---|---|---|
| Site | Vercel | `apps/web` |
| API e banco | Railway (PostgreSQL) | `apps/api` |
| Código | GitHub | raiz |

O site e a API ficam em endereços diferentes. O navegador guarda a sessão num cookie do domínio da API.

## Discord

O botão de entrar só funciona depois de criar um aplicativo em [Discord Developer Portal](https://discord.com/developers/applications):

1. Crie um aplicativo chamado `guildchapa`.
2. Em OAuth2, copie o Client ID e o Client Secret.
3. Adicione o redirect `https://SEU-DOMINIO-DA-API/auth/discord/callback`.
4. Coloque `DISCORD_CLIENT_ID` e `DISCORD_CLIENT_SECRET` nas variáveis da API no Railway.

A primeira pessoa que entrar vira mestre. Mestre e admin editam DKP. Só o mestre muda cargos.

## Variáveis da API

Veja `apps/api/.env.example`.

- `DATABASE_URL` — o Railway preenche ao adicionar o Postgres
- `SESSION_SECRET` — texto longo e aleatório
- `CLIENT_ORIGIN` — endereço do site na Vercel
- `API_PUBLIC_URL` — endereço público da API
- `DISCORD_CLIENT_ID` e `DISCORD_CLIENT_SECRET`

## Variável do site

`VITE_API_URL` é o endereço público da API. A Vercel precisa dela no momento do build.
