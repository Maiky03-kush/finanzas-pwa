# Finanzas PWA — Backlog de Ingeniería

**Actualizado**: 2026-06-16
**Metodología**: Prioridad por impacto en usuario real + deuda técnica acumulada

---

## PLAN DE MEJORA 30/60/90 DÍAS (Junio 2026)

> Ver `vault/decisions/ADR-002-ui-design-system.md` para decisiones de diseño.

### 30 días — UI Polish
- [x] **P30-01**: Tipografía financiera monospaced + tabular nums (`font-variant-numeric`)
- [x] **P30-02**: Microanimaciones Emil Kowalski en precios (ease-out 150ms, scale 1.02)
- [x] **P30-03**: Investment cards con accent stripe P&L + Taste-Skill card design
- [x] **P30-04**: Tooltips sin delay (150ms ease-out)
- [x] **P30-05**: 8px spacing grid CSS variables
- [ ] **P30-06**: Cards responsivas con Taste-Skill en modo tablet/desktop
- [ ] **P30-07**: Tipografía base — revisar jerarquía en todas las vistas (dashboard, gastos)

### 60 días — Funcionalidad
- [ ] **P60-01**: Integrar LLM (Claude) para análisis automático del portfolio: alertas de variación, resumen diario
- [ ] **P60-02**: Sistema de alertas push cuando inversión sube/baja X% (umbral configurable)
- [ ] **P60-03**: Cache offline para datos históricos de Yahoo Finance
- [ ] **P60-04**: Dashboard de rendimiento histórico con gráficas (canvas nativo)

### 90 días — Inteligencia
- [ ] **P90-01**: Resumen automático semanal del portfolio
- [ ] **P90-02**: Detección de anomalías en portfolio
- [ ] **P90-03**: Exportación PDF de reporte mensual
- [ ] **P90-04**: Auditoría de seguridad OAuth GIS y Google Sheets scopes

---

---

## CRÍTICO — Verificaciones Post-Deploy v6

### V-01: Verificar auto-repair en dispositivo real
**Prioridad**: P0 | **Esfuerzo**: 30min

- [ ] Abrir app en Android con v6 (limpiar caché si necesario: Ajustes → Borrar datos del sitio)
- [ ] Conectar Google → sync → confirmar que auto-repair corrige shares en el sheet
- [ ] Verificar Inversiones!J:K muestran ganancia real (sin `#ERROR!`)
- [ ] Verificar que Valor Actual se actualiza con precios en vivo automáticamente

**Definition of Done**: columna G tiene shares calculados, J:K muestran números reales

---

### V-02: Resolver SCHD y ETH-USD con invested=0
**Prioridad**: P0 | **Esfuerzo**: 10min usuario

- [ ] Abrir ✏️ en cada lote de SCHD y registrar monto invertido (amountUSD)
- [ ] Abrir ✏️ en cada lote de ETH-USD y registrar monto invertido
- [ ] Verificar que auto-repair recalcula correctamente tras el fix manual

**Nota**: el auto-repair no puede inferir amountUSD si es 0 — requiere intervención manual.

---

## MEJORAS — Corto Plazo (1-2 semanas)

### M-01: Formato condicional en Sheet para filas vacías
**Prioridad**: P2 | **Esfuerzo**: 15min (Google Sheets, no código)

Las columnas J:K muestran `0` en filas sin datos por el ARRAYFORMULA.

- [ ] Agregar formato condicional en Google Sheets: si E=0 → fuente blanca (oculta el cero)
- [ ] Alternativa en fórmula: `=ARRAYFORMULA(IF(F2:F="","",F2:F-E2:E))`

---

### M-02: Dashboard de resumen del portafolio
**Prioridad**: P1 | **Esfuerzo**: 2-3 días

Actualmente no hay vista agregada. Agregar panel superior con:
- [ ] Total invertido (suma de col E)
- [ ] Valor actual total (suma de col F)
- [ ] Ganancia total $ y % (calculada en cliente)
- [ ] Gráfico de distribución por tipo (acciones / cripto / ETF / etc.)

---

### M-03: Historial de precios por ticker
**Prioridad**: P2 | **Esfuerzo**: 3-4 días

- [ ] Al abrir detalle de inversión → mini chart de precio histórico (30d / 90d)
- [ ] Usar Yahoo Finance history endpoint
- [ ] Renderizar con canvas nativo o SVG (sin librería de charts)

---

### M-04: Offline-first completo
**Prioridad**: P1 | **Esfuerzo**: 2 días

- [ ] Cachear último estado de inversiones en IndexedDB
- [ ] Mostrar datos cacheados mientras no hay conexión
- [ ] Banner "Datos del [fecha]" cuando se opera offline
- [ ] Cola de escrituras pendientes → sync cuando vuelve conexión

---

### M-05: Múltiples divisas
**Prioridad**: P2 | **Esfuerzo**: 2-3 días

- [ ] Agregar columna divisa en Inversiones sheet
- [ ] Tasas de cambio: USD/COP, USD/EUR vía free FX API
- [ ] Vista: toggle entre USD y moneda local

---

## DEUDA TÉCNICA

| Item | Impacto | Esfuerzo | Prioridad |
|------|---------|---------|-----------|
| app.js es un monolito (~2000 líneas) | Mantenibilidad | Alto | P3 |
| Sin tests automáticos | Confianza en refactors | Alto | P2 |
| Precios Yahoo Finance sin fallback | Disponibilidad | Bajo | P2 |
| Token Google expira silenciosamente | UX | Bajo | P1 |
| No hay manejo de rate limits en Sheets API | Estabilidad | Medio | P2 |

---

## DECISIONES TÉCNICAS PENDIENTES

- [ ] ¿Separar app.js en módulos ES6? (ver `vault/decisions/ADR-001-modularizacion.md`)
- [ ] ¿Agregar Supabase como fallback/mirror de Sheets? (ver `vault/decisions/ADR-002-sheets-vs-db.md`)
- [ ] ¿Implementar PWA share target para agregar inversiones desde otras apps?
- [ ] ¿Notificaciones push cuando una inversión sube/baja X%?

---

## IDEAS FUTURAS (no comprometidas)

- Exportar PDF del portafolio con resumen mensual
- Comparar rendimiento vs índice de referencia (SPY, BTC)
- Alertas de precio configurables (WebPush)
- Import CSV de broker (Binance, Interactive Brokers)
