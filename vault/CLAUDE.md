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

## Reglas de Trabajo

1. **Leer PROJECT.md antes de tocar código** — tiene el estado actual y pendientes
2. **Service Worker**: al cambiar lógica de cache → incrementar versión en sw.js (`finanzas-v7`, etc.)
3. **Google Sheets**: invArr() devuelve SOLO columnas A:I — nunca agregar Ganancia$ ni Ganancia% (son ARRAYFORMULA en J:K)
4. **Auto-repair**: la lógica en syncFromSheets() es crítica — nunca modificar sin entender el flujo E÷H
5. **Sin frameworks**: no agregar React, Vue, npm build steps. El bundle es el source.

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
