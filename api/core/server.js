/**
 * Jira Hours Dashboard — Bohr Function (proxy CORS)
 *
 * Backend hospedado no bohr.io (substitui o Cloudflare Worker `worker.js`).
 * O navegador NAO pode chamar a API do Jira Cloud diretamente (o Jira nao envia
 * headers de CORS para chamadas autenticadas de outra origem). Esta function faz
 * esse papel de proxy: recebe as credenciais do usuario por header em cada
 * requisicao, encaminha para o Jira e devolve o JSON ja agregado.
 *
 * Mesma logica de agregacao do `worker.js` / `index.mjs` — manter os tres em
 * paridade ao editar agregacoes.
 *
 * Rotas (registradas com e sem o prefixo /api, pois o bohr.io roteia o path
 * publico `<projeto>.bohr.io/api/*` para esta function):
 *   OPTIONS *                          -> preflight CORS
 *   GET /health        | /api/health   -> ok
 *   GET /projects      | /api/projects -> lista de projetos com worklog do usuario
 *   GET /hours         | /api/hours    -> payload completo do dashboard
 *
 * Credenciais (por requisicao, nunca guardadas no servidor):
 *   x-jira-base-url, x-jira-email, x-jira-token
 *
 * Variaveis de ambiente (opcionais, via painel do bohr.io):
 *   ALLOWED_ORIGIN  -> origem(s) permitida(s), separadas por virgula.
 *                      Ex.: "https://denerbatista.github.io". Default "*".
 *   DEFAULT_TZ      -> "America/Sao_Paulo"
 *   DEFAULT_DAYS    -> "30"
 *   CACHE_TTL_MS    -> "120000"
 *   EXTRA_HOLIDAYS  -> "2026-02-20,2026-10-15"
 */

const express = require("express");

// Node >= 18 tem fetch global; em runtimes mais antigos cai no node-fetch.
const fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : require("node-fetch");

// ============================ Config por deploy ============================
const CFG = {
    ALLOWED_ORIGIN: String(process.env.ALLOWED_ORIGIN || "*"),
    DEFAULT_TZ: String(process.env.DEFAULT_TZ || "America/Sao_Paulo"),
    DEFAULT_DAYS: Number(process.env.DEFAULT_DAYS || "30"),
    CACHE_TTL_MS: Number(process.env.CACHE_TTL_MS || "120000"),
    EXTRA_HOLIDAYS: String(process.env.EXTRA_HOLIDAYS || "")
        .split(",").map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
};

// ============================ Utilidades base ============================
function b64(s) {
    return Buffer.from(s, "utf8").toString("base64");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (s, max = 4000) => String(s ?? "").trim().slice(0, max);

function isoDate(d) { return d.toISOString().slice(0, 10); }
function defaultRange(days) {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - Math.max(1, days));
    return { from: isoDate(from), to: isoDate(to) };
}

function escapeJqlString(s) {
    return String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function looksLikeFreeText(s) {
    return !/[=!<>~]/.test(s) && !/\b(IN|NOT\s+IN|IS|IS\s+NOT|AND|OR|ORDER\s+BY)\b/i.test(s);
}
function normalizeExtraFilter(q, mode) {
    const raw = clamp(q, 2000);
    if (!raw) return "";
    const m = String(mode || "auto").toLowerCase();
    if (m === "text") return `text ~ "${escapeJqlString(raw)}"`;
    if (m === "jql") return raw;
    return looksLikeFreeText(raw) ? `text ~ "${escapeJqlString(raw)}"` : raw;
}

function safeNum(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function round2(n) { return Math.round(n * 100) / 100; }

function dateKeyInTZ(dateTimeStr, tz) {
    const d = new Date(dateTimeStr);
    return d.toLocaleDateString("en-CA", { timeZone: tz });
}
function todayKeyInTZ(tz) {
    return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}
function weekdayShort(dateStr, tz) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
}
function toDayLabelPtBR(dateStr, tz) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    return new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(d);
}
function monthLabelPtBR(yyyyMm) {
    const [y, m] = yyyyMm.split("-").map((v) => parseInt(v, 10));
    const d = new Date(Date.UTC(y, (m || 1) - 1, 15));
    return new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(d).replace(".", "").replace(/^\w/, (c) => c.toUpperCase());
}
function eachDay(from, to) {
    const out = [];
    const d = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    while (d <= end) { out.push(isoDate(d)); d.setUTCDate(d.getUTCDate() + 1); }
    return out;
}
function addMonths(yyyyMm, delta) {
    const [y0, m0] = yyyyMm.split("-").map((v) => parseInt(v, 10));
    let y = y0, m = (m0 || 1) + delta;
    while (m <= 0) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    return `${y}-${String(m).padStart(2, "0")}`;
}
function isoWeek(dateStr) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
    return { year: t.getUTCFullYear(), week };
}

