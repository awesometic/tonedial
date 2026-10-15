# ToneDial

**Dale un personaje a tu agente de programación.**

Elige un personaje, ajusta doce diales y guarda una voz para usarla en distintos proyectos.

**7 personajes · 12 ejes de tono · 5 idiomas del CLI · Cero dependencias en ejecución**

[English](https://github.com/awesometic/tonedial/blob/main/README.md) | [한국어](https://github.com/awesometic/tonedial/blob/main/README.ko.md) | [日本語](https://github.com/awesometic/tonedial/blob/main/README.ja.md) | [简体中文](https://github.com/awesometic/tonedial/blob/main/README.zh.md) | **Español**

## Mira cómo responde

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-examples.svg" alt="Royal Advisor y Ego Sword responden a la misma pregunta sobre renombrar una función en conversaciones reales de Codex" width="760">

<sub>Respuestas reales de Codex, presentadas como diálogos de terminal. <a href="https://github.com/awesometic/tonedial/blob/main/docs/media/readme/es/voice-examples.json">Entradas y procedencia</a>.</sub>

**[Ver los 7 personajes →](https://github.com/awesometic/tonedial/blob/main/docs/EXAMPLES.es.md)**

## Pruébalo

> [!NOTE]
> **Vista previa inicial · 0.1.0.** Ejecuta desde el código fuente. La publicación en npm/curl y la verificación de activación nativa siguen pendientes.
> [Estado y comprobaciones](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md).

Desde una copia del repositorio, con **Node 24 o posterior** y npm:

```bash
npm ci
npm run build
node dist/bin.js init --tools none --global --lang es
node dist/bin.js set
```

La configuración muestra los cambios de archivos y pide aprobación. Puedes abrir el dial sin conectar un agente.

[Conecta tu agente](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#connecting-an-agent) · [Prueba con ajustes temporales](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#isolated-candidate)

## Elige tu personaje

| Preajuste | Tú → agente |
| --- | --- |
| Caring Brother | Hermano pequeño → hermano mayor |
| Bratty Kid | Interlocutor → niño descarado |
| Eager Sycophant | Creador → fan entusiasta |
| Royal Advisor | Monarca → súbdito leal |
| Ego Sword | Novato → espada consciente |
| Heavenly Demon | Discípulo → maestro marcial severo |
| Right Hand | Jefe → consigliere de confianza |

```bash
node dist/bin.js use ego-sword
node dist/bin.js set verbosity=1 warmth=3
node dist/bin.js save "My Sword"
```

Crea el tuyo con `node dist/bin.js create`. Cada perfil guarda tono, roles, formas de trato, registro y palabra clave.

## Ajusta los diales

**Doce ejes, cinco niveles cada uno.** Decide cuánta formalidad, brevedad, calidez, crítica o teatralidad quieres.

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/dial.svg" alt="Dial de doce ejes de ToneDial con niveles actuales, explicación de warmth y teclas de control" width="760">

<sub>Vista previa sintética de 80 columnas generada con el renderizador actual del CLI. <a href="https://github.com/awesometic/tonedial/blob/main/docs/media/readme/es/dial-example.json">Procedencia del fotograma</a> · <a href="https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#current-dial-example">Receta</a>.</sub>

**↑↓** elegir eje · **←→ / 1–5** fijar nivel · **Enter** aplicar · **Esc** descartar

ToneDial compila los ajustes en `TONE.md` de forma local y determinista. Tu agente aporta el modelo.

## Conecta tu agente

**Claude Code · Codex · Antigravity IDE/Desktop** — [guía de conexión](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#connecting-an-agent)

Prueba una conversación nueva con un cliente Codex o Claude Code instalado:

```bash
node dist/bin.js test codex --preset my-sword
```

- Las vistas previas usan tu cuenta del proveedor; se aplican el consumo, los cargos y el historial habituales.
- El tono cambia el estilo. Los permisos y las aprobaciones del cliente siguen vigentes.
- El comportamiento varía según el modelo. Es para divertirse; no se recomienda en producción.

## Más información

[Uso y referencia](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md) · [Aporta un preajuste o una corrección](https://github.com/awesometic/tonedial/blob/main/CONTRIBUTING.md) · [Pruebas](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md) · [Seguridad](https://github.com/awesometic/tonedial/blob/main/SECURITY.md)

[Guía para agentes](https://github.com/awesometic/tonedial/blob/main/AGENTS.md) · [Licencia MIT](https://github.com/awesometic/tonedial/blob/main/LICENSE) · [Avisos de terceros](https://github.com/awesometic/tonedial/blob/main/THIRD_PARTY_NOTICES.md)
