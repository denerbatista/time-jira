import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

/**
 * Jira Hours Dashboard (Backend) - no deps
 *
 * Serves:
 *   GET /            -> static HTML file (separate)
 *   GET /api/hours   -> JSON used by the dashboard
 *   GET /health      -> ok
 *
 * Required env:
 *   JIRA_BASE_URL=https://<site>.atlassian.net
 *   JIRA_EMAIL=<email>
 *   JIRA_API_TOKEN=<token>
 *
 * Optional env:
 *   PORT=3000
 *   DEFAULT_TZ=America/Sao_Paulo
 *   DEFAULT_DAYS=30
 *   CACHE_TTL_MS=120000
 *   FRONTEND_FILE=./jira-hours-dashboard.html
 */

const PORT = Number(process.env.PORT || "3002");
const BASE_URL = String(process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
const EMAIL = String(process.env.JIRA_EMAIL || "");
const API_TOKEN = String(process.env.JIRA_API_TOKEN || "");

const DEFAULT_TZ = String(process.env.DEFAULT_TZ || "America/Sao_Paulo");
const DEFAULT_DAYS = Number(process.env.DEFAULT_DAYS || "30");
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || "120000");

const FRONTEND_FILE = process.env.FRONTEND_FILE
    ? path.resolve(process.env.FRONTEND_FILE)
    : path.resolve(process.cwd(), "index.html");

if (!BASE_URL || !EMAIL || !API_TOKEN) {
    console.error("Missing env vars. Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN.");
    process.exit(1);
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const AUTH = `Basic ${b64(`${EMAIL}:${API_TOKEN}`)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (s, max = 4000) => String(s ?? "").trim().slice(0, max);

function isoDate(d) { return d.toISOString().slice(0, 10); }
function defaultRange(days = DEFAULT_DAYS) {
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

function safeNum(x, d=0){ const n=Number(x); return Number.isFinite(n)?n:d; }
function round2(n){ return Math.round(n*100)/100; }

function dateKeyInTZ(dateTimeStr, tz) {
    const d = new Date(dateTimeStr);
    return d.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
}
function weekdayShort(dateStr, tz) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d); // Mon, Tue...
}
function toDayLabelPtBR(dateStr, tz) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    return new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(d);
}
function monthLabelPtBR(yyyyMm) {
    const [y, m] = yyyyMm.split("-").map((v) => parseInt(v, 10));
    const d = new Date(Date.UTC(y, (m || 1) - 1, 15));
    return new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(d).replace(".", "").replace(/^\w/, c => c.toUpperCase());
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
    let y=y0, m=(m0||1)+delta;
    while (m<=0){ m+=12; y-=1; }
    while (m>12){ m-=12; y+=1; }
    return `${y}-${String(m).padStart(2,"0")}`;
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
function businessDaysInSeries(series, tz){
    let bd=0;
    for (const x of series){
        const w = weekdayShort(x.date, tz);
        if (w==="Sat" || w==="Sun") continue;
        bd += 1;
    }
    return bd;
}
function getInitials(name){
    const parts = String(name||"").trim().split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] || "?";
    const b = parts.length>1 ? parts[parts.length-1][0] : "";
    return (a+b).toUpperCase();
}
function mapType(name){
    const s=String(name||"").toLowerCase();
    if (s.includes("bug") || s.includes("erro")) return "bug";
    if (s.includes("epic") || s.includes("épico") || s.includes("epico")) return "epic";
    if (s.includes("story") || s.includes("hist")) return "story";
    return "task";
}
function mapPriority(name){
    const s=String(name||"").toLowerCase();
    if (s.includes("highest") || s.includes("high") || s.includes("alta")) return "high";
    if (s.includes("low") || s.includes("baixa") || s.includes("lowest")) return "low";
    return "medium";
}
function mapStatus(fieldsStatus){
    const name = String(fieldsStatus?.name||"").toLowerCase();
    const cat = String(fieldsStatus?.statusCategory?.key||"").toLowerCase(); // new, indeterminate, done
    if (name.includes("review") || name.includes("revis")) return "review";
    if (cat==="done") return "done";
    if (cat==="new") return "todo";
    return "in_progress";
}

async function jiraFetch(urlPath, { method="GET", headers={}, body } = {}) {
    const url = `${BASE_URL}${urlPath}`;
    const res = await fetch(url, {
        method,
        headers: { Authorization: AUTH, Accept: "application/json", ...headers },
        body,
    });

    if (res.status === 429) {
        const retryAfter = safeNum(res.headers.get("retry-after"), 2);
        await sleep(Math.max(1, retryAfter) * 1000);
        return jiraFetch(urlPath, { method, headers, body });
    }

    const text = await res.text().catch(()=> "");
    if (!res.ok) throw new Error(`Jira API ${res.status} ${res.statusText} em ${urlPath}\n${text}`);

    try { return JSON.parse(text || "{}"); } catch { return {}; }
}

async function searchIssuesByJql(jql) {
    const issues = [];
    let nextPageToken = undefined;

    while (true) {
        const payload = {
            jql,
            fields: ["project","summary","status","priority","issuetype","assignee","timetracking","updated","created"],
            maxResults: 200,
            ...(nextPageToken ? { nextPageToken } : {}),
        };

        const page = await jiraFetch("/rest/api/3/search/jql", {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify(payload),
        });

        for (const it of page.issues || []) issues.push(it);
        nextPageToken = page.nextPageToken;
        if (!nextPageToken) break;
    }
    return issues;
}

async function fetchAllWorklogs(issueKey) {
    const all = [];
    let startAt=0;
    const maxResults=100;
    while (true) {
        const page = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog?startAt=${startAt}&maxResults=${maxResults}`);
        const worklogs = page.worklogs || [];
        all.push(...worklogs);
        startAt += worklogs.length;
        const total = safeNum(page.total, all.length);
        if (startAt >= total || worklogs.length === 0) break;
    }
    return all;
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