// ============================ Feriados ============================
const FIXED_HOLIDAYS = [
    ["01-01", "Confraternizacao Universal"],
    ["04-21", "Tiradentes"],
    ["05-01", "Dia do Trabalho"],
    ["09-07", "Independencia"],
    ["10-12", "Nossa Senhora Aparecida"],
    ["11-02", "Finados"],
    ["11-15", "Proclamacao da Republica"],
    ["11-20", "Consciencia Negra"],
    ["12-25", "Natal"],
    ["04-03", "Aniversario de Aracruz"],
    ["06-24", "Sao Joao Batista (padroeiro de Aracruz)"],
];
const EASTER_HOLIDAYS = [
    [-48, "Segunda-feira de Carnaval"],
    [-47, "Terca-feira de Carnaval"],
    [-2, "Sexta-feira Santa"],
    [0, "Pascoa"],
    [8, "Nossa Senhora da Penha (padroeira do ES)"],
    [60, "Corpus Christi"],
];

function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(year, month - 1, day));
}

const holidayCache = new Map();
function holidaysForYear(year) {
    if (holidayCache.has(year)) return holidayCache.get(year);
    const set = new Set();
    for (const [md] of FIXED_HOLIDAYS) set.add(`${year}-${md}`);
    const easter = easterSunday(year);
    for (const [off] of EASTER_HOLIDAYS) {
        const d = new Date(easter.getTime());
        d.setUTCDate(d.getUTCDate() + off);
        set.add(isoDate(d));
    }
    holidayCache.set(year, set);
    return set;
}
function isHoliday(dateStr) {
    if (CFG.EXTRA_HOLIDAYS.includes(dateStr)) return true;
    const year = parseInt(String(dateStr).slice(0, 4), 10);
    if (!Number.isFinite(year)) return false;
    return holidaysForYear(year).has(dateStr);
}
function isNonWorkingDay(dateStr, tz) {
    const w = weekdayShort(dateStr, tz);
    if (w === "Sat" || w === "Sun") return true;
    return isHoliday(dateStr);
}

function businessDaysInSeries(series, tz) {
    let bd = 0;
    for (const x of series) {
        if (isNonWorkingDay(x.date, tz)) continue;
        bd += 1;
    }
    return bd;
}
function getInitials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] || "?";
    const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (a + b).toUpperCase();
}
function mapType(name) {
    const s = String(name || "").toLowerCase();
    if (s.includes("bug") || s.includes("erro")) return "bug";
    if (s.includes("epic") || s.includes("epico")) return "epic";
    if (s.includes("story") || s.includes("hist")) return "story";
    return "task";
}
function mapPriority(name) {
    const s = String(name || "").toLowerCase();
    if (s.includes("highest") || s.includes("high") || s.includes("alta")) return "high";
    if (s.includes("low") || s.includes("baixa") || s.includes("lowest")) return "low";
    return "medium";
}
function mapStatus(fieldsStatus) {
    const name = String(fieldsStatus?.name || "").toLowerCase();
    const cat = String(fieldsStatus?.statusCategory?.key || "").toLowerCase();
    if (name.includes("review") || name.includes("revis")) return "review";
    if (cat === "done") return "done";
    if (cat === "new") return "todo";
    return "in_progress";
}
function isReviewStatusName(name) {
    const s = String(name || "").toLowerCase();
    // Apenas a coluna "Revisar" (revisao). Exclui "Code Review"/"codereview".
    if (s.includes("code")) return false;
    return s.includes("revis") || s.includes("review");
}

// ============================ Jira ============================
function authFromRequest(req) {
    const baseUrl = String(req.get("x-jira-base-url") || "").trim().replace(/\/+$/, "");
    const email = String(req.get("x-jira-email") || "").trim();
    const token = String(req.get("x-jira-token") || "").trim();
    if (!baseUrl || !email || !token) {
        throw new Error("Credenciais ausentes. Informe base URL, e-mail e token.");
    }
    if (!/^https:\/\/[^/\s]+$/i.test(baseUrl)) {
        throw new Error("Base URL invalida. Use https://empresa.atlassian.net");
    }
    return { baseUrl, email, auth: `Basic ${b64(`${email}:${token}`)}` };
}

