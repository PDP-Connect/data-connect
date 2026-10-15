# Vacuna al día: cuentas de prueba / test accounts

[Español](#español) · [English](#english)

## Español

Demostración con datos ficticios. Ninguna cédula, nombre ni registro es real.
No use datos reales.

- Dirección: https://vacuna-al-dia-demo.fly.dev (en local: http://localhost:8080)
- Contraseña de todas las cuentas: `VacunaAlDia2026`
- Idioma: enlace **ES | EN** arriba a la derecha de cada pantalla.
- Cada persona necesita su propia sesión: use **Salir** o una ventana privada al cambiar de persona.

| Cédula | Persona | Niños o niñas a su cargo (registro, nacimiento) | Qué muestra |
|---|---|---|---|
| `001-0000001-1` | María Rodríguez | Sofía Rodríguez (`DR-9100001`, 2026-06-20) | Madre con una sola hija |
| `001-0000002-2` | Carmen Pérez | Luis Pérez (`DR-9100002`, 2022-11-02)<br>Ana Pérez (`DR-9100003`, 2026-02-10) | Madre con dos hijos (elige a cuál conectar) |
| `001-0000003-3` | Juan Martínez | Diego Martínez (`DR-9100004`, 2025-09-30) | Padre que comparte un hijo con Rosa |
| `001-0000004-4` | Rosa Martínez | Diego Martínez (`DR-9100004`, 2025-09-30) | Madre que comparte un hijo con Juan: ve y puede retirar lo que él aprobó |
| `001-0000005-5` | Ramón Jiménez | Valentina Cruz (`DR-9100005`, 2023-04-15, tutor legal)<br>Tomás Cruz (`DR-9100006`, 2021-07-08, tutor legal) | Tutor legal (no es el padre) de dos hermanos |
| `001-0000006-6` | Pedro Gómez | Camila Gómez (`DR-9100007`, 2024-01-20, autoridad suspendida) | El Registro Civil lo rechaza: su autoridad sobre Camila está suspendida |
| `001-0000007-7` | Altagracia Fernández | Miguel Fernández (`DR-9100008`, 2008-11-20)<br>Paula Fernández (`DR-9100009`, 2014-03-03) | Hijo de 17 años: la autorización vence en su cumpleaños 18 |
| `001-0000008-8` | Yolanda Castillo | Gabriel Castillo (`DR-9100010`, 2021-10-25)<br>Isabella Castillo (`DR-9100011`, 2023-08-08)<br>Samuel Castillo (`DR-9100012`, 2026-09-10) | Madre de tres, incluido un recién nacido |
| `001-0000009-9` | Francisco Castillo | Gabriel Castillo (`DR-9100010`, 2021-10-25)<br>Isabella Castillo (`DR-9100011`, 2023-08-08)<br>Samuel Castillo (`DR-9100012`, 2026-09-10) | Padre de los mismos tres niños que Yolanda |
| `001-0000010-0` | Elena Santos | Lucía Santos (`DR-9100013`, 2024-12-01)<br>Mateo Santos (`DR-9100014`, 2026-04-05)<br>Daniel Santos (`DR-9100015`, 2025-03-18) | Madre de tres niños pequeños, uno con una vacuna atrasada |

### Recorrido paso a paso

1. **Inicio.** Abra https://vacuna-al-dia-demo.fly.dev. La página explica la demostración. Pulse **Empezar la demostración**.
2. **Servicio de recordatorios.** En «Vacuna al día» pulse **Conectar con Cuenta Única**.
3. **Cuenta Única.** Entre con la cédula `001-0000001-1` (María) y la contraseña.
4. **Elegir niño.** Aparece solo Sofía, según el Registro Civil. Pulse **Continuar**.
5. **Revisar.** La pantalla dice «Usted está actuando como madre o padre de Sofía Rodríguez», qué datos se comparten, para qué, y que vence el 20 de junio de 2044 (su cumpleaños 18). Pulse **Autorizar**.
6. **De vuelta en el servicio.** Muestra la próxima vacuna de Sofía (Pentavalente, dosis 2, 18 de octubre de 2026), leída en ese momento del registro. El servicio ve el número de registro, no el nombre.
7. **Dos hijos.** Salga y entre como Carmen (`001-0000002-2`): elige entre Luis y Ana. Ana tiene una vacuna atrasada.
8. **Dos padres.** Conecte a Diego como Juan (`001-0000003-3`). Luego entre como Rosa (`001-0000004-4`) en **Mis autorizaciones**: ve la autorización de Diego «autorizada por otra persona con autoridad». Elija **Borrarlos** y pulse **Retirar autorización**.
9. **Lo que ve el servicio.** Abra **Panel del servicio**: Diego (`DR-9100004`) aparece «Retirada · datos borrados».
10. **Rechazo del Registro Civil.** En «Vacuna al día» abra «¿Tiene el número de registro del niño o niña?», escriba `DR-9100007` y pulse **Conectar**. Entre como Pedro (`001-0000006-6`) y pulse **Continuar**: «No se pudo autorizar». No se mostró ningún dato de Camila. **Volver a la aplicación** muestra que no se autorizó.
11. **Casi 18 años.** Como Altagracia (`001-0000007-7`) elija a Miguel: la autorización vence el 20 de noviembre de 2026.
12. **Tutor legal.** Como Ramón (`001-0000005-5`): «Usted está actuando como tutor o tutora legal de …».
13. **Conservar.** Como María, en **Mis autorizaciones** retire la de Sofía con **Conservarlos**. En el panel queda «Retirada · datos conservados»: el servicio ya no lee datos nuevos pero puede usar lo que recibió.

Para empezar de cero: `scripts/demo-dr-vacuna/deploy/reset.sh fly` (ver DEPLOY.md).

## English

Demo with fictitious data. No cédula, name or record is real. Do not enter
real data.

- Address: https://vacuna-al-dia-demo.fly.dev (locally: http://localhost:8080)
- Password for every account: `VacunaAlDia2026`
- Language: the **ES | EN** link at the top right of every screen.
- Each person needs their own session: use **Sign out** or a private window when switching people.

| Cédula | Person | Children in their care (record, birth date) | What it shows |
|---|---|---|---|
| `001-0000001-1` | María Rodríguez | Sofía Rodríguez (`DR-9100001`, 2026-06-20) | Mother with one child |
| `001-0000002-2` | Carmen Pérez | Luis Pérez (`DR-9100002`, 2022-11-02)<br>Ana Pérez (`DR-9100003`, 2026-02-10) | Mother with two children (picks which one) |
| `001-0000003-3` | Juan Martínez | Diego Martínez (`DR-9100004`, 2025-09-30) | Father who shares a child with Rosa |
| `001-0000004-4` | Rosa Martínez | Diego Martínez (`DR-9100004`, 2025-09-30) | Mother who shares a child with Juan: sees and can withdraw what he approved |
| `001-0000005-5` | Ramón Jiménez | Valentina Cruz (`DR-9100005`, 2023-04-15, legal guardian)<br>Tomás Cruz (`DR-9100006`, 2021-07-08, legal guardian) | Legal guardian (not a parent) of two siblings |
| `001-0000006-6` | Pedro Gómez | Camila Gómez (`DR-9100007`, 2024-01-20, authority suspended) | The civil registry refuses him: his authority over Camila is suspended |
| `001-0000007-7` | Altagracia Fernández | Miguel Fernández (`DR-9100008`, 2008-11-20)<br>Paula Fernández (`DR-9100009`, 2014-03-03) | 17-year-old son: the authorization ends on his 18th birthday |
| `001-0000008-8` | Yolanda Castillo | Gabriel Castillo (`DR-9100010`, 2021-10-25)<br>Isabella Castillo (`DR-9100011`, 2023-08-08)<br>Samuel Castillo (`DR-9100012`, 2026-09-10) | Mother of three, including a newborn |
| `001-0000009-9` | Francisco Castillo | Gabriel Castillo (`DR-9100010`, 2021-10-25)<br>Isabella Castillo (`DR-9100011`, 2023-08-08)<br>Samuel Castillo (`DR-9100012`, 2026-09-10) | Father of the same three children as Yolanda |
| `001-0000010-0` | Elena Santos | Lucía Santos (`DR-9100013`, 2024-12-01)<br>Mateo Santos (`DR-9100014`, 2026-04-05)<br>Daniel Santos (`DR-9100015`, 2025-03-18) | Mother of three young children, one with an overdue vaccine |

### Step-by-step walkthrough

1. **Start.** Open https://vacuna-al-dia-demo.fly.dev?lang=en. The page explains the demo. Click **Start the demo**.
2. **Reminder service.** In “Vacuna al día” click **Connect with Cuenta Única**.
3. **Cuenta Única.** Sign in with cédula `001-0000001-1` (María) and the password.
4. **Pick a child.** Only Sofía is listed, from the civil registry. Click **Continue**.
5. **Review.** The screen says “You are acting as parent of Sofía Rodríguez”, which fields are shared, what for, and that it ends on 20 June 2044 (her 18th birthday). Click **Authorize**.
6. **Back at the service.** It shows Sofía's next vaccine (Pentavalent, dose 2, 18 October 2026), read from the register just now. The service sees the record number, not the name.
7. **Two children.** Sign out and sign in as Carmen (`001-0000002-2`): she chooses between Luis and Ana. Ana has an overdue vaccine.
8. **Two parents.** Connect Diego as Juan (`001-0000003-3`). Then sign in as Rosa (`001-0000004-4`) in **My authorizations**: she sees Diego's authorization “authorized by another person with authority”. Choose **Delete them** and click **Withdraw authorization**.
9. **What the service sees.** Open **Service dashboard**: Diego (`DR-9100004`) shows “Withdrawn · data deleted”.
10. **Civil registry refusal.** In “Vacuna al día” open “Do you have the child's record number?”, enter `DR-9100007` and click **Connect**. Sign in as Pedro (`001-0000006-6`) and click **Continue**: “Could not authorize”. Nothing about Camila was shown. **Return to the app** shows access was not authorized.
11. **Almost 18.** As Altagracia (`001-0000007-7`) pick Miguel: the authorization ends on 20 November 2026.
12. **Legal guardian.** As Ramón (`001-0000005-5`): “You are acting as legal guardian of …”.
13. **Keep.** As María, in **My authorizations** withdraw Sofía's with **Keep them**. The dashboard shows “Withdrawn · data kept”: the service reads nothing new but may use what it received.

To start over: `scripts/demo-dr-vacuna/deploy/reset.sh fly` (see DEPLOY.md).
