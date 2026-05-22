# ADR-001: Google Sheets como backend vs Base de Datos Estructurada

**Fecha**: 2026-05-16
**Estado**: DECIDIDO — Sheets como único backend
**Generado con**: Prompt P-09 (Decision Matrix) de vault/prompts-aplicados.md

---

## Contexto

El incidente de shares=0 (todos los lotes corruptos por cambio de input format) reveló la fragilidad de Google Sheets como backend. Se evalúa si migrar o complementar con una DB estructurada.

## Opciones Evaluadas

### Opción A: Mantener Google Sheets solo (estado actual)
### Opción B: Supabase (PostgreSQL) como DB primaria, Sheets como vista
### Opción C: Sheets + IndexedDB como capa offline

## Matriz de Decisión

| Factor | Peso | A: Sheets solo | B: Supabase | C: Sheets + IndexedDB |
|--------|------|----------------|-------------|----------------------|
| Costo cero | 10 | 10 | 6 (free tier) | 10 |
| Simplicidad ops | 9 | 9 | 4 | 7 |
| Confiabilidad datos | 8 | 5 | 9 | 7 |
| Offline | 7 | 2 | 5 | 9 |
| **Score total** | | **207** | **194** | **241** |

## Riesgos por Opción

**A (Sheets solo)**
- Google depreca Sheets API para apps personales → pérdida total del backend
- Corrupción de datos sin transacciones ACID (ya ocurrió con shares=0)

**B (Supabase)**
- Overhead de mantenimiento: migraciones, backups, auth separado
- Free tier de Supabase tiene límite de rows y storage

**C (Sheets + IndexedDB)**
- Complejidad de sync bidireccional (conflictos de versión offline/online)
- IndexedDB no es visible/editable por el usuario directamente

## Decisión

**Opción C: Sheets + IndexedDB** es la recomendada a mediano plazo.

Sheets permanece como fuente de verdad y vista editable por el usuario. IndexedDB provee offline-first y actúa como buffer ante errores de Sheets API. La opción B agrega complejidad sin beneficio proporcional para un proyecto personal de un solo usuario.

**Implementar en**: ver `backlog.md` → M-04 (Offline-first completo)

## Revisión

Revisar esta decisión si:
- El proyecto escala a múltiples usuarios
- Google cambia términos de Sheets API
- Se requiere historial de cambios / audit trail