async function jiraFetch(authConfig, urlPath, { method = "GET", headers = {}, body } = {}) {
    const url = `${authConfig.baseUrl}${urlPath}`;
    const res = await fetchImpl(url, {
        method,
        headers: { Authorization: authConfig.auth, Accept: "application/json", ...headers },
        body,
    });

    if (res.status === 429) {
        const retryAfter = safeNum(res.headers.get("retry-after"), 2);
        await sleep(Math.max(1, retryAfter) * 1000);
        return jiraFetch(authConfig, urlPath, { method, headers, body });
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`Jira API ${res.status} ${res.statusText} em ${urlPath}\n${text}`);

    try { return JSON.parse(text || "{}"); } catch { return {}; }
}

// withDetails=true embute worklog (cap 20/card) e changelog na propria busca,
// para evitar 2 requests por card.
async function searchIssuesByJql(authConfig, jql, { withDetails = false } = {}) {
    const issues = [];
    let nextPageToken = undefined;

    const fields = ["project", "summary", "status", "priority", "issuetype", "assignee", "timetracking", "updated", "created"];
    if (withDetails) fields.push("worklog");

    while (true) {
        const payload = {
            jql,
            fields,
            maxResults: 200,
            ...(withDetails ? { expand: "changelog" } : {}),
            ...(nextPageToken ? { nextPageToken } : {}),
        };

        const page = await jiraFetch(authConfig, "/rest/api/3/search/jql", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        for (const it of page.issues || []) issues.push(it);
        nextPageToken = page.nextPageToken;
        if (!nextPageToken) break;
    }
    return issues;
}

async function fetchAllWorklogs(authConfig, issueKey) {
    const all = [];
    let startAt = 0;
    const maxResults = 100;
    while (true) {
        const page = await jiraFetch(authConfig, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog?startAt=${startAt}&maxResults=${maxResults}`);
        const worklogs = page.worklogs || [];
        all.push(...worklogs);
        startAt += worklogs.length;
        const total = safeNum(page.total, all.length);
        if (startAt >= total || worklogs.length === 0) break;
    }
    return all;
}

// Historico de mudancas de status de um card (paginado).
// Retorna [{ created, toName }] apenas para transicoes de status.
async function fetchStatusChanges(authConfig, issueKey) {
    const out = [];
    let startAt = 0;
    const maxResults = 100;
    while (true) {
        const page = await jiraFetch(authConfig, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog?startAt=${startAt}&maxResults=${maxResults}`);
        const values = page.values || [];
        for (const h of values) {
            for (const item of (h.items || [])) {
                if (String(item.field).toLowerCase() === "status") {
                    out.push({ created: h.created, toName: item.toString || item.to });
                }
            }
        }
        startAt += values.length;
        const total = safeNum(page.total, out.length);
        if (startAt >= total || values.length === 0) break;
    }
    return out;
}

// Extrai transicoes de status de um bloco de histories do changelog.
function statusChangesFromHistories(histories) {
    const out = [];
    for (const h of histories || []) {
        for (const item of (h.items || [])) {
            if (String(item.field).toLowerCase() === "status") {
                out.push({ created: h.created, toName: item.toString || item.to });
            }
        }
    }
    return out;
}

// Dia (YYYY-MM-DD no tz) em que o card entrou pela 1a vez na revisao dentro do periodo.
// Usa o changelog ja embutido na busca (expand=changelog); so faz request extra
// se o Jira truncou o historico (total > histories retornados).
async function firstReviewDayInRange(authConfig, issue, tz, from, to) {
    const cl = issue.changelog || {};
    const histories = cl.histories || [];
    const complete = safeNum(cl.total, histories.length) <= histories.length;
    const changes = complete
        ? statusChangesFromHistories(histories)
        : await fetchStatusChanges(authConfig, issue.key);
    const days = changes
        .filter((c) => isReviewStatusName(c.toName))
        .map((c) => dateKeyInTZ(c.created, tz))
        .filter((day) => day >= from && day <= to)
        .sort();
    return days.length ? days[0] : null;
}

// Worklogs de um card. Usa os ja embutidos na busca (field "worklog", cap de 20);
// so faz request extra se o card tiver mais de 20 worklogs (total > retornados).
async function worklogsForIssue(authConfig, issue) {
    const wl = issue.fields?.worklog || {};
    const inline = wl.worklogs || [];
    const complete = safeNum(wl.total, inline.length) <= inline.length;
    return complete ? inline : fetchAllWorklogs(authConfig, issue.key);
}

async function pMap(items, limit, fn) {
    const results = new Array(items.length);
    let idx = 0;
    const workers = Array.from({ length: Math.max(1, limit) }, async () => {
        while (true) {
            const i = idx++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}

function isLikelyWorklogAuthorJqlError(msg) {
    const s = String(msg || "");
    return /worklogAuthor/i.test(s) || /Erro na consulta JQL/i.test(s);
}

// Cache best-effort no escopo do processo (efemero, mas ajuda em rajadas)
const cache = new Map();
function cacheGet(key) {
    const it = cache.get(key);
    if (!it) return null;
    if (Date.now() - it.at > CFG.CACHE_TTL_MS) { cache.delete(key); return null; }
    return it.payload;
}
function cacheSet(key, payload) { cache.set(key, { at: Date.now(), payload }); }

function computeStreak(series, minHours, tz) {
    let streak = 0;
    for (let i = series.length - 1; i >= 0; i--) {
        if (isNonWorkingDay(series[i].date, tz)) continue;
        if (series[i].hours >= minHours) streak += 1;
        else break;
    }
    return streak;
}

async function buildDashboard(authConfig, { from, to, tz, q, mode, authorFilter, concurrency, projectKey }) {
    const cacheKey = JSON.stringify({ baseUrl: authConfig.baseUrl, email: authConfig.email, from, to, tz, q, mode, authorFilter, concurrency, projectKey });
    const cached = cacheGet(cacheKey);
    if (cached) return { ...cached, cached: true };

    const me = await jiraFetch(authConfig, "/rest/api/3/myself");
    const accountId = me?.accountId;
    const displayName = me?.displayName || authConfig.email;
    if (!accountId) throw new Error("Nao consegui obter accountId em /rest/api/3/myself");

    const extra = normalizeExtraFilter(q, mode);
    let baseJql = `worklogDate >= "${from}" AND worklogDate <= "${to}"`;
    if (projectKey && projectKey !== "all") baseJql = `${baseJql} AND project = "${escapeJqlString(projectKey)}"`;
    if (extra) baseJql = `${baseJql} AND (${extra})`;

    let jqlUsed = baseJql;
    let issues = [];
    const af = String(authorFilter || "auto").toLowerCase();
    if (af === "on") {
        jqlUsed = `worklogAuthor = "${accountId}" AND ${baseJql}`;
        issues = await searchIssuesByJql(authConfig, jqlUsed, { withDetails: true });
    } else if (af === "off") {
        issues = await searchIssuesByJql(authConfig, jqlUsed, { withDetails: true });
    } else {
        try {
            jqlUsed = `worklogAuthor = "${accountId}" AND ${baseJql}`;
            issues = await searchIssuesByJql(authConfig, jqlUsed, { withDetails: true });
        } catch (e) {
            if (!isLikelyWorklogAuthorJqlError(e?.message)) throw e;
            jqlUsed = baseJql;
            issues = await searchIssuesByJql(authConfig, jqlUsed, { withDetails: true });
        }
    }

    const days = eachDay(from, to);
    const byDaySeconds = new Map(days.map((d) => [d, 0]));
    const byIssueSeconds = new Map();
    const byProjectSeconds = new Map();
    const byTypeSeconds = new Map();
    const recent = [];
    const reviewedByDay = new Map(days.map((d) => [d, 0]));
    const dayDetails = new Map(days.map((d) => [d, []]));

    const issueMeta = new Map();

    await pMap(issues, concurrency, async (issue) => {
        const key = issue?.key;
        if (!key) return;

        const f = issue.fields || {};
        const pk = f.project?.key || f.project?.name || "Sem projeto";
        const projectName = f.project?.name || pk;
        const summary = f.summary || key;

        issueMeta.set(key, {
            key,
            title: summary,
            project: projectName,
            projectKey: pk,
            status: mapStatus(f.status),
            priority: mapPriority(f.priority?.name),
            type: mapType(f.issuetype?.name),
            assignee: f.assignee?.displayName || displayName,
            avatarInitials: getInitials(f.assignee?.displayName || displayName),
            estimatedSeconds: safeNum(f.timetracking?.originalEstimateSeconds, 0),
            createdAt: f.created || "",
            updatedAt: f.updated || "",
        });

        // Cartoes Revisados: conta o card 1x se passou pela coluna de revisao no periodo,
        // atribuido ao primeiro dia em que entrou em revisao (via changelog).
        const reviewDay = await firstReviewDayInRange(authConfig, issue, tz, from, to);
        if (reviewDay) reviewedByDay.set(reviewDay, (reviewedByDay.get(reviewDay) || 0) + 1);

        const worklogs = await worklogsForIssue(authConfig, issue);
        for (const wl of worklogs) {
            if (wl?.author?.accountId !== accountId) continue;

            const started = wl.started;
            const sec = safeNum(wl.timeSpentSeconds, 0);
            if (!started || sec <= 0) continue;

            const day = dateKeyInTZ(started, tz);
            if (day < from || day > to) continue;

            byDaySeconds.set(day, (byDaySeconds.get(day) || 0) + sec);
            byIssueSeconds.set(key, (byIssueSeconds.get(key) || 0) + sec);
            byProjectSeconds.set(pk, (byProjectSeconds.get(pk) || 0) + sec);

            const t = mapType(f.issuetype?.name);
            byTypeSeconds.set(t, (byTypeSeconds.get(t) || 0) + sec);

            const issueStatus = mapStatus(f.status);
            const detail = {
                started,
                key,
                title: summary,
                seconds: sec,
                hours: round2(sec / 3600),
                formatted: `${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}`,
                status: issueStatus,
                assignee: f.assignee?.displayName || displayName,
                comment: String(wl.comment?.content?.[0]?.content?.[0]?.text || "").slice(0, 200),
                updatedAt: f.updated || "",
            };
            dayDetails.get(day)?.push(detail);
            recent.push(detail);
        }
    });

    const series = days.map((d) => {
        const seconds = byDaySeconds.get(d) || 0;
        return { date: d, seconds, hours: round2(seconds / 3600) };
    });

    const reviewedCardsChart = days.map((date) => ({
        date,
        label: toDayLabelPtBR(date, tz),
        reviewed: reviewedByDay.get(date) || 0,
    }));

    const dailyDetails = days.map((date) => {
        const entries = (dayDetails.get(date) || []).sort((a, b) => new Date(a.started).getTime() - new Date(b.started).getTime());
        const totalSeconds = entries.reduce((acc, it) => acc + safeNum(it.seconds, 0), 0);
        return {
            date,
            totalSeconds,
            totalHours: round2(totalSeconds / 3600),
            formatted: `${String(Math.floor(totalSeconds / 3600)).padStart(2, "0")}:${String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0")}`,
            entries,
        };
    }).filter((x) => x.entries.length > 0);

    const totalHours = round2(series.reduce((s, x) => s + x.hours, 0));
    const daysWithHours = series.filter((x) => x.hours > 0).length;
    const avgDaily = series.length ? round2(totalHours / series.length) : 0;
    const todayTz = todayKeyInTZ(tz);
    const completedDaysSeries = series.filter((x) => x.date < todayTz);
    const streakAbove7h = computeStreak(completedDaysSeries, 7, tz);

    const weekdays = series.filter((x) => !isNonWorkingDay(x.date, tz));
    const last14 = weekdays.slice(Math.max(0, weekdays.length - 14));
    const dailyHoursChart = last14.map((x) => ({ day: toDayLabelPtBR(x.date, tz), logged: x.hours, estimated: 8 }));

    const toYm = to.slice(0, 7);
    const months = Array.from({ length: 6 }, (_, i) => addMonths(toYm, -5 + i));
    const byMonth = new Map();
    for (const x of series) {
        const ym = x.date.slice(0, 7);
        byMonth.set(ym, (byMonth.get(ym) || 0) + x.hours);
    }
    const monthlyHours = months.map((ym) => {
        const monthDays = series.filter((x) => x.date.startsWith(ym));
        const bd = monthDays.filter((x) => !isNonWorkingDay(x.date, tz)).length;
        const estimated = bd * 8;
        const logged = round2(byMonth.get(ym) || 0);
        const overtime = Math.max(0, round2(logged - estimated));
        return { month: monthLabelPtBR(ym), logged, estimated, overtime };
    });

    const cards = Array.from(byIssueSeconds.entries()).map(([k, sec]) => {
        const meta = issueMeta.get(k) || { key: k, title: k, project: "-", status: "todo", priority: "medium", type: "task", assignee: displayName, avatarInitials: getInitials(displayName), estimatedSeconds: 0, createdAt: "", updatedAt: "" };
        return {
            id: k,
            key: k,
            title: meta.title,
            status: meta.status,
            assignee: meta.assignee,
            avatarInitials: meta.avatarInitials,
            sprint: "Periodo selecionado",
            estimatedHours: round2(meta.estimatedSeconds / 3600),
            loggedHours: round2(sec / 3600),
            project: meta.project,
            priority: meta.priority,
            type: meta.type,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
        };
    }).sort((a, b) => b.loggedHours - a.loggedHours).slice(0, 20);

    const estRange = businessDaysInSeries(series, tz) * 8;
    const overtimeRange = Math.max(0, round2(totalHours - estRange));
    const remainingRange = Math.max(0, round2(estRange - totalHours));
    const percentComplete = estRange > 0 ? Math.min(100, Math.round((totalHours / estRange) * 100)) : 0;
    const sprintProgress = {
        estimateHours: estRange,
        loggedHours: totalHours,
        overtimeHours: overtimeRange,
        remainingHours: remainingRange,
        percentComplete,
    };

    const projectsArr = Array.from(byProjectSeconds.entries()).map(([pk, sec]) => {
        const name = issues.find((it) => (it.fields?.project?.key || it.fields?.project?.name) === pk)?.fields?.project?.name || pk;
        return { key: pk, name, hours: round2(sec / 3600) };
    }).sort((a, b) => b.hours - a.hours);
    const projectDistribution = projectsArr.slice(0, 4).map((p) => ({
        name: p.name,
        hours: p.hours,
        percentage: totalHours > 0 ? Math.round((p.hours / totalHours) * 100) : 0,
    }));

    const heatMap = new Map();
    for (const x of series) {
        const w = weekdayShort(x.date, tz);
        if (w === "Sat" || w === "Sun") continue;
        const wk = isoWeek(x.date);
        const key = `${wk.year}-W${String(wk.week).padStart(2, "0")}`;
        const row = heatMap.get(key) || { year: wk.year, week: wk.week, seg: 0, ter: 0, qua: 0, qui: 0, sex: 0 };
        if (w === "Mon") row.seg += x.hours;
        if (w === "Tue") row.ter += x.hours;
        if (w === "Wed") row.qua += x.hours;
        if (w === "Thu") row.qui += x.hours;
        if (w === "Fri") row.sex += x.hours;
        heatMap.set(key, row);
    }
    const weeklyHeatmap = Array.from(heatMap.entries()).sort(([a], [b]) => a.localeCompare(b)).slice(-6).map(([_, r]) => ({
        week: `Sem ${r.week}`,
        seg: Math.round(r.seg),
        ter: Math.round(r.ter),
        qua: Math.round(r.qua),
        qui: Math.round(r.qui),
        sex: Math.round(r.sex),
    }));

    const catMap = new Map();
    for (const [t, sec] of byTypeSeconds.entries()) {
        const hours = round2(sec / 3600);
        const cat =
            t === "story" ? "Frontend" :
                t === "bug" ? "Testes" :
                    t === "epic" ? "Docs" :
                        "Backend";
        catMap.set(cat, (catMap.get(cat) || 0) + hours);
    }
    const categoryDistribution = Array.from(catMap.entries()).map(([category, hours]) => ({ category, hours: round2(hours) }))
        .sort((a, b) => b.hours - a.hours);

    recent.sort((a, b) => new Date(b.started).getTime() - new Date(a.started).getTime());
    const recentActivity = recent.slice(0, 5).map((x) => ({
        key: x.key,
        title: x.title,
        assignee: x.assignee,
        status: x.status,
        updatedAt: x.started,
        dateLabel: new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(new Date(x.started)),
        hours: x.hours,
    }));

    const cardsDone = cards.filter((c) => c.status === "done").length;
    const avgPerCard = cards.length ? round2(totalHours / cards.length) : 0;
    const teamPerformance = [{
        name: displayName,
        initials: getInitials(displayName),
        totalHours,
        cardsDone,
        avgPerCard,
    }];

    const payload = {
        ok: true,
        cached: false,
        cacheTtlMs: CFG.CACHE_TTL_MS,
        generatedAt: new Date().toISOString(),
        user: { accountId, displayName },

        query: { from, to, tz, q: clamp(q, 2000), mode: String(mode || "auto"), author: String(authorFilter || "auto"), concurrency },
        filters: { extraNormalized: extra, jqlUsed },

        counts: {
            issues: issues.length,
            cardsWithHours: cards.length,
            days: series.length,
            daysWithHours,
            worklogEntriesMatched: recent.length,
        },

        totals: {
            totalHours,
            avgDaily,
            streakAbove7h,
            estimatedHoursRange: estRange,
        },

        series,
        dailyHoursChart,
        monthlyHours,
        cards,
        sprintProgress,
        projectDistribution,
        weeklyHeatmap,
        categoryDistribution,
        recentActivity,
        teamPerformance,
        reviewedCardsChart,
        dailyDetails,
        availableProjects: projectsArr.map((p) => ({ key: p.key, name: p.name })),
    };

    cacheSet(cacheKey, payload);
    return payload;
}

async function fetchProjects(authConfig) {
    const me = await jiraFetch(authConfig, "/rest/api/3/myself");
    const jql = `worklogAuthor = "${me.accountId}" ORDER BY updated DESC`;
    const issues = await searchIssuesByJql(authConfig, jql);
    const projects = new Map();
    for (const issue of issues) {
        const key = issue?.fields?.project?.key;
        const name = issue?.fields?.project?.name || key;
        if (key) projects.set(key, { key, name });
    }
    return Array.from(projects.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ============================ App Express ============================
const app = express();
app.disable("x-powered-by");

function corsHeaders(req) {
    const allowed = CFG.ALLOWED_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
    const origin = req.get("origin") || "";
    let allow = "*";
    if (!allowed.includes("*")) {
        allow = allowed.includes(origin) ? origin : (allowed[0] || "null");
    }
    return {
        "Access-Control-Allow-Origin": allow,
        "Vary": "Origin",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,x-jira-base-url,x-jira-email,x-jira-token",
        "Access-Control-Max-Age": "86400",
    };
}

app.use((req, res, next) => {
    res.set(corsHeaders(req));
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
});

function sendJson(res, status, obj) {
    res.status(status).set("Cache-Control", "no-store").json(obj);
}

const router = express.Router();

router.get("/health", (req, res) => {
    sendJson(res, 200, { ok: true, time: new Date().toISOString() });
});

router.get("/projects", async (req, res) => {
    try {
        const authConfig = authFromRequest(req);
        const projects = await fetchProjects(authConfig);
        sendJson(res, 200, { ok: true, projects });
    } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message || e) });
    }
});

router.get("/hours", async (req, res) => {
    try {
        const { from: defFrom, to: defTo } = defaultRange(CFG.DEFAULT_DAYS);

        const from = clamp(req.query.from || defFrom, 20).slice(0, 10);
        const to = clamp(req.query.to || defTo, 20).slice(0, 10);
        const tz = clamp(req.query.tz || CFG.DEFAULT_TZ, 80) || CFG.DEFAULT_TZ;

        const q = clamp(req.query.q || "", 2000);
        const projectKey = clamp(req.query.project || "all", 40);
        const mode = clamp(req.query.mode || "auto", 10);
        const author = clamp(req.query.author || "auto", 10);
        const concurrency = Math.min(10, Math.max(1, Number(req.query.c || "5")));

        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
            return sendJson(res, 400, { ok: false, error: "Datas invalidas. Use YYYY-MM-DD." });
        }
        if (from > to) {
            return sendJson(res, 400, { ok: false, error: "Data inicial (from) nao pode ser maior que a final (to)." });
        }

        const authConfig = authFromRequest(req);
        const payload = await buildDashboard(authConfig, { from, to, tz, q, mode, authorFilter: author, concurrency, projectKey });
        sendJson(res, 200, payload);
    } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message || e) });
    }
});

// O bohr.io publica a function em `<projeto>.bohr.io/api/*`; dependendo do
// roteamento o path pode chegar com ou sem o prefixo `/api` — registra os dois.
app.use("/", router);
app.use("/api", router);

app.use((req, res) => {
    sendJson(res, 404, { ok: false, error: "Not Found" });
});

if (require.main === module) {
    const PORT = Number(process.env.PORT || "3003");
    app.listen(PORT, () => console.log(`Bohr function local em http://localhost:${PORT}`));
}

module.exports = app;
