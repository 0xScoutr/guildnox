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
- `VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY` (opcionais) ligam as notificações push. Gere uma vez com `npx web-push generate-vapid-keys` e guarde as duas no Railway; trocar as chaves corta o push de todo mundo até cada um abrir o site de novo. Sem elas o site funciona igual, só sem push.
- `VAPID_SUBJECT` (opcional): `https://` do site ou `mailto:` de contato
- `DISCORD_BOT_TOKEN` (opcional) liga o bot que avisa o boss falando na call. Precisa também da chave do serviço de voz: `GOOGLE_TTS_API_KEY` (padrão) ou `TTS_PROVIDER=openai` com `OPENAI_API_KEY`. `TTS_VOICE` escolhe a voz.

## Bot de voz

1. No [Discord Developer Portal](https://discord.com/developers/applications), abra o mesmo aplicativo do login, vá em **Bot**, gere o token e coloque em `DISCORD_BOT_TOKEN`.
2. Convide o bot para o servidor com `https://discord.com/oauth2/authorize?client_id=SEU_CLIENT_ID&scope=bot&permissions=3146752` (ver canal, conectar e falar).
3. No Google Cloud, ative a **Cloud Text-to-Speech API** (o projeto precisa estar com o faturamento ativo, mesmo dentro da cota grátis), crie uma chave de API restrita a ela e coloque em `GOOGLE_TTS_API_KEY`.
4. No site, em Gerenciar guildas > Discord, cole o ID do canal de voz de cada guilda e use **Testar voz**.

Na aba Bot do Developer Portal, deixe **Public Bot** desligado. Se o canal de voz for privado ou tiver limite de pessoas, libere o cargo do bot nele.

O bot só entra quando tem gente no canal, fala o aviso e sai. No lembrete de 10 min e na reabertura ele só fala se alguém da call ainda não fez check-in. Para usar a OpenAI no lugar do Google: `TTS_PROVIDER=openai`, `OPENAI_API_KEY` e, se quiser, `OPENAI_TTS_MODEL` (padrão `gpt-4o-mini-tts`).

O bot de voz precisa do Node 22.12 ou mais novo (o `package.json` da API já pede isso).

## Variável do site

`VITE_API_URL` é o endereço público da API. A Vercel precisa dela no momento do build.
