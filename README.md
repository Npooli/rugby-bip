# Rugby BIP

App web para registrar en vivo el tiempo real de juego (BIP — Ball In Play / BOP — Ball Out of Play) durante entrenamientos y partidos de rugby: cuánto tiempo estuvo la pelota en juego, cuánto tiempo hubo de pausa, rucks, patadas, y de dónde salió cada reinicio (Scrum, Line Out, Juego libre, Patada).

Funciona 100% en el navegador, sin cuentas ni servidor: los datos quedan en el celular hasta que los exportás (CSV, PDF o JSON). No hace falta instalar nada de una tienda de apps — se agrega a la pantalla de inicio como una app normal.

**App en vivo:** https://npooli.github.io/rugby-bip/

---

## Instalar en el celular (pantalla de inicio)

### iPhone / iPad (Safari)

1. Abrí el link de la app **en Safari** (tiene que ser Safari, no funciona desde Chrome en iPhone).
2. Tocá el ícono de **Compartir** (el cuadrado con la flecha hacia arriba), abajo al centro de la pantalla.
3. Deslizá hacia abajo en el menú que se abre y tocá **"Agregar a inicio"**.
4. Confirmá el nombre ("Rugby BIP") y tocá **"Agregar"**.
5. Ya aparece un ícono en la pantalla de inicio. Se abre a pantalla completa, como cualquier otra app.

### Android (Chrome)

1. Abrí el link de la app en Chrome.
2. Puede aparecer directamente un cartel abajo sugiriendo "Agregar Rugby BIP a la pantalla de inicio" — si aparece, tocá ahí y listo.
3. Si no aparece: tocá el menú de **3 puntos** arriba a la derecha → **"Agregar a la pantalla de inicio"** (o "Instalar app", según la versión de Chrome).
4. Confirmá y ya queda el ícono instalado.

Una vez instalada, la app funciona **sin conexión** — el service worker guarda todo lo necesario la primera vez que se abre con internet.

---

## Cómo se usa

La app tiene 3 pantallas, con pestañas de navegación arriba (Inicio / Vivo / Edición) que se pueden usar en cualquier momento sin perder lo que esté pasando.

### 1. Inicio

- **Nombre de la sesión**: ponele un nombre (ej. "U20 vs Japón", "Entreno MD-3") antes de arrancar.
- **Iniciar sesión en vivo**: arranca el cronómetro de la sesión y pasa a la pantalla Vivo.
- **Importar XML**: para cargar una sesión ya codificada en Angles (u otro software compatible) en vez de grabarla en vivo.
- **Abrir una sesión anterior para editar**: lleva directo a Edición, donde también se puede importar una sesión exportada antes en JSON.

Si quedó una sesión sin terminar (se cerró la pestaña, se bloqueó el celular), al volver a abrir la app se ofrece continuarla o descartarla.

### 2. Vivo (captura en tiempo real)

Acá se registra todo mientras pasa el entrenamiento:

- **Iniciar período**: cada ejercicio/drill es un "período" (mismo término que en Catapult). Ponele nombre y arrancá.
- **Datos en vivo**: el balón central muestra la fase actual (BIP o BOP) y cuánto lleva **esa secuencia puntual** — se resetea cada vez que cambia la fase. Abajo, "Juego real %" y el ratio trabajo:descanso del período, y los tiempos acumulados de BIP/BOP.
- **Origen del reinicio**: tocá Scrum / Line Out / Juego libre / Patada para marcar que arrancó el juego (BIP). Tocá "Fuera de juego" para volver a BOP.
- **RUCK / KICK**: suman al contador de cada evento sin cambiar la fase.
- **Live Feed**: el historial de todo lo que fue pasando en este período, de más reciente a más viejo. "Deshacer último" saca el último toque; cada línea también se puede borrar individualmente (✕) si te equivocaste en el medio.
- **Finalizar período** / **Finalizar sesión**: piden confirmación para evitar toques accidentales.

La pantalla se mantiene encendida sola mientras hay una sesión corriendo (Wake Lock), y se vuelve a activar si el celular se bloqueó y se desbloquea de nuevo.

### 3. Edición + Exportación

Se habilita cuando la sesión está finalizada:

- **Línea de tiempo**: vista visual de toda la sesión, con cada período y sus tramos BIP/BOP.
- **Editar períodos**: corregir el nombre de un período, mover el inicio/fin de un tramo BIP/BOP (por si un toque quedó mal registrado), o borrar un tramo o un evento suelto. Tocar un bloque de la línea de tiempo lleva directo a editarlo.
- **Resumen**: BIP/BOP total de la sesión, % de juego real, reinicios por tipo, eventos, densidad de Ruck/Kick (por minuto y por minuto de BIP), y racha más larga (WCS) — filtrable por período o para toda la sesión.
- **Exportar**: CSV (para planillas), JSON (para volver a importar y seguir editando otro día), PDF (para imprimir/guardar), o Compartir (manda el CSV por WhatsApp, mail, etc. desde el mismo celular).

---

## Notas técnicas

- Sin build step: HTML/CSS/JS planos, sin dependencias ni frameworks.
- Sin backend: todo el estado vive en `localStorage` del navegador hasta que se exporta. Exportá seguido (CSV/JSON) para no perder datos si se cambia de celular o se borra el navegador.
- Desplegado en GitHub Pages desde la rama `main`.

Hecho por Nicolás D. Pooli.
