# Como contribuir

O site em produção **não sobe sozinho** quando alguém manda código. Merge no GitHub só atualiza o repositório. O deploy continua **manual**, feito pelo dono do projeto.

## Fluxo

1. Abra uma **issue** descrevendo o bug ou a melhoria.
2. Faça um fork (ou uma branch) e implemente a mudança.
3. Abra um **pull request** ligado à issue.
4. O dono analisa, pede ajuste se precisar e aprova o merge.
5. Só depois o dono sobe para produção (Vercel + Railway), quando quiser.

## Regras rápidas

- Não commite `.env`, senhas, tokens, chaves ou dumps de banco.
- Use `apps/api/.env.example` e `apps/web/.env.example` só como modelo.
- Prefira PRs pequenos e objetivos.
- Não altere variáveis de produção nem configure deploy automático.

## Deploy

Deploy é responsabilidade do dono. Contribuidores não precisam (e não devem) publicar o site.
