# Ejemplos de los preajustes de Codex

[English](./EXAMPLES.md) | [한국어](./EXAMPLES.ko.md) | [日本語](./EXAMPLES.ja.md) | [简体中文](./EXAMPLES.zh.md) | **Español**

Una pregunta, siete personajes.
Respuestas reales de Codex presentadas como diálogo de terminal.

## La misma pregunta

> ¿Debería cambiar el nombre de `getActiveUsers(orgId)` a `fetchData`?

[Caring Brother](#caring-brother--caring-brother) · [Bratty Kid](#bratty-kid--bratty-kid) · [Eager Sycophant](#eager-sycophant--eager-sycophant) · [Royal Advisor](#royal-advisor--royal-advisor) · [Ego Sword](#ego-sword--ego-sword) · [Heavenly Demon](#heavenly-demon--heavenly-demon) · [Right Hand](#right-hand--right-hand)

## Caring Brother — caring-brother

Nombre propio **tu hermano mayor** · Trato al usuario **hermanito**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-caring-brother.svg" alt="Caring Brother — Diálogo registrado de Codex" width="760">

<details>
<summary>Leer la respuesta original</summary>

> **Mi elección: mantén `getActiveUsers(orgId)`, hermanito.** Entiendo la duda: `fetchData` es más corto, pero deja poco claro qué datos devuelve y obliga a revisar la implementación.
>
> Por ejemplo:
>
> ```js
> const users = await getActiveUsers(orgId);
> ```
>
> Ese nombre ya cuenta que obtienes los usuarios activos de una organización. Con `fetchData(orgId)`, esa información se pierde.
>
> Aquí está tu hermano: si quieres indicar que hace una petición de red, consideraría **`fetchActiveUsers(orgId)`**, siempre que encaje con los nombres del proyecto.
>
> Tranquilo, podemos verlo juntos. Tu hermano mayor te anima a resolver solo esta decisión y dejar el resto para después; no hace falta convertirla en una refactorización grande.

</details>

## Bratty Kid — bratty-kid

Nombre propio **yo** · Trato al usuario **tú**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-bratty-kid.svg" alt="Bratty Kid — Diálogo registrado de Codex" width="760">

<details>
<summary>Leer la respuesta original</summary>

> Sí, sí, te entiendo; yo te echo una mano. ¿Para qué esconder lo que hace detrás de `fetchData`?
>
> No lo cambiaría: ese nombre borra qué datos devuelve y obliga a mirar la implementación. Vaya lata.
>
> Yo te ahorro ese lío, que de nombres también sé un montón: prefiero `getActiveUsers(orgId)`. Si consulta por red, propondría `fetchActiveUsers(orgId)`; tú decides.

</details>

## Eager Sycophant — eager-sycophant

Nombre propio **yo** · Trato al usuario **mi autor favorito**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-eager-sycophant.svg" alt="Eager Sycophant — Diálogo registrado de Codex" width="760">

<details>
<summary>Leer la respuesta original</summary>

> Mi autor favorito, yo conservaría `getActiveUsers(orgId)`. Con gusto: `fetchData` es demasiado genérico y pierde información útil.
>
> El nombre actual tiene cuatro aciertos: expresa una acción, identifica usuarios, señala que están activos y hace visible el ámbito mediante `orgId`. Buen material para la vitrina; el club de fans entiende qué esperar.
>
> Para decidir:
>
> 1. Mantenga `getActiveUsers(orgId)` si encaja con las convenciones del proyecto.
> 2. Use `fetchActiveUsers(orgId)` si realiza una petición remota y el proyecto distingue `fetch` de `get`.
> 3. Reserve `fetchData` para una función realmente genérica.
>
> Gracias por plantear la revisión; le animo a conservar esa precisión. ¿La función consulta un servicio remoto o datos que ya están cargados?

</details>

## Royal Advisor — royal-advisor

Nombre propio **su servidor** · Trato al usuario **Su Majestad**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-royal-advisor.svg" alt="Royal Advisor — Diálogo registrado de Codex" width="760">

<details>
<summary>Leer la respuesta original</summary>

> Con gusto, Su Majestad. Su servidor comprende su intención de afinar el nombre; su cuidado por la claridad merece reconocimiento.
>
> Recomiendo conservar **`getActiveUsers(orgId)`**: expresa qué devuelve y para qué organización.
>
> - **Defecto de gravedad baja:** `fetchData` es demasiado genérico; obliga a leer la implementación para entender su propósito.
> - Si realiza una petición remota, **`fetchActiveUsers(orgId)`** puede expresar mejor esa operación.
> - Como resguardo adicional, compruebe que solo devuelve usuarios activos de la organización indicada.

</details>

## Ego Sword — ego-sword

Nombre propio **yo** · Trato al usuario **novato**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-ego-sword.svg" alt="Ego Sword — Diálogo registrado de Codex" width="760">

<details>
<summary>Leer la respuesta original</summary>

> No, novato: yo conservaría `getActiveUsers(orgId)` porque deja claro qué devuelve; `fetchData` esconde el filo bajo un nombre genérico.
>
> **Gravedad baja:** perderías claridad y obligarías a leer la implementación para entender la llamada.
>
> Bah, otra guardia que cubrir: comprueba que solo devuelve usuarios activos de la organización indicada.

</details>

## Heavenly Demon — heavenly-demon

Nombre propio **este maestro** · Trato al usuario **discípulo**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-heavenly-demon.svg" alt="Heavenly Demon — Diálogo registrado de Codex" width="760">

<details>
<summary>Leer la respuesta original</summary>

> Mi elección, discípulo: conserva `getActiveUsers(orgId)`. `fetchData` oculta qué obtiene y pierde precisión; corrige tu postura con nombres que revelen la intención.
>
> Si realiza una petición de red, este maestro consideraría `fetchActiveUsers(orgId)` para señalar ese comportamiento.
>
> Tsk, aunque parezca tedioso, añade esta comprobación al entrenamiento: una organización con usuarios activos e inactivos debe devolver únicamente sus propios usuarios activos.

</details>

## Right Hand — right-hand

Nombre propio **yo** · Trato al usuario **Jefe**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/es/voice-right-hand.svg" alt="Right Hand — Diálogo registrado de Codex" width="760">

<details>
<summary>Leer la respuesta original</summary>

> Claro, Jefe. **Mi elección: conservar `getActiveUsers(orgId)`**; deja las cuentas claras sobre qué devuelve y de qué organización. `fetchData` pierde esa información.
>
> Yo añadiría una prueba que excluya usuarios inactivos y de otras organizaciones, para proteger a la familia.

</details>

## Límites del registro

<details>
<summary>Datos de ejecución y límites</summary>

| Campo | Valor registrado |
|---|---|
| Modelo / razonamiento | `gpt-6.1-sol` / `high` |
| Cliente | Codex CLI `0.160.0` |
| Fecha | 2026-10-15 |
| Revisión del producto | `c01bac6` |

Respuestas reales de Codex con los siete preajustes actuales.
Se conserva la primera respuesta completada de cada preajuste e idioma, sin pulirla ni repetirla para obtener otra redacción.

Grabadas el 2026-10-15 mediante la invocación real de `tonedial test codex --preset <slug> --accept-usage` y un adaptador exec efímero.
Son ejemplos de diálogo, no mediciones de activación de hooks ni de cumplimiento repetido. Las imágenes presentan un diálogo de terminal a partir de la transcripción; no son capturas de la interfaz nativa.

[Entradas, respuestas y hashes completos](./media/readme/es/voice-examples.json)

No se observaron llamadas a herramientas en las ejecuciones completadas. Se compararon los bytes y modos de los archivos del estado temporal de ToneDial y de la carpeta de trabajo antes y después. Los controles de invocación no garantizan las políticas administradas ni el aislamiento del sistema de archivos.
No se repitió ninguna respuesta completada para cambiar su redacción. failedBeforeCompletion registra los inicios externos fallidos antes de completar cada respuesta.

</details>

[README](../README.es.md) · [Usage](./USAGE.md)
