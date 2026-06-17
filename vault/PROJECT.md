# Finanzas PWA — Contexto del Proyecto

> Leído por Claude Code al inicio de cada sesión. Actualizar con /TLDR después de cada sesión.

## Descripción

**Finanzas PWA** es una Progressive Web App personal de gestión financiera que usa Google Sheets como backend/base de datos y Google OAuth para autenticación. Permite rastrear inversiones con precios en vivo vía Yahoo Finance, gestionar lotes de compra, y visualizar ganancias en tiempo real.

**Creado**: 2026
**Última sesión**: 2026-06-16
**Último commit**: (ver git log)

## Estado Actual

- **Fase**: PRODUCCIÓN ACTIVA — iteración continua
- **Deploy**: Railway (auto-deploy en push a master) → finanzas-pwa-production.up.railway.app
- **Service Worker**: finanzas-v6
- **Sheet versión**: finanzas_formulas_v2
- **Backend (Sheets)**: Operativo con ARRAYFORMULA en J:K
- **Auto-repair**: Activo — calcula shares = Invertido ÷ PrecioCompra
- **Auto-refresh precios**: Activo — corre al login si hay tickers

## Stack

- **Frontend**: Vanilla JS + HTML + CSS (PWA, sin frameworks)
- **Backend**: Google Sheets API v4 (Google Sheets como DB)
- **Auth**: Google OAuth 2.0 (token via GIS)
- **Precios**: Yahoo Finance (yfinance proxy / fetch directo)
- **Deploy**: Railway (Node.js server.js)
- **Cache**: Service Worker (Cache API)

## Arquitectura de Datos

### Hoja: `Inversiones`
| Col | Nombre | Tipo | Gestor |
|-----|--------|------|--------|
| A | ID | Fuente | App escribe |
| B | Nombre | Fuente | App escribe |
| C | Ticker | Fuente | App escribe |
| D | Tipo | Fuente | App escribe |
| E | Invertido $ | Fuente | App escribe (suma de lotes) |
| F | Valor Actual $ | Operacional | App escribe (shares × precio vivo) |
| G | Acciones | Operacional | App escribe (suma lotes / auto-repair E÷H) |
| H | Precio Compra $ | **Fuente clave** | App escribe (promedio ponderado) ← base auto-repair |
| I | Notas | Fuente | App escribe |
| J | Ganancia $ | Fórmula | `=ARRAYFORMULA(F:F-E:E)` |
| K | Ganancia % | Fórmula | `=ARRAYFORMULA((F-E)/(E+(E=0))*100)` |

### Hoja: `Compras_Inv`
| Col | Nombre | Detalle |
|-----|--------|---------|
| A | ID | PK |
| B | InvID | FK → Inversiones.A |
| C | Fecha | ISO date |
| D | Acciones | amountUSD ÷ priceUSD |
| E | PrecioUSD | Precio unitario al comprar |
| F | MontoUSD | Monto total en USD |

## Flows Críticos

### syncFromSheets()
1. Lee Inversiones (A:I) y Compras_Inv (A:F)
2. **Auto-repair**: si Acciones=0 pero Invertido>0 y PrecioCompra>0 → shares = E÷H
3. Escribe valores corregidos a ambas hojas
4. Llama recalcInvestment() para promedios ponderados

### handleTokenResponse() → Login
1. Sync desde sheets
2. **refreshInvestmentPrices()** en background (solo si hay tickers)
3. Escribe Valor Actual actualizado al sheet

### Modal "Editar Inversión"
- **Con ticker**: panel read-only (precio vivo, acciones, invertido, ganancia = shares × marketPrice)
- **Sin ticker**: campos editables para valor actual e invertido
- Banner ⚠️ cuando shares=0 con botón "Corregir" al lote

## Repo

- **GitHub**: Maiky03-kush/finanzas-pwa
- **Rama principal**: master
- **Deploy**: push a master → Railway auto-deploy

## Pendientes Activos (post sesión 2026-06-16)

### Plan de Mejora 30/60/90 días — en ejecución
- [x] **UI-01** — 30-day UI Polish: tipografía financiera (tabular nums), microanimaciones (Emil Kowalski), card design (Taste-Skill) → `ADR-002-ui-design-system.md`
- [ ] **UI-02** — Completar P30-06 y P30-07 (cards tablet + tipografía base en todas las vistas)
- [ ] **UI-03** — Iniciar 60-day: integración LLM + alertas push

### Pendientes Pre-Plan (de sesión 2026-05-16)
- [ ] **A** — Verificar auto-repair en dispositivo real: sync v6 debe corregir shares y escribir al sheet
- [ ] **B** — SCHD y ETH-USD tienen invested=0 → usuario debe abrir ✏️ en cada lote y registrar monto
- [ ] **C** — Fórmulas J/K muestran 0 en filas vacías (estético) → resolver con formato condicional en sheet

## Principios del Proyecto

1. Google Sheets es la fuente de verdad — la columna H (Precio Compra) es sagrada
2. Sin frameworks — vanilla JS para mantener el bundle mínimo y el SW simple
3. Auto-repair no destruye datos — siempre usa E÷H, nunca sobreescribe H
4. Service Worker bump en cada breaking change de cache
