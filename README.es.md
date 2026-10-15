# ToneDial

[English](https://github.com/awesometic/tonedial/blob/main/README.md) | [한국어](https://github.com/awesometic/tonedial/blob/main/README.ko.md) | [日本語](https://github.com/awesometic/tonedial/blob/main/README.ja.md) | [简体中文](https://github.com/awesometic/tonedial/blob/main/README.zh.md) | **Español**

**Un dial para la voz de tu agente de programación.**

Ajusta doce ejes de tono, guarda un preajuste y conviértelo en `TONE.md`.
La compilación usa criterios de comportamiento estáticos: sin API de modelos ni claves, y los mismos ajustes producen los mismos bytes.
La biblioteca de preajustes permanece en un solo lugar; las conexiones pueden ser globales o por proyecto.

Las integraciones nativas recargan el tono en los eventos de turno configurados.
Claude y Codex pueden pedir una única corrección de estilo después de responder; no repiten el trabajo con herramientas ni sustituyen en silencio una respuesta ya mostrada.
Consulta la [recarga y corrección de estilo limitada](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#hook-refresh-and-bounded-style-feedback).

> [!NOTE]
> Esta es una candidata `0.1.0` sin publicar. Los canales de npm y curl aún no están activos.
> La configuración para Codex, Claude Code y Antigravity IDE/Desktop está implementada; la activación real, la detección de habilidades y la aceptación durante un día siguen sin verificarse.

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/dial.svg" alt="Vista previa de ToneDial: doce ejes, niveles actuales y predeterminados, explicación de warmth, cambios pendientes y teclas para aplicar, descartar y consultar ayuda" width="760">

<sub>Dial sintético actual de 80 columnas; no es una respuesta del agente. No se usó ningún cliente nativo ni estado del usuario. <a href="https://github.com/awesometic/tonedial/blob/main/docs/media/readme/es/dial-example.json">Procedencia del fotograma</a> · <a href="https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#current-dial-example">Receta</a>.</sub>

## Escucha a los personajes

**Royal Advisor:** tú eres el monarca; tu súbdito informa con ceremonia cortesana.
**Ego Sword:** tú eres un aventurero novato; tu espada consciente te regaña para manteneros vivos a ambos.

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-examples.svg" alt="Primeras respuestas reales de Codex con Royal Advisor y Ego Sword a la misma pregunta sobre renombrar una función" width="760">

[Los siete ejemplos completos](https://github.com/awesometic/tonedial/blob/main/docs/EXAMPLES.es.md) ·
[Entradas y respuestas completas](https://github.com/awesometic/tonedial/blob/main/docs/media/readme/es/voice-examples.json)

<sub>Codex CLI 0.160.0 · gpt-6.1-sol · razonamiento high · 2026-10-15. Primeras respuestas completadas, presentadas como diálogo de terminal. No es una captura de la interfaz nativa ni una prueba de activación de hooks.</sub>

## Pruébalo

Necesitas Node 24 o posterior y npm. Desde esta copia del repositorio:

```bash
npm ci
npm run build
node dist/bin.js init --tools none --global --lang es
node dist/bin.js set
```

Esto muestra los cambios en tu estado habitual de ToneDial antes de aprobarlos; no selecciona conexiones de agentes.
Usa la [prueba aislada de la candidata](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#isolated-candidate) para no emplear tus ajustes habituales.
En el dial, usa las flechas o `hjkl`, escribe `1`–`5`, pulsa Enter para aplicar, Esc para descartar y `?` para abrir la ayuda.

Los canales de npm y curl todavía no están activos para esta candidata `0.1.0` sin publicar.
Después de la publicación, instala el CLI persistente con:

```bash
npm install --global tonedial
```

Consulta los [canales de instalación tras la publicación](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#installation-channels-after-release).
Para esta candidata, sigue la [prueba aislada](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#isolated-candidate) desde el repositorio.

Después de instalar una candidata persistente, ejecuta `tonedial init` y elige las herramientas que conectar.
Las conexiones son globales por defecto; `--here` o `--project <path>` elige un proyecto, no otra biblioteca de tonos.

```bash
tonedial use ego-sword
tonedial set warmth=5 critique=5
tonedial set persona.user="Mantengo servicios y prefiero explicaciones directas de las alternativas" \
  persona.agent="Especialista SRE ficticio con doce años de experiencia en el rol; habla con claridad"
tonedial save "My Tone"
tonedial show
tonedial export my-tone > my-tone.json
```

Se incluyen siete perfiles: Caring Brother, Bratty Kid, Eager Sycophant, Royal Advisor, Ego Sword, Heavenly Demon y Right Hand.
Cada uno aporta formas de trato, contexto del usuario, rol ficticio del agente y registro predeterminados.
Los perfiles incluidos y personalizados guardan juntos ejes, personalidad, nombres, registro y palabra clave.
`use` restaura todos sus ajustes; los preajustes antiguos que solo contienen ejes conservan los demás ajustes actuales.
Tough Love y Terse Operator se retiraron del menú; sus identificadores y copias guardadas siguen disponibles.
Un `playfulness` más alto pide expresiones y jerga del personaje más frecuentes y exageradas.
No se filtran esas expresiones; el CLI muestra ejemplos de lenguaje que puede sonar grosero o violento.
Usa `tonedial create` para configurar con guía el nombre, un identificador independiente, los ajustes y los doce ejes.
`show` presenta los ajustes actuales y ofrece un comando de guardado cuando difieren del perfil guardado;
`show <slug>` previsualiza el perfil guardado.
`persona.user` y `persona.agent` son descripciones opcionales de hasta 200 puntos de código Unicode cada una; un valor vacío las borra.
La descripción del agente es ficción, no una credencial verificada ni un permiso.
`set persona.agent="..."` añade o cambia el rol actual de inmediato y conserva los ejes; usa `save` para actualizar el perfil.
La interfaz admite inglés (`en`), coreano (`ko`), japonés (`ja`), chino simplificado (`zh`) y español (`es`).
Elígela durante `init` con `--lang CODE`; después puedes cambiarla con `tonedial set language=es`.
Los criterios de comportamiento están en una única versión inglesa; el agente decide el idioma de la conversación.

Con Claude Code o Codex instalado, prueba una conversación nueva:

```bash
tonedial test claude        # o tonedial test codex
tonedial test codex --preset my-tone # probar un perfil sin cambiar lo guardado
tonedial test claude --json # revisar el plan sin iniciar el cliente
```

El mensaje inicial pide solo diálogo, sin ediciones. Los controles de invocación solicitan omitir hooks de tono e instrucciones automáticas previas.
Las políticas administradas y la compatibilidad del cliente son independientes; esto no aísla el sistema operativo.
Se aplican el consumo y el historial habituales de la cuenta. Escribe `y` tras el aviso para comenzar; `--accept-usage` acepta consumo y cargos solo para este inicio.
El tono completo puede aparecer en los argumentos del proceso; no incluyas credenciales ni información privada en las descripciones o notas.

## Conoce los límites

- El tono es una petición, no una imposición. Los modelos pueden interpretarlo, ignorarlo o rechazarlo, e incluso los más capaces pueden incumplir niveles estrictos.
- Es una herramienta para divertirse, no recomendada en producción. Los extremos pueden fomentar respuestas ásperas, aduladoras o engañosas.
- Los niveles rojos y `!` son advertencias, no restricciones ni puntuaciones de seguridad. El tono no cambia los permisos ni las aprobaciones del cliente.
- La palabra clave pide una respuesta sencilla. `reset` restaura los valores de ToneDial; ninguno ofrece un apagado persistente del tono.
- Configuración, entrega real del contexto y comportamiento del modelo son pruebas distintas. `doctor` no demuestra que el cliente haya activado el tono.
- El dial necesita una vista previa visible de al menos 60×24. Al cambiar el tamaño pueden quedar filas antiguas en el historial; fuentes y colores dependen del terminal.

## Más información

| Necesidad | Guía |
| --- | --- |
| Ejes, comandos, conexiones y recuperación | [Usar ToneDial](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md) |
| Arreglos, funciones, integraciones o mediciones | [Contribuir](https://github.com/awesometic/tonedial/blob/main/CONTRIBUTING.md) |
| Comprobaciones automáticas, instaladas y del cliente real | [Pruebas](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md) |
| Reglas del proyecto para trabajo con agentes | [AGENTS.md](https://github.com/awesometic/tonedial/blob/main/AGENTS.md) |
| Informar de vulnerabilidades con seguridad | [Seguridad](https://github.com/awesometic/tonedial/blob/main/SECURITY.md) |

[Licencia MIT](https://github.com/awesometic/tonedial/blob/main/LICENSE) · [Avisos de terceros](https://github.com/awesometic/tonedial/blob/main/THIRD_PARTY_NOTICES.md)
