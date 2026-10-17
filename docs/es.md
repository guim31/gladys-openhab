# Puente openHAB

Esta integración conecta Gladys con **su servidor openHAB** y ofrece sus items
en la pestaña **Descubrir** de Gladys: luces, interruptores y enchufes,
persianas y cortinas, consignas de temperatura, sensores con sus unidades,
contactos, detectores, reproductores y cerraduras. Una vez añadido un
dispositivo, sus estados siguen a openHAB **en directo**, y Gladys lo controla
**a través de openHAB**, que conserva sus bindings (Zigbee, Z-Wave, KNX, Modbus,
nube…). Pase a Gladys a su ritmo, o haga funcionar ambos en paralelo. Todo se
queda en su red local. No oficial, sin relación con la fundación openHAB.

> Probada con openHAB 5.0.1 en Docker e items virtuales (sin binding), aún no en
> muchas instalaciones reales: sus comentarios son bienvenidos en el
> repositorio de GitHub.

## Requisitos

- openHAB 4.x o 5.x, accesible desde la máquina de Gladys (misma red, o una
  VPN).
- Un **token de API** de un usuario de openHAB (preferiblemente administrador:
  ejecutar una regla desde una escena lo requiere). Si su openHAB acepta
  peticiones sin inicio de sesión (su «rol de usuario implícito» por defecto),
  no se necesita token.

## Configuración

### Dirección y token

1. En openHAB (Main UI), abra su perfil (abajo a la izquierda) y luego **Create
   new API token**. Llámelo «Gladys» y copie el token: openHAB solo lo muestra
   una vez.
2. En Gladys, abra la integración, **Configuración**:
   - **Dirección de openHAB**: como `http://192.168.1.30:8080`, o
     `https://openhab.example.org` detrás de un proxy inverso. Sin nombre
     `.local`, sin `localhost`: la integración funciona en su propio
     contenedor.
   - **Token de API**: péguelo. Un **usuario y una contraseña** también sirven,
     solo si la autenticación básica está activada en openHAB (Settings → API
     Security).
3. Haga clic en **Probar la conexión**: se muestran la versión de openHAB, el
   número de dispositivos ofrecidos y los tipos de items no importados.
4. Abra la pestaña **Descubrir** y añada los dispositivos que quiera. Sus
   valores se envían en cuanto se añaden.

### Elegir qué se importa

Una instalación de openHAB tiene a menudo cientos de items. Gladys ofrece:

- solo los items de los **grupos** indicados, si los hay (nombres o etiquetas
  de grupos, separados por comas, como `gGroundFloor, Jardín`; un item cuenta
  si está en uno de ellos, a cualquier profundidad);
- solo los items con una de las **etiquetas** indicadas, si las hay (etiquetas
  del item o de su equipo: etiquetas semánticas como `Lightbulb`,
  `Temperature`, o las suyas, como `Gladys`);
- nunca los items indicados en **Items a excluir** (`*_Signal`, `*` sustituye
  cualquier texto).

Los items de tipo grupo nunca son dispositivos: son las ubicaciones y equipos
del modelo semántico. Solo los dispositivos añadidos en Gladys reciben estados:
los demás no cuestan nada.

### Cerraduras, puertas de garaje y portones

Por defecto, las **cerraduras** (items con la etiqueta `Lock`, o puntos de un
equipo `Lock`), y todo item de una **puerta de garaje**, un **portón** o una **puerta** (persiana, interruptor por impulso, cerradero, abridor), con esa etiqueta o punto de tal equipo, son de **solo lectura** en Gladys: usted ve si están
cerrados con llave, abiertos o cerrados, pero ni un dispositivo, ni una escena,
ni un asistente de voz vinculado a Gladys puede abrirlos. Marque **Permitir
comandos de cerraduras, puertas de garaje y portones** para controlarlos (luego
haga clic en «Actualizar» en esos dispositivos en la pestaña Descubrir). La
acción de escena que envía un comando también los rechaza, así como un grupo
que contenga uno de ellos, mientras esta casilla no esté marcada.

### Opciones

- **Intervalo mínimo entre dos valores de un sensor**: 10 segundos por defecto.
  Un contador que informa cada segundo se envía a Gladys a este ritmo.
  Interruptores, luces, persianas y detectores nunca se retrasan.
- **Idioma de los nombres de funciones**: las palabras añadidas a los nombres
  de las funciones secundarias («Persiana – Posición»). Francés por defecto.
- **Items vigilados para las escenas**: vea el disparador de escena más abajo.

## Lo que obtiene

### Dispositivos

Un dispositivo de Gladys por **equipo** del modelo semántico de openHAB, con
las funciones de sus puntos (una luz con su interruptor, su regulador y su
color); un item fuera de todo equipo es un dispositivo propio. El nombre es la
etiqueta de openHAB, con su ubicación («Lámpara de techo (Salón)»).

