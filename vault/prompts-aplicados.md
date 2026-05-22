# 25 Prompts de Andrés — Aplicados a Finanzas PWA

> Fuente: doc compartido "25_Prompts_Esenciales_Claude" por Andres Felipe Garcia
> Adaptados al contexto de Finanzas PWA (Maiky03-kush/finanzas-pwa)
> Copia el prompt, ya tiene el contexto del proyecto rellenado.

---

## USO INMEDIATO — Prompts listos para pegar en Claude

---

### P-09 · The Decision Matrix → ¿Sheets o DB?

```
I need to make a decision about the data backend for Finanzas PWA.

My options are:
1. Keep Google Sheets as the only backend (current state)
2. Add Supabase (PostgreSQL) as the primary DB, Sheets as export/view only
3. Keep Sheets + add IndexedDB as offline cache layer

My priorities (ranked):
1. Zero infrastructure cost (this is a free personal project)
2. Simplicity — one person maintains this, zero DevOps overhead
3. Data reliability — no data loss, no corruption like the shares=0 incident
4. Offline capability — must work without internet on mobile

For each option:
- Score it 1-10 on each priority factor
- List the top 2 risks
- List the top 2 advantages
- Identify what would need to be true for this to be the best choice

Then give me your recommended option with reasoning in 3 sentences.
Do NOT hedge. Pick one and defend it.
```

---

### P-12 · The Data Explainer → Análisis del portafolio

```
Here is my investment portfolio dataset from Google Sheets:
[PASTE THE CSV FROM INVERSIONES SHEET — cols A:K]

Analyze it and give me:
1. The 3 most important trends (with specific numbers)
2. Any anomalies or outliers worth investigating
3. Correlations between variables (if any exist — e.g., invested amount vs return %)
4. What this data suggests I should do next (2-3 recommendations)
5. What this data does NOT tell us (limitations and blind spots — e.g., time horizon, tax implications)

Present findings in two formats:
- 3-sentence executive summary (30 seconds to read)
- Detailed breakdown (5 minutes to read)

If the data is insufficient to draw any conclusion, say so.
```

---

### P-13 · The Process Documenter → SOP de syncFromSheets()

```
I am going to describe a process I do regularly.
Turn it into a structured Standard Operating Procedure.

My process:
When the user logs in via Google OAuth, the app reads two Google Sheets tabs: 
"Inversiones" (columns A:I) and "Compras_Inv" (columns A:F). It then checks 
each investment row — if Acciones (col G) is 0 but Invertido (col E) > 0 and 
PrecioCompra (col H) > 0, it auto-calculates shares = E ÷ H and writes back 
to both sheets. After repair, it recalculates weighted average prices and then 
fetches live prices from Yahoo Finance for any investment with a ticker symbol, 
writing the updated Valor Actual back to column F.

Create an SOP with:
1. Purpose (one sentence — why this process exists)
2. Frequency (how often it runs)
3. Prerequisites (what needs to be in place before starting)
4. Step-by-step procedure (numbered, specific, no ambiguity)
5. Quality checks (how to verify each step was done correctly)
6. Common failure modes and how to recover
7. What NOT to do (anti-patterns that corrupt data)
```

---

### P-14 · The Assumption Destroyer → Arquitectura actual

```
I am planning to continue building Finanzas PWA with Google Sheets as the sole 
backend, vanilla JS (no framework), and Yahoo Finance for live prices.

Here are my assumptions:
1. Google Sheets API will remain free and available for personal use indefinitely
2. Yahoo Finance will continue providing free price data via the current endpoint
3. A single app.js file (~2000 lines) is maintainable by one developer long-term
4. Users (me) will always have Google account access to view their financial data
5. The auto-repair logic (shares = Invertido ÷ PrecioCompra) will always produce correct results

For each assumption:
- Rate how confident I should be (high / medium / low) and why
- Identify what would need to be true for this assumption to hold
- Describe the worst case scenario if this assumption is wrong
- Suggest one quick way to validate or invalidate it before committing

Then identify the 2 assumptions I have NOT listed that pose the biggest hidden risk.
```

---

### P-15 · The Weekly Review Engine → Revisión del proyecto

```
I need to do a weekly review of my Finanzas PWA project.

This week's data:
- Commits: [PASTE git log --oneline desde el lunes]
- Pending items resolved: [listar lo que se completó]
- New bugs found: [listar]
- User feedback (me): [lo que noté al usar la app]

Give me:
1. Progress score: 1-10 with one-sentence reasoning
2. The single most important thing to do next week
3. One thing I should STOP doing (waste of time or wrong direction)
4. One thing I should START doing (not doing it but should be)
5. One decision I've been avoiding that needs to be made

Be direct. No filler. If I'm making a mistake, name it.
```

---

### P-22 · The Reverse Brainstorm → Qué puede romper el auto-repair

