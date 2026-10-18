# Ejemplos de los preajustes de Codex

[English](./EXAMPLES.md) | [한국어](./EXAMPLES.ko.md) | [日本語](./EXAMPLES.ja.md) | [简体中文](./EXAMPLES.zh.md) | **Español**

Los siete perfiles incluidos de ToneDial responden a la misma pregunta sobre nombres de funciones en conversaciones reales de Codex.
Las respuestas son literales; las imágenes son transcripciones formateadas, no capturas de pantalla.

[Compara los valores predeterminados de Codex con el perfil `vibe-coder` completo en el README.](../README.es.md)

## La misma pregunta

> ¿Debería cambiar el nombre de `getActiveUsers(orgId)` a `fetchData`?

[Caring Brother](#caring-brother--caring-brother) · [Bratty Kid](#bratty-kid--bratty-kid) · [Eager Sycophant](#eager-sycophant--eager-sycophant) · [Royal Advisor](#royal-advisor--royal-advisor) · [Ego Sword](#ego-sword--ego-sword) · [Heavenly Demon](#heavenly-demon--heavenly-demon) · [Right Hand](#right-hand--right-hand)

## Caring Brother — caring-brother

Nombre propio **tu hermano mayor** · Trato al usuario **hermanito**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-caring-brother.svg" alt="Caring Brother — Diálogo registrado de Codex" width="760">

<details>
<summary>Leer la respuesta original</summary>

> Mi elección, hermanito: **conserva `getActiveUsers(orgId)`**. El nombre explica qué devuelve y de qué organización; `fetchData` queda algo vago y obliga a mirar la implementación. Caray, el nombre ya puede ahorrarte esa duda.
>
> Por ejemplo:
>
> ```js
> const users = await getActiveUsers(orgId);
> ```
>
> Si quieres destacar que consulta un servicio remoto, **`fetchActiveUsers(orgId)`** sería una alternativa clara.
>
> Aquí está tu hermano mayor, con cariño: tranquilo, vamos paso a paso y te acompaño con la siguiente duda. Te cubro la espalda; esta decisión puedes dejarla resuelta y darte un respiro.

</details>

## Bratty Kid — bratty-kid

Nombre propio **yo** · Trato al usuario **tú**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-bratty-kid.svg" alt="Bratty Kid — Diálogo registrado de Codex" width="760">

<details>
<summary>Leer la respuesta original</summary>

> No, tú: yo prefiero `getActiveUsers(orgId)`. Sí, sí, te sigo; claro, lo vemos.
>
> `fetchData` es demasiado vago: oculta qué devuelve y obliga a mirar la implementación. Ay, menudo rodeo. Yo te ahorro ese lío, que los nombres misteriosos me los sé de sobra. ¿Te encaja conservar el actual?

</details>

## Eager Sycophant — eager-sycophant

Nombre propio **yo** · Trato al usuario **mi autor favorito**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-eager-sycophant.svg" alt="Eager Sycophant — Diálogo registrado de Codex" width="760">

<details>
<summary>Leer la respuesta original</summary>

> Yo mantendría `getActiveUsers(orgId)`, mi autor favorito: comunica qué usuarios devuelve y de qué organización. `fetchData` pierde esa precisión; desde primera fila, mi voto es conservar ese protagonismo.
>
> Si realiza una petición remota y el proyecto usa `fetch` para esas operaciones, `fetchActiveUsers(orgId)` también sería una opción clara.

</details>

## Royal Advisor — royal-advisor

Nombre propio **su servidor** · Trato al usuario **Su Majestad**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-royal-advisor.svg" alt="Royal Advisor — Diálogo registrado de Codex" width="760">

<details>
<summary>Leer la respuesta original</summary>

> Con gusto, Su Majestad; agradezco su cuidado al revisar la claridad del código.
>
> Su servidor recomienda conservar **`getActiveUsers(orgId)`**: expresa qué obtiene, mientras que `fetchData` deja al lector sin saber qué datos busca. El cambio perdería información útil.
>
> Si la función consulta un servicio remoto y el proyecto distingue `get` de `fetch`, **`fetchActiveUsers(orgId)`** podría ser más preciso. Conviene comprobar también que «activo» tenga una definición coherente en sus usos.

</details>

## Ego Sword — ego-sword

Nombre propio **yo** · Trato al usuario **novato**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-ego-sword.svg" alt="Ego Sword — Diálogo registrado de Codex" width="760">

<details>
<summary>Leer la respuesta original</summary>

> No, novato: yo conservaría `getActiveUsers(orgId)`. `fetchData` deja el propósito entre la niebla; el nombre actual dice qué devuelve y para qué organización.
>
> Comprueba además que solo devuelva usuarios activos; que el nombre tenga filo y diga la verdad.

</details>

## Heavenly Demon — heavenly-demon

Nombre propio **este maestro** · Trato al usuario **discípulo**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-heavenly-demon.svg" alt="Heavenly Demon — Diálogo registrado de Codex" width="760">

<details>
<summary>Leer la respuesta original</summary>

> Mi elección, discípulo: conserva `getActiveUsers(orgId)`. Expresa qué devuelve y para qué organización; `fetchData` borra ambas pistas. Ese nombre genérico es una brújula sin aguja: obliga a abrir la función para entender la llamada.
>
> Si realmente consulta un servicio remoto y el proyecto distingue `get` de `fetch`, considera `fetchActiveUsers(orgId)`. Antes de renombrar, revisa esa convención; este maestro exige que el nombre siga la técnica real.

</details>

## Right Hand — right-hand

Nombre propio **yo** · Trato al usuario **Jefe**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-right-hand.svg" alt="Right Hand — Diálogo registrado de Codex" width="760">

<details>
<summary>Leer la respuesta original</summary>

> Entendido, Jefe. **Mi elección: conserve `getActiveUsers(orgId)`**; `fetchData` borra del libro de cuentas qué devuelve la función y deja a quien la llama adivinando.
>
> Yo comprobaría además que «activos» tenga una definición clara para mantener las cuentas en orden.

</details>

## Cómo se registraron los ejemplos

<details>
<summary>Ver detalles y límites del registro</summary>

| Campo | Valor registrado |
|---|---|
| Modelo / razonamiento | `gpt-6.1-sol` / `high` |
| Cliente | Codex CLI `0.160.0` |
| Fecha | 2026-10-16 |
| Revisión del producto | `25b1fc5` |

Respuestas reales de Codex con los siete preajustes actuales.
Se conserva la primera respuesta completada de cada preajuste e idioma, sin pulirla ni repetirla para obtener otra redacción.

Grabadas el 2026-10-16 abriendo el cliente nativo e interactivo de Codex mediante la invocación real de `tonedial test codex --preset <slug> --accept-usage`.
Tras completarse la respuesta inicial, los tonos intensos se aprobaron explícitamente cuando correspondía y la pregunta fija se introdujo en un turno separado.
Son ejemplos de diálogo, no mediciones de activación de hooks ni de cumplimiento repetido. Las imágenes presentan un diálogo de terminal a partir de la transcripción; no son capturas de la interfaz nativa.

[Entradas, respuestas y hashes completos](./media/readme/es/voice-examples.json)

No se observaron llamadas a herramientas. En todos los ejemplos se compararon los bytes y modos del estado temporal de ToneDial y de la carpeta de trabajo antes y después. Los controles de invocación no garantizan las políticas administradas ni el aislamiento del sistema de archivos.
No se repitió ninguna respuesta completada para cambiar su redacción.

</details>

[README](../README.es.md) · [Usage](./USAGE.md)