| Item de openHAB                                  | En Gladys                                                      |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `Switch`                                         | un interruptor, o una luz (etiqueta `Light`, equipo de luz)    |
| `Switch` con `Alarm`/`Status` + Smoke, Water…    | detector de humo, fuga, CO, movimiento, sabotaje o vibración   |
| `Switch` con etiqueta `Lock`                     | cerrado con llave o no (solo lectura salvo autorización)       |
| `Dimmer`                                         | brillo de una luz (con encendido/apagado si está solo)         |
| `Dimmer` con etiqueta `SoundVolume`              | el volumen de un reproductor                                   |
| `Color`                                          | color y brillo de una luz (con encendido/apagado si está solo) |
| `Rollershutter`                                  | una persiana (o cortina): abrir, cerrar, parar, posición       |
| `Rollershutter` puerta de garaje, portón, puerta | abierto o cerrado, posición (solo lectura salvo autorización)  |
| `Contact`                                        | un detector de apertura                                        |
| `Player`                                         | estado de reproducción, reproducir, pausa, siguiente, anterior |
| `Number:Temperature` con etiqueta `Setpoint`     | una consigna de termostato, dentro del mín. y máx. del item    |
| `Number:Temperature`, `Pressure`, `Illuminance`… | temperatura, presión, luz, potencia, energía, tensión          |
|                                                  | corriente, volumen (gas, agua), viento, ruido, lluvia          |
| `Number` en % con Humidity, o llamado batería    | humedad, nivel de batería                                      |
| `Number` en ppm con etiqueta `CO2`               | un sensor de CO2                                               |

Los items `String`, `DateTime`, `Location`, `Call`, `Image` y los grupos no se
importan (la prueba de conexión los indica); un `String` puede aun así activar
una escena (disparador más abajo) o recibir un comando (acción de escena). Un
`Number` sin unidad ni significado tampoco se importa: dele una dimensión
(`Number:Power`) o una etiqueta semántica.

La posición de una persiana sigue a Gladys: 100 % es abierta (openHAB dice
0 %). Un `Number:Dimensionless` sin metadato `unit` guarda su estado en «one»
en openHAB (48 % es `0.48`): el puente lo muestra en la unidad de su patrón,
como openHAB.

### Widget del panel

**openHAB**: la conexión, cómo llegan los estados (flujo de eventos o consulta
periódica), la versión de openHAB, los dispositivos ofrecidos y añadidos, los
items seguidos, y un botón **Recargar** que vuelve a leer la lista de items.

### Disparadores de escena

**Item de openHAB modificado**: un item indicado en **Items vigilados para las
escenas** cambió de estado, aunque no esté añadido a Gladys (un String, un modo
de alarma, un timbre). Filtros: el item, y el nuevo estado (opcional).
Variables: item, etiqueta, nuevo estado, estado anterior.

### Acciones de escena

- **Enviar un comando a un item de openHAB**: cualquier item, cualquier comando
  (`ON`, `OFF`, `50`, `UP`, `PLAY`, un texto). Útil para los items sin función
  en Gladys, o para iniciar una regla de openHAB mediante un interruptor
  virtual.
- **Ejecutar una regla de openHAB**: por su identificador (UID, visible en
  Settings → Rules); las escenas de openHAB también son reglas. Requiere el
  token de un administrador.

## Ejemplos de escenas

- Cuando el item de openHAB `Alarm_Mode` pase a `ARMED` (item vigilado), apagar
  todas las luces de Gladys y enviar un mensaje.
- Al atardecer, enviar `DOWN` al grupo de openHAB `gShutters` (acción de
  escena).
- Cuando la presencia de Gladys salga de casa, ejecutar la regla de openHAB
  `away_mode`.

## Solución de problemas

- **«openHAB rechaza el acceso»**: el token es incorrecto o se borró; cree uno
  nuevo. Con un usuario, la autenticación básica debe estar activada en
  openHAB.
- **«openHAB no está accesible»**: compruebe la dirección desde la máquina de
  Gladys (`curl http://<dirección>:8080/rest/`). Se hace un nuevo intento tras
  5 segundos, luego hasta cada minuto.
- **El widget indica «Consulta periódica»**: el flujo de eventos
  (`/rest/events`) no pasa, a menudo por un proxy inverso que lo almacena en
  búfer. Los estados llegan igualmente cada 30 segundos; el flujo se reintenta
  con regularidad.
- **Falta un item**: ejecute la prueba de conexión, indica los tipos no
  importados. Compruebe los grupos, etiquetas y exclusiones de la
  configuración.
- **Un valor es 100 veces demasiado grande o pequeño**: el item es un
  `Number:Dimensionless` cuyo patrón dice `%` mientras openHAB lo guarda en
  «one», o al revés; dele un metadato `unit` en openHAB.
- **Registros**: ponga `LOG_LEVEL=debug` para ver cada estado y evento.

## Límites

- Desarrollada contra openHAB 5.0.1 con items virtuales: ni binding ni hardware
  real. Sus comentarios son bienvenidos.
- Los grupos no son dispositivos: un grupo de luces se puede controlar aun así
  con la acción de escena.
- Un modo de termostato, una temperatura de color o una velocidad de
  ventilador no tienen tipo de item propio en openHAB: llegan como Number o
  Dimmer, y se importan como tales si tienen unidad, o no se importan.
- Cambiar el nombre de un item en openHAB crea otro item: el dispositivo de
  Gladys debe añadirse de nuevo. Mover un item a otro equipo también cambia su
  dispositivo de Gladys.
- Los nombres de las funciones se fijan al añadir el dispositivo en Gladys.

## Privacidad

El puente solo habla con su servidor openHAB, en su red. Gladys guarda el token
(o la contraseña) en su configuración y nunca se escribe en los registros. Nada
sale a Internet.