```
Instead of brainstorming how to make the Finanzas PWA auto-repair feature succeed,
brainstorm all the ways it could catastrophically fail.

The feature: when syncFromSheets() detects shares=0 but Invertido>0 and PrecioCompra>0,
it calculates shares = Invertido ÷ PrecioCompra and writes back to both Inversiones 
and Compras_Inv sheets.

Generate 10 specific ways this feature could destroy user financial data.
For each failure mode:
- Describe exactly what goes wrong
- Rate the severity (data loss / wrong numbers / silent corruption / UX confusion)
- Identify the trigger condition

Then reverse each into a defensive measure or validation I should implement.
```

---

### P-23 · The Pre-Mortem → Antes del próximo release

```
We are about to release [FEATURE: e.g., "Dashboard de resumen del portafolio" / 
"Historial de precios" / "Offline-first con IndexedDB"] to production for Finanzas PWA.

It is 3 months from now and this release has caused a serious problem.
What went wrong?

Generate 8 specific failure scenarios, covering:
- Data corruption or loss
- Performance issues on mobile
- Auth/OAuth edge cases
- Sheets API quota or permission errors
- Service Worker cache conflicts
- UI bugs that show wrong financial data to the user

For each scenario:
- Describe the failure in detail
- Rate the probability (1-5)
- Rate the user impact (1-5)
- Name the one thing we should test before releasing to prevent this
```

---

### P-25 · The Personal Board of Advisors → Dirección del producto

```
I am facing this situation:
Finanzas PWA is a personal finance tracker that works well for my own use. 
I'm deciding whether to keep it strictly personal (single user, always free, 
optimize for my exact workflow) or expand it to support multiple users 
(friends/family) which would require auth per user, isolated Sheet data, 
possible monetization, more maintenance.

Analyze this from 5 perspectives:

1. The pragmatic operator — cares only about what works, ignores theory
2. The skeptical investor — sees every risk, questions every assumption
3. The creative strategist — finds unconventional angles everyone else misses
4. The customer/user — does not care about my problems, only their experience
5. The long-term thinker — ignores short-term pain, focuses on where this leads

For each perspective, give 2-3 sentences of analysis and one concrete recommendation.
End with a synthesis: given all 5 perspectives, what is the one decision that 
satisfies the most constraints?
```

---

## PROMPTS DE DESARROLLO DIARIO

Estos van directo en el chat cuando trabajas en el código:

---

### P-DEV-01 · Antes de tocar app.js

```
Before we make any changes to app.js in Finanzas PWA, I need you to:
1. Read the current state of vault/PROJECT.md
2. Read the specific function I'm about to modify: [FUNCTION NAME]
3. Identify all other functions that call it or are called by it
4. List the 3 biggest risks of modifying this function
5. Confirm you understand the data flow before we write any code

Do NOT write any code yet. Just confirm your understanding.
```

---

### P-DEV-02 · Code Review de un cambio

```
Review this change to Finanzas PWA's app.js:

[PASTE THE DIFF]

Check for:
1. Data corruption risk — could this break the shares calculation or overwrite H column?
2. Service Worker incompatibility — does this require a cache version bump?
3. Google Sheets API quota — could this trigger more API calls than expected?
4. Offline behavior — does this work correctly when navigator.onLine is false?
5. Mobile UX — is there any blocking operation that would freeze the UI?

For each issue found: severity (critical / warning / suggestion) + one-line fix.
```

---

### P-DEV-03 · Debug de dato incorrecto

```
In Finanzas PWA, I'm seeing incorrect data:

Investment: [NAME/TICKER]
Expected: [WHAT I EXPECT TO SEE]
Actual: [WHAT I'M SEEING]
Last known good state: [WHEN IT WORKED CORRECTLY]

The data flow is: Yahoo Finance → app.js (refreshInvestmentPrices) → Google Sheets (col F) → UI render.

Trace through this flow and identify:
1. Where the incorrect value is most likely introduced
2. What console.log statements I should add to confirm
3. What data in the sheet I should inspect manually
4. The most likely root cause given the auto-repair incident history

Give me a debugging plan, not a fix. I'll verify first.
```

---

## PROMPTS DE ESTRATEGIA (usar 1x por semana)

| # | Prompt | Cuándo usar |
|---|--------|-------------|
| P-09 | Decision Matrix | Antes de cualquier decisión de arquitectura |
| P-14 | Assumption Destroyer | Antes de comprometerse con una feature grande |
| P-15 | Weekly Review | Cada domingo, 5 minutos |
| P-22 | Reverse Brainstorm | Antes de tocar flows críticos (sync, auto-repair) |
| P-23 | Pre-Mortem | Antes de cada release con cambios en el SW o data model |
| P-25 | Board of Advisors | Cuando hay una decisión de producto sin respuesta obvia |