function isLikelyWorklogAuthorJqlError(msg){
    const s = String(msg||"");
    return /worklogAuthor/i.test(s) || /Erro na consulta JQL/i.test(s);
}

// Simple in-memory cache
const cache = new Map(); // key -> { at, payload }
function cacheGet(key){
    const it = cache.get(key);
    if (!it) return null;
    if (Date.now() - it.at > CACHE_TTL_MS) { cache.delete(key); return null; }
    return it.payload;
}
function cacheSet(key, payload){ cache.set(key, { at: Date.now(), payload }); }

function computeStreak(series, minHours=7){
    let streak=0;
    for (let i=series.length-1;i>=0;i--){
        if (series[i].hours >= minHours) streak += 1;
        else break;
    }
    return streak;
}

async function buildDashboard({ from, to, tz, q, mode, authorFilter, concurrency }) {
    const cacheKey = JSON.stringify({ from, to, tz, q, mode, authorFilter, concurrency });
    const cached = cacheGet(cacheKey);
    if (cached) return { ...cached, cached: true };

    const me = await jiraFetch("/rest/api/3/myself");
    const accountId = me?.accountId;
    const displayName = me?.displayName || EMAIL;
    if (!accountId) throw new Error("Não consegui obter accountId em /rest/api/3/myself");

    const extra = normalizeExtraFilter(q, mode);
    let baseJql = `worklogDate >= "${from}" AND worklogDate <= "${to}"`;
    if (extra) baseJql = `${baseJql} AND (${extra})`;

    let jqlUsed = baseJql;
    let issues = [];
    const af = String(authorFilter || "auto").toLowerCase();
    if (af === "on") {
        jqlUsed = `worklogAuthor = "${accountId}" AND ${baseJql}`;
        issues = await searchIssuesByJql(jqlUsed);
    } else if (af === "off") {
        issues = await searchIssuesByJql(jqlUsed);
    } else {
        try {
            jqlUsed = `worklogAuthor = "${accountId}" AND ${baseJql}`;
            issues = await searchIssuesByJql(jqlUsed);
        } catch (e) {
            if (!isLikelyWorklogAuthorJqlError(e?.message)) throw e;
            jqlUsed = baseJql;
            issues = await searchIssuesByJql(jqlUsed);
        }
    }

    const days = eachDay(from, to);
    const byDaySeconds = new Map(days.map(d => [d, 0]));
    const byIssueSeconds = new Map();     // key -> seconds
    const byProjectSeconds = new Map();   // project -> seconds
    const byTypeSeconds = new Map();      // type -> seconds
    const recent = [];                   // worklog-level entries

    const issueMeta = new Map(); // key -> meta used for cards

    await pMap(issues, concurrency, async (issue) => {
        const key = issue?.key;
        if (!key) return;

        const f = issue.fields || {};
        const projectKey = f.project?.key || f.project?.name || "Sem projeto";
        const projectName = f.project?.name || projectKey;
        const summary = f.summary || key;

        issueMeta.set(key, {
            key,
            title: summary,
            project: projectName,
            projectKey,
            status: mapStatus(f.status),
            priority: mapPriority(f.priority?.name),
            type: mapType(f.issuetype?.name),
            assignee: f.assignee?.displayName || displayName,
            avatarInitials: getInitials(f.assignee?.displayName || displayName),
            estimatedSeconds: safeNum(f.timetracking?.originalEstimateSeconds, 0),
            createdAt: f.created || "",
            updatedAt: f.updated || "",
        });

        const worklogs = await fetchAllWorklogs(key);
        for (const wl of worklogs) {
            if (wl?.author?.accountId !== accountId) continue;

            const started = wl.started;
            const sec = safeNum(wl.timeSpentSeconds, 0);
            if (!started || sec <= 0) continue;

            const day = dateKeyInTZ(started, tz);
            if (day < from || day > to) continue;

            byDaySeconds.set(day, (byDaySeconds.get(day) || 0) + sec);
            byIssueSeconds.set(key, (byIssueSeconds.get(key) || 0) + sec);
            byProjectSeconds.set(projectKey, (byProjectSeconds.get(projectKey) || 0) + sec);

            const t = mapType(f.issuetype?.name);
            byTypeSeconds.set(t, (byTypeSeconds.get(t) || 0) + sec);

            recent.push({
                started,
                key,
                title: summary,
                seconds: sec,
                hours: round2(sec / 3600),
                status: mapStatus(f.status),
                assignee: f.assignee?.displayName || displayName,
                updatedAt: f.updated || "",
            });
        }
    });

    const series = days.map((d) => {
        const seconds = byDaySeconds.get(d) || 0;
        return { date: d, seconds, hours: round2(seconds / 3600) };
    });

    const totalHours = round2(series.reduce((s, x) => s + x.hours, 0));
    const daysWithHours = series.filter(x => x.hours > 0).length;
    const avgDaily = series.length ? round2(totalHours / series.length) : 0;
    const streakAbove7h = computeStreak(series, 7);

    // Daily chart: last 14 business days
    const weekdays = series.filter(x => !["Sat","Sun"].includes(weekdayShort(x.date, tz)));
    const last14 = weekdays.slice(Math.max(0, weekdays.length - 14));
    const dailyHoursChart = last14.map(x => ({ day: toDayLabelPtBR(x.date, tz), logged: x.hours, estimated: 8 }));

    // Monthly chart: last 6 months ending at `to`
    const toYm = to.slice(0,7);
    const months = Array.from({length:6}, (_,i)=> addMonths(toYm, -5+i));
    const byMonth = new Map();
    for (const x of series) {
        const ym = x.date.slice(0,7);
        byMonth.set(ym, (byMonth.get(ym) || 0) + x.hours);
    }
    const monthlyHours = months.map((ym) => {
        const monthDays = series.filter(x => x.date.startsWith(ym));
        const bd = monthDays.filter(x => !["Sat","Sun"].includes(weekdayShort(x.date, tz))).length;
        const estimated = bd * 8;
        const logged = round2(byMonth.get(ym) || 0);
        const overtime = Math.max(0, round2(logged - estimated));
        return { month: monthLabelPtBR(ym), logged, estimated, overtime };
    });

    // Cards: top 20 by logged hours
    const cards = Array.from(byIssueSeconds.entries()).map(([k, sec]) => {
        const meta = issueMeta.get(k) || { key: k, title: k, project: "—", status:"todo", priority:"medium", type:"task", assignee: displayName, avatarInitials:getInitials(displayName), estimatedSeconds:0, createdAt:"", updatedAt:"" };
        return {
            id: k,
            key: k,
            title: meta.title,
            status: meta.status,
            assignee: meta.assignee,
            avatarInitials: meta.avatarInitials,
            sprint: "Período selecionado",
            estimatedHours: round2(meta.estimatedSeconds / 3600),
            loggedHours: round2(sec / 3600),
            project: meta.project,
            priority: meta.priority,
            type: meta.type,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
        };
    }).sort((a,b)=> b.loggedHours - a.loggedHours).slice(0, 20);

    // Sprint progress: estimate = business days in range * 8h
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

    // Project distribution: top 4
    const projectsArr = Array.from(byProjectSeconds.entries()).map(([pk, sec]) => {
        const name = issues.find(it => (it.fields?.project?.key || it.fields?.project?.name) === pk)?.fields?.project?.name || pk;
        return { key: pk, name, hours: round2(sec / 3600) };
    }).sort((a,b)=> b.hours - a.hours);
    const projectDistribution = projectsArr.slice(0,4).map(p => ({
        name: p.name,
        hours: p.hours,
        percentage: totalHours > 0 ? Math.round((p.hours / totalHours) * 100) : 0,
    }));

    // Weekly heatmap: last 6 ISO weeks
    const heatMap = new Map();
    for (const x of series) {
        const w = weekdayShort(x.date, tz);
        if (w==="Sat" || w==="Sun") continue;
        const wk = isoWeek(x.date);
        const key = `${wk.year}-W${String(wk.week).padStart(2,"0")}`;
        const row = heatMap.get(key) || { year:wk.year, week:wk.week, seg:0, ter:0, qua:0, qui:0, sex:0 };
        if (w==="Mon") row.seg += x.hours;
        if (w==="Tue") row.ter += x.hours;
        if (w==="Wed") row.qua += x.hours;
        if (w==="Thu") row.qui += x.hours;
        if (w==="Fri") row.sex += x.hours;
        heatMap.set(key, row);
    }
    const weeklyHeatmap = Array.from(heatMap.entries()).sort(([a],[b])=> a.localeCompare(b)).slice(-6).map(([_, r]) => ({
        week: `Sem ${r.week}`,
        seg: Math.round(r.seg),
        ter: Math.round(r.ter),
        qua: Math.round(r.qua),
        qui: Math.round(r.qui),
        sex: Math.round(r.sex),
    }));

    // Category distribution (radar): derived from issue types (heuristic)
    const catMap = new Map();
    for (const [t, sec] of byTypeSeconds.entries()) {
        const hours = round2(sec / 3600);
        const cat =
            t === "story" ? "Frontend" :
                t === "bug"   ? "Testes" :
                    t === "epic"  ? "Docs" :
                        "Backend";
        catMap.set(cat, (catMap.get(cat) || 0) + hours);
    }
    const categoryDistribution = Array.from(catMap.entries()).map(([category, hours]) => ({ category, hours: round2(hours) }))
        .sort((a,b)=> b.hours - a.hours);

    // Recent activity (last 5 worklogs)
    recent.sort((a,b)=> new Date(b.started).getTime() - new Date(a.started).getTime());
    const recentActivity = recent.slice(0,5).map((x) => ({
        key: x.key,
        title: x.title,
        assignee: x.assignee,
        status: x.status,
        updatedAt: x.started,
        dateLabel: new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day:"2-digit", month:"2-digit" }).format(new Date(x.started)),
        hours: x.hours,
    }));

    // Team performance: single user
    const cardsDone = cards.filter(c => c.status === "done").length;
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
        cacheTtlMs: CACHE_TTL_MS,
        generatedAt: new Date().toISOString(),
        user: { accountId, displayName },

        query: { from, to, tz, q: clamp(q, 2000), mode: String(mode||"auto"), author: String(authorFilter||"auto"), concurrency },
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
    };

    cacheSet(cacheKey, payload);
    return payload;
}

