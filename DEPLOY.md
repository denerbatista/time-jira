# Deploy — GitHub Pages + Cloudflare Worker

O front (`index.html`) é estático e vai no **GitHub Pages**. O Jira Cloud **não permite**
chamada direta do navegador (bloqueio de CORS), então o `worker.js` (Cloudflare Worker)
faz o papel de proxy — mesma lógica do antigo `index.mjs`, mas serverless e grátis.

O token do Jira é de **cada usuário**, enviado por header a cada requisição. O Worker
**não guarda** nenhum token.

## 1. Publicar o Worker (Cloudflare — grátis)

```bash
npm install -g wrangler       # ou: npx wrangler ...
wrangler login                # abre o navegador para autenticar
wrangler deploy               # publica worker.js -> https://time-jira-proxy.<subdominio>.workers.dev
```

Anote a URL final do Worker (aparece no output do `wrangler deploy`).

## 2. Apontar o front para o Worker

No `index.html`, troque o placeholder pela URL do seu Worker:

```js
const API_BASE = (localStorage.getItem("apiBase") || (
    /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "" : "https://SEU-WORKER.workers.dev"
)).replace(/\/+$/, "");
```

> Alternativa sem editar código: no navegador rode
> `localStorage.setItem('apiBase', 'https://SEU-WORKER.workers.dev')`.

Em `localhost` o front continua usando o backend node (`node index.mjs`) via caminho relativo.

## 3. Travar a origem (recomendado)

Depois de publicar o Pages, edite `wrangler.toml` e coloque a URL exata do Pages em
`ALLOWED_ORIGIN` (ex.: `https://denerbatista.github.io`) e rode `wrangler deploy` de novo.
Isso impede que outros sites usem seu proxy.

## 4. Publicar o GitHub Pages

Settings → Pages → Source: `Deploy from a branch` → branch `main` / pasta `/root`.
A URL fica algo como `https://denerbatista.github.io/time-jira/`.

## Rodando local (sem Worker)

```bash
node index.mjs   # http://localhost:3002  (usa .env com JIRA_API_TOKEN)
```
