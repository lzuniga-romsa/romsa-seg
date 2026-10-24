# Leads HOME automáticos desde Meta — configuración

Con esto, cada mensaje nuevo de WhatsApp, Messenger o Instagram, y cada formulario de Lead Ads, aparece solo en **Leads HOME** del CRM, con el anuncio que lo trajo y la alerta **Sin responder**.

```
Cliente escribe ──► Meta ──► metaLeadsWebhook (Cloud Function) ──► home_leads ──► Leads HOME (en vivo)
```

## Qué hace

| Llega de Meta | Qué pasa en el CRM |
|---|---|
| Primer mensaje de un cliente (WA / Messenger / IG) | Lead nuevo en etapa **Nuevo**, con nombre de perfil, teléfono (WA), anuncio de origen y servicio adivinado por palabras clave |
| Más mensajes del mismo cliente | Se agregan a la conversación del lead; se enciende **Sin responder** |
| Tu respuesta (desde la página, IG o WhatsApp Business en coexistencia) | Se apaga **Sin responder** y cuenta como movimiento |
| Formulario de Lead Ads | Lead nuevo, canal **Formulario**, con las respuestas del formulario |
| Mensaje de un número que ya capturaste a mano | Se pega a ese lead, no crea otro |
| Cliente en **Perdido** que vuelve a escribir | Regresa a **Nuevo** con nota "Volvió a escribir" |

Si respondes por un medio que Meta no reporta (llamada, otro teléfono), usa **Ya le respondí** en el detalle del lead.

## Requisitos previos

1. Página de Facebook de HOME by ROMSA y la cuenta de Instagram **@homebyromsapisos** conectadas a la página (cuenta profesional).
2. Un **Meta Business Portfolio** (Business Manager) dueño de la página.
3. Para WhatsApp: el número dado de alta en **WhatsApp Cloud API**. Si quieres seguir contestando desde la app WhatsApp Business del celular, el alta tiene que ser en **modo coexistencia** (Meta lo ofrece al registrar el número en la plataforma: "usar número existente de la app WhatsApp Business"). Sin coexistencia, el número deja de funcionar en la app.

## Paso 1 — Crear la app de Meta

1. Entra a <https://developers.facebook.com/apps> → **Crear app** → tipo **Empresa (Business)** → asóciala al portfolio de ROMSA.
2. Agrega los productos: **Webhooks**, **Messenger**, **Instagram** (API con inicio de sesión de Facebook) y **WhatsApp**.
3. En **Configuración → Básica** copia la **Clave secreta de la app** (la usarás como `META_APP_SECRET`).

## Paso 2 — Token de página

1. En **Messenger → Configuración de la API** conecta la página de HOME by ROMSA y genera el **token de acceso de la página**.
2. Para que no caduque, conviene generarlo desde un **usuario del sistema** del Business Manager (Configuración del negocio → Usuarios del sistema → Generar token, con la app y los permisos `pages_messaging`, `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`, `leads_retrieval`, `instagram_basic`, `instagram_manage_messages`).
3. Ese token es `META_PAGE_TOKEN`. Se usa para leer el nombre del cliente en Messenger/IG y las respuestas de los formularios.

## Paso 3 — Secretos en Firebase y deploy

Desde la carpeta del repo:

```bash
firebase functions:secrets:set META_APP_SECRET     # pega la clave secreta de la app
firebase functions:secrets:set META_VERIFY_TOKEN   # inventa un texto largo, ej. home-romsa-2026-xK29pQ
firebase functions:secrets:set META_PAGE_TOKEN     # pega el token de página
firebase deploy --only functions:metaLeadsWebhook
```

La URL queda así (cópiala):

```
https://us-central1-romsa-industrial.cloudfunctions.net/metaLeadsWebhook
```

## Paso 4 — Registrar el webhook en Meta

Usa la misma URL y el mismo `META_VERIFY_TOKEN` en los tres:

| Producto | Dónde | Campos a suscribir |
|---|---|---|
| **WhatsApp** | WhatsApp → Configuración → Webhook | `messages`, `smb_message_echoes` (coexistencia) |
| **Messenger** | Messenger → Configuración → Webhooks, y suscribir la página | `messages`, `message_echoes`, `messaging_referrals`, `leadgen` |
| **Instagram** | Instagram → Configuración → Webhooks | `messages`, `message_echoes` |

Al dar **Verificar y guardar**, Meta hace un GET a la función; si el token coincide responde el código y queda verificado.

Para formularios, además: **Business Manager → Integraciones → Acceso a clientes potenciales (Leads Access)** → da acceso a la app.

## Paso 5 — Modo en vivo y revisión de la app

Mientras la app está en **modo desarrollo**, Meta solo envía mensajes de personas con rol en la app (tú). Para recibir los de clientes reales:

1. Verifica el negocio (**Business Verification**) en el portfolio.
2. Pide **Acceso avanzado** en *Revisión de la app* para `pages_messaging`, `instagram_manage_messages` y `leads_retrieval`. Meta pide un video corto mostrando el uso (grábate abriendo Leads HOME y viendo cómo entra un mensaje).
3. Pasa la app a **En vivo**.

WhatsApp Cloud API no necesita revisión para recibir mensajes de tu propio número.

## Probar

1. Con la app en desarrollo, escríbele a la página desde tu cuenta personal: debe aparecer un lead en segundos con la alerta **Sin responder**.
2. Contesta desde la página: la alerta se apaga.
3. Para formularios, usa la herramienta <https://developers.facebook.com/tools/lead-ads-testing>.
4. Si algo no llega: Firebase Console → Functions → `metaLeadsWebhook` → Registros. Cada evento deja una línea `[metaLeads]` con `creado`, `actualizado`, `duplicado` o `ignorado`; las firmas inválidas aparecen como advertencia.

## Notas técnicas

- Código: `functions/metaLeads.js` (lógica) y `metaLeadsWebhook` en `functions/index.js`.
- Seguridad: cada petición se valida con la firma `X-Hub-Signature-256` de la app; sin firma correcta responde 401 y no escribe nada.
- Duplicados: cada mensaje guarda su id de Meta; si Meta reintenta, no se repite. Los leads automáticos usan id fijo `meta_<canal>_<id>`, así dos mensajes simultáneos no crean dos leads.
- La conversación guarda los últimos 30 mensajes por lead (texto; fotos/audios aparecen como `[Imagen]`, `[Audio]`).
- Servicio adivinado: palabras como *epóxico, estampado, banqueta, colado/concreto/cochera/patio, pulido/poliuretano*, primero en el texto del anuncio y luego en el mensaje. Se puede corregir a mano.
- Graph API `v23.0`. Cuando Meta la retire (aprox. 2 años), cambiar `GRAPH` en `metaLeads.js`.
