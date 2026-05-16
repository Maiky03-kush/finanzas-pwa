# CLAUDE.md — Finanzas PWA

> Leído automáticamente por Claude Code al abrir D:\Proyectos\Finazas\

## Qué es este proyecto

PWA personal de finanzas personales. Google Sheets es el backend/DB. Vanilla JS, sin frameworks, desplegado en Railway. Lee `vault/PROJECT.md` para contexto completo de estado actual.

## Estructura del Repo

```
app.js          ← toda la lógica de la app (monolito intencional)
index.html      ← UI principal
styles.css      ← estilos
sw.js           ← Service Worker (bump la versión en cada breaking change)
server.js       ← Node.js server para Railway
manifest.json   ← PWA manifest
vault/          ← documentación y contexto del proyecto
  PROJECT.md          ← estado actual (leer primero)
  CLAUDE.md           ← este archivo
  backlog.md          ← backlog de ingeniería
  prompts-aplicados.md ← prompts de Claude adaptados al proyecto
  decisions/          ← ADRs
  sessions/           ← resúmenes de sesión (/TLDR)
```

## LEER ANTES DE TOCAR CÓDIGO

1. `vault/PROJECT.md` — estado actual, pendientes, arquitectura de datos
2. `vault/backlog.md` — qué está en cola y qué es P0

## Reglas No Negociables

1. **Service Worker**: cualquier cambio en lógica de cache → incrementar versión en `sw.js` (`finanzas-v7`, `v8`…)
2. **Google Sheets**: `invArr()` devuelve SOLO columnas A:I — las columnas J:K son ARRAYFORMULA en el sheet, la app nunca escribe ahí
3. **Columna H sagrada**: `PrecioCompra` (col H) es la fuente de verdad del auto-repair — nunca sobrescribir
4. **Auto-repair es defensivo**: la lógica `shares = Invertido ÷ PrecioCompra` solo actúa cuando `Acciones=0`, `Invertido>0`, `PrecioCompra>0`
5. **Sin frameworks**: no agregar React, Vue, build steps. El bundle ES el source.

## Stack de Contexto por Archivo

| Archivo | Qué hace | Tocar con cuidado |
|---------|----------|-------------------|
| `app.js` | Todo: auth, sync, precios, modales, render | Sí — leer completo antes de editar |
| `sw.js` | Cache estrategia + versión | Bump versión al cambiar |
| `server.js` | Serve estático en Railway | Raramente cambia |
| `manifest.json` | PWA metadata | Solo para cambios de app identity |

## APIs Externas

- **Google Sheets API v4** — lectura/escritura de inversiones
- **Google Identity Services (GIS)** — OAuth token
- **Yahoo Finance** — precios en vivo por ticker

## Idioma

- Código: inglés (variables, funciones, comentarios técnicos)
- Documentación vault/: español
- Commits: inglés (feat/fix/refactor convencional)

## Al terminar cada sesión

Ejecutar `/TLDR` para generar el resumen en `vault/sessions/YYYY-MM-DD.md` y actualizar `vault/PROJECT.md`.