function sendJson(res, status, obj) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(obj));
}

async function sendFile(res, filePath, contentType) {
    const buf = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    res.end(buf);
}

const server = http.createServer(async (req, res) => {
    try {
        const u = new URL(req.url, `http://localhost:${PORT}`);

        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET,OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
            });
            res.end();
            return;
        }

        if (u.pathname === "/health") {
            sendJson(res, 200, { ok: true, time: new Date().toISOString() });
            return;
        }

        if (u.pathname === "/api/hours") {
            const { from: defFrom, to: defTo } = defaultRange(DEFAULT_DAYS);

            const from = clamp(u.searchParams.get("from") || defFrom, 20).slice(0, 10);
            const to = clamp(u.searchParams.get("to") || defTo, 20).slice(0, 10);
            const tz = clamp(u.searchParams.get("tz") || DEFAULT_TZ, 80) || DEFAULT_TZ;

            const q = clamp(u.searchParams.get("q") || "", 2000);
            const mode = clamp(u.searchParams.get("mode") || "auto", 10);
            const author = clamp(u.searchParams.get("author") || "auto", 10);
            const concurrency = Math.min(10, Math.max(1, Number(u.searchParams.get("c") || "5")));

            if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
                sendJson(res, 400, { ok: false, error: "Datas inválidas. Use YYYY-MM-DD." });
                return;
            }
            if (from > to) {
                sendJson(res, 400, { ok: false, error: "Data inicial (from) não pode ser maior que a final (to)." });
                return;
            }

            const payload = await buildDashboard({ from, to, tz, q, mode, authorFilter: author, concurrency });
            sendJson(res, 200, payload);
            return;
        }

        if (u.pathname === "/" || u.pathname === "/index.html" || u.pathname === "/dashboard") {
            await sendFile(res, FRONTEND_FILE, "text/html; charset=utf-8");
            return;
        }

        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
    } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message || e) });
    }
});

server.listen(PORT, () => {
    console.log(`✅ Jira Hours Dashboard: http://localhost:${PORT}`);
    console.log(`   Frontend: ${FRONTEND_FILE}`);
    console.log(`   API: GET /api/hours?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=America/Sao_Paulo&q=mps&mode=auto&author=auto&c=5`);
});
