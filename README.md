# Guildnox

Hall da guilda (produção em [guildnox.app](https://guildnox.app)). Login com Discord, leilão, atividades, ranking e gestão de membros.

| Parte | Onde publica | Pasta |
|---|---|---|
| Site | Vercel | `apps/web` |
| API e banco | Railway (PostgreSQL) | `apps/api` |
| Código | GitHub | raiz |

O site e a API ficam em endereços diferentes. O navegador guarda a sessão num cookie do domínio da API.

## Colaboração (issues e PRs)

Queremos contribuições via GitHub:

1. Abra uma **issue** com a ideia ou o bug.
2. Envie um **pull request** com a correção/melhoria.
3. O dono revisa e aprova o merge se estiver ok.

**Deploy não é automático.** Merge no `main` **não** publica o site. Só o dono sobe para produção quando decidir. Veja [CONTRIBUTING.md](CONTRIBUTING.md).

## Discord

O botão de entrar só funciona depois de criar um aplicativo em [Discord Developer Portal](https://discord.com/developers/applications):

1. Crie um aplicativo chamado `Guildnox` (ou o nome que preferir no Discord).
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
