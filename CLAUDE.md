# Finanzas PWA — Gestión de Finanzas Personales

Progressive Web App para gestión de finanzas personales. Funciona offline y se instala como app nativa.

## Stack
- JavaScript (Vanilla JS o framework ligero)
- Service Workers (funcionalidad offline)
- IndexedDB / localStorage (persistencia local)
- Web App Manifest (instalación PWA)
- CSS moderno (sin framework pesado)

## Features Típicos de una PWA de Finanzas
- Registro de ingresos y gastos
- Categorización de transacciones
- Dashboards y gráficas de evolución
- Funcionalidad offline-first
- Presupuestos y alertas

## Comandos
```bash
# Servidor de desarrollo
npx serve . -p 3000
# o
python -m http.server 3000

# Para PWA: necesita HTTPS en producción (o localhost en desarrollo)
```

## Convenciones PWA
- Service Worker en raíz del proyecto (`/sw.js`)
- Manifest en `manifest.json`
- Iconos en múltiples tamaños (192x192, 512x512 mínimo)
- Cache-first para assets estáticos; network-first para datos

## Contexto Colombiano
- Moneda: COP (pesos colombianos)
- Formato: $1.234.567 (punto como separador de miles)
- Fechas: DD/MM/YYYY
