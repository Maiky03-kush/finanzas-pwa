# ADR-002 — Sistema de Diseño UI (30-Day Polish)

**Fecha**: 2026-06-16
**Estado**: Aceptada
**Contexto**: Finanzas PWA

---

## Contexto

La app era funcional pero carecía de un sistema de diseño coherente: sin tipografía financiera consistente, sin animaciones de estado, sin jerarquía visual clara en las investment cards.

## Opciones consideradas

### Opción A: Adoptar un framework UI (Tailwind, etc.)
**Pros**: sistema de diseño listo, utilidades consistentes
**Contras**: viola el principio "Sin frameworks" del proyecto; agrega build step; aumenta bundle

### Opción B: Sistema de diseño propio en CSS vanilla ← elegida
**Pros**: cero dependencias, alineado con el stack actual, control total
**Contras**: más trabajo manual para mantener consistencia

## Decisión

**Elegimos: Opción B** — sistema de diseño propio en CSS vanilla puro.

Implementamos los tres principios del plan de mejora:
- **Impeccable**: `font-variant-numeric: tabular-nums` para números financieros alineados; jerarquía tipográfica clara (ticker monospaced 11px → nombre 17px → precio 26px → P&L 15px); grid 8px (`--sp-1` a `--sp-6`).
- **Emil Kowalski**: microanimaciones con `ease-out` en cambios de precio (`priceFlashUp`/`priceFlashDown` 550ms); stagger de entrada para cards (0, 50, 100ms...); tooltips sin delay (150ms ease-out, zero `transition-delay`).
- **Taste-Skill**: accent stripe lateral (verde/rojo) según P&L de cada inversión; sombras bicapa sutiles (`--shadow-card`); separadores con `rgba` en vez de colores sólidos; card hover con `translateY(-1px)` sutil.

## Consecuencias

**Positivas:**
- Visual profesional sin agregar dependencias
- Números financieros alineados en columnas (tabular nums)
- Feedback visual inmediato en actualizaciones de precio
- Cards con jerarquía clara (verde = ganando, rojo = perdiendo)

**Trade-offs:**
- Las animaciones de precio se activan en cada render (navegación + actualización), no solo en updates. Aceptable para v1: refuerza sensación de datos en vivo.
- `data-tip` tooltips son CSS puro — no funcionan en mobile táctil (hover no existe). Aceptable: tooltips son UX secundario.

## Referencias
- Plan de mejora Finanzas PWA (Junio 2026) — PDF
- Emil Kowalski design principles
- Impeccable typography system
- Taste-Skill design guidelines
