# Deploy — GitHub Pages + bohr.io (backend)

O front (`index.html`) é estático e vai no **GitHub Pages**. O Jira Cloud **não permite**
chamada direta do navegador (bloqueio de CORS), então o backend em `api/core/`
(Bohr Function) faz o papel de proxy — mesma lógica do `worker.js` (Cloudflare Worker,
alternativa anterior) e do `index.mjs` (localhost). **Manter os três em paridade** ao
editar agregações.

O token do Jira é de **cada usuário**, enviado por header a cada requisição. O backend
**não guarda** nenhum token.

## 1. Publicar o backend no bohr.io (grátis)

1. Em [bohr.io](https://bohr.io), **Importar de um projeto existente** → selecione o
   repositório `time-jira` no GitHub.
2. Na tela de import:
   - **Predefinições de framework**: deixe em branco (não selecione nenhum — o projeto
     é estático puro; o bohr detecta a function em `api/core/` sozinho).
   - **Comando de build / diretório raiz / saída / instalação / desenvolvimento**:
     deixe todos em branco.
   - **Variáveis de ambiente** (opcional, recomendado depois de publicar o Pages):
     `ALLOWED_ORIGIN=https://denerbatista.github.io` (trava o CORS).
     Outras opcionais: `DEFAULT_TZ`, `DEFAULT_DAYS`, `CACHE_TTL_MS`, `EXTRA_HOLIDAYS`.
3. Clique **IMPORTAR**. O deploy roda via GitHub Actions (`.github/workflows/bohr.yml`).
4. A API fica em `https://<projeto>.bohr.io/api/...` (ex.: `/api/hours`, `/api/health`).

> Logs do backend: menu **Logs** no painel do bohr.io.

## 2. Apontar o front para o bohr.io

No `index.html`, aponte o `API_BASE` para a URL do projeto no bohr.io:

```js
const API_BASE = (localStorage.getItem("apiBase") || (
    /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "" : "https://SEU-PROJETO.bohr.io"
)).replace(/\/+$/, "");
```

> Alternativa sem editar código (bom para testar antes): no navegador rode
> `localStorage.setItem('apiBase', 'https://SEU-PROJETO.bohr.io')`.

Em `localhost` o front continua usando o backend node (`node index.mjs`) via caminho relativo.

## 3. Publicar o GitHub Pages

Settings → Pages → Source: `Deploy from a branch` → branch `main` / pasta `/root`.
A URL fica algo como `https://denerbatista.github.io/time-jira/`.

## Rodando o backend bohr localmente

```bash
cd api/core && npm install && npm start   # http://localhost:3003
```

---

## Alternativa anterior: Cloudflare Worker

O `worker.js` continua no repositório e funcional, caso queira voltar.

```bash
npm install -g wrangler       # ou: npx wrangler ...
wrangler login                # abre o navegador para autenticar
wrangler deploy               # publica worker.js -> https://time-jira-proxy.<subdominio>.workers.dev
```

Depois aponte o `API_BASE` (ou o `localStorage.apiBase`) para a URL do Worker.
A origem permitida é travada em `wrangler.toml` (`ALLOWED_ORIGIN`).

## Rodando local (sem backend publicado)

```bash
node index.mjs   # http://localhost:3002  (usa .env com JIRA_API_TOKEN)
```
