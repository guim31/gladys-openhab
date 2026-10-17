// -----------------------------------------------------------------------------
// Every text the container produces, in the four languages of the Gladys
// interface. German says "du", Spanish "usted" (test/i18n.test.js).
// openHAB and its item names are never translated.
// -----------------------------------------------------------------------------

/** Suffixes of the secondary features of an item ("Ceiling lamp – Brightness"). */
export const ROLE_NAMES = {
  en: {
    state: 'State',
    value: 'Value',
    power: 'On/off',
    brightness: 'Brightness',
    color: 'Colour',
    command: 'Open/close',
    position: 'Position',
    contact: 'Open or closed',
    volume: 'Volume',
    playback: 'Playback',
    play: 'Play',
    pause: 'Pause',
    next: 'Next',
    previous: 'Previous',
  },
  fr: {
    state: 'État',
    value: 'Valeur',
    power: 'Marche/arrêt',
    brightness: 'Luminosité',
    color: 'Couleur',
    command: 'Ouvrir/fermer',
    position: 'Position',
    contact: 'Ouvert ou fermé',
    volume: 'Volume',
    playback: 'État de lecture',
    play: 'Lecture',
    pause: 'Pause',
    next: 'Suivant',
    previous: 'Précédent',
  },
  de: {
    state: 'Zustand',
    value: 'Wert',
    power: 'Ein/Aus',
    brightness: 'Helligkeit',
    color: 'Farbe',
    command: 'Öffnen/Schließen',
    position: 'Position',
    contact: 'Offen oder geschlossen',
    volume: 'Lautstärke',
    playback: 'Wiedergabestatus',
    play: 'Wiedergabe',
    pause: 'Pause',
    next: 'Weiter',
    previous: 'Zurück',
  },
  es: {
    state: 'Estado',
    value: 'Valor',
    power: 'Encendido/apagado',
    brightness: 'Brillo',
    color: 'Color',
    command: 'Abrir/cerrar',
    position: 'Posición',
    contact: 'Abierto o cerrado',
    volume: 'Volumen',
    playback: 'Estado de reproducción',
    play: 'Reproducir',
    pause: 'Pausa',
    next: 'Siguiente',
    previous: 'Anterior',
  },
};

/** Connection statuses (Configuration screen, widget). */
export const STATUS = {
  not_configured: {
    en: 'Type the address of openHAB.',
    fr: "Saisissez l'adresse d'openHAB.",
    de: 'Gib die Adresse von openHAB ein.',
    es: 'Escriba la dirección de openHAB.',
  },
  invalid_url: {
    en: 'The address of openHAB is not valid (example: http://192.168.1.30:8080).',
    fr: "L'adresse d'openHAB n'est pas valide (exemple : http://192.168.1.30:8080).",
    de: 'Die Adresse von openHAB ist ungültig (Beispiel: http://192.168.1.30:8080).',
    es: 'La dirección de openHAB no es válida (ejemplo: http://192.168.1.30:8080).',
  },
  auth_failed: {
    en: 'openHAB refused the access: check the API token, or the user name and password.',
    fr: "openHAB refuse l'accès : vérifiez le jeton d'API, ou le nom d'utilisateur et le mot de passe.",
    de: 'openHAB verweigert den Zugriff: Prüfe das API-Token oder Benutzername und Passwort.',
    es: 'openHAB rechaza el acceso: compruebe el token de API, o el usuario y la contraseña.',
  },
  unreachable: {
    en: 'openHAB is unreachable, new attempt in a moment.',
    fr: 'openHAB est injoignable, nouvel essai dans un instant.',
    de: 'openHAB ist nicht erreichbar, neuer Versuch gleich.',
    es: 'openHAB no está accesible, nuevo intento en un momento.',
  },
};

/** Errors returned to Gladys (command toasts, scene action logs). */
export const ERRORS = {
  offline: {
    en: 'openHAB is not connected.',
    fr: "openHAB n'est pas connecté.",
    de: 'openHAB ist nicht verbunden.',
    es: 'openHAB no está conectado.',
  },
  unknown_feature: {
    en: 'This feature is no longer offered by openHAB: scan again.',
    fr: "Cette fonctionnalité n'est plus proposée par openHAB : relancez une recherche.",
    de: 'Diese Funktion bietet openHAB nicht mehr an: Suche erneut.',
    es: 'openHAB ya no ofrece esta función: vuelva a buscar.',
  },
  security_disabled: {
    en: 'Commands of locks, garage doors and gates are disabled in the configuration.',
    fr: 'Les commandes des serrures, portes de garage et portails sont désactivées dans la configuration.',
    de: 'Befehle für Schlösser, Garagentore und Tore sind in der Konfiguration deaktiviert.',
    es: 'Los comandos de cerraduras, puertas de garaje y portones están desactivados en la configuración.',
  },
  out_of_range: {
    en: 'Value outside the limits openHAB gives for this item.',
    fr: "Valeur hors des limites qu'openHAB donne pour cet item.",
    de: 'Wert außerhalb der Grenzen, die openHAB für dieses Item angibt.',
    es: 'Valor fuera de los límites que openHAB indica para este item.',
  },
  unsupported_value: {
    en: 'openHAB does not offer this value for this item.',
    fr: 'openHAB ne propose pas cette valeur pour cet item.',
    de: 'openHAB bietet diesen Wert für dieses Item nicht an.',
    es: 'openHAB no ofrece este valor para este item.',
  },
  bad_item: {
    en: 'Write the name of the openHAB item, for example Kitchen_Light.',
    fr: "Écrivez le nom de l'item openHAB, par exemple Kitchen_Light.",
    de: 'Schreibe den Namen des openHAB-Items, zum Beispiel Kitchen_Light.',
    es: 'Escriba el nombre del item de openHAB, por ejemplo Kitchen_Light.',
  },
  bad_command: {
    en: 'Write the command to send, for example ON, OFF, 50 or UP.',
    fr: 'Écrivez la commande à envoyer, par exemple ON, OFF, 50 ou UP.',
    de: 'Schreibe den zu sendenden Befehl, zum Beispiel ON, OFF, 50 oder UP.',
    es: 'Escriba el comando a enviar, por ejemplo ON, OFF, 50 o UP.',
  },
  bad_rule: {
    en: 'Write the identifier (UID) of the openHAB rule.',
    fr: "Écrivez l'identifiant (UID) de la règle openHAB.",
    de: 'Schreibe die Kennung (UID) der openHAB-Regel.',
    es: 'Escriba el identificador (UID) de la regla de openHAB.',
  },
  not_found: {
    en: 'openHAB does not know this item or rule: ',
    fr: 'openHAB ne connaît pas cet item ou cette règle : ',
    de: 'openHAB kennt dieses Item oder diese Regel nicht: ',
    es: 'openHAB no conoce este item o esta regla: ',
  },
  forbidden: {
    en: 'openHAB refused: running a rule needs an API token of an administrator.',
    fr: "openHAB refuse : lancer une règle demande le jeton d'API d'un administrateur.",
    de: 'openHAB lehnt ab: Eine Regel auszuführen braucht das API-Token eines Administrators.',
    es: 'openHAB rechaza: ejecutar una regla requiere el token de API de un administrador.',
  },
  refused: {
    en: 'openHAB refused the command: ',
    fr: 'openHAB a refusé la commande : ',
    de: 'openHAB hat den Befehl abgelehnt: ',
    es: 'openHAB rechazó el comando: ',
  },
};

/** Words of the connection test and of the widget. */
export const WORDS = {
  en: {
    connected: 'Connected',
    unreachable: 'Unreachable',
    not_configured: 'Not configured',
    auth_failed: 'Access refused',
    connecting: 'Connecting',
    version: 'Version',
    connection: 'Connection',
    live: 'Live updates',
    live_on: 'Event stream',
    live_off: 'Polling',
    offered: 'Devices offered',
    added: 'Devices added',
    followed: 'Items followed',
    reload: 'Reload',
    reloaded: 'Item list read again.',
  },
  fr: {
    connected: 'Connecté',
    unreachable: 'Injoignable',
    not_configured: 'Non configuré',
    auth_failed: 'Accès refusé',
    connecting: 'Connexion',
    version: 'Version',
    connection: 'Connexion',
    live: 'Mises à jour',
    live_on: "Flux d'événements",
    live_off: 'Interrogation',
    offered: 'Appareils proposés',
    added: 'Appareils ajoutés',
    followed: 'Items suivis',
    reload: 'Relire',
    reloaded: 'Liste des items relue.',
  },
  de: {
    connected: 'Verbunden',
    unreachable: 'Nicht erreichbar',
    not_configured: 'Nicht konfiguriert',
    auth_failed: 'Zugriff verweigert',
    connecting: 'Verbinde',
    version: 'Version',
    connection: 'Verbindung',
    live: 'Aktualisierung',
    live_on: 'Ereignisstrom',
    live_off: 'Abfrage',
    offered: 'Angebotene Geräte',
    added: 'Hinzugefügte Geräte',
    followed: 'Verfolgte Items',
    reload: 'Neu laden',
    reloaded: 'Item-Liste neu gelesen.',
  },
  es: {
    connected: 'Conectado',
    unreachable: 'No accesible',
    not_configured: 'Sin configurar',
    auth_failed: 'Acceso rechazado',
    connecting: 'Conectando',
    version: 'Versión',
    connection: 'Conexión',
    live: 'Actualizaciones',
    live_on: 'Flujo de eventos',
    live_off: 'Consulta periódica',
    offered: 'Dispositivos ofrecidos',
    added: 'Dispositivos añadidos',
    followed: 'Items seguidos',
    reload: 'Recargar',
    reloaded: 'Lista de items releída.',
  },
};

/**
 * The message of the "Test the connection" action.
 * @param {object} r { version, devices, items, ignored: [[reason, count]] }
 */
export function testMessage({ version, devices, items, ignored }) {
  const list = ignored
    .slice(0, 8)
    .map(([reason, count]) => `${reason} (${count})`)
    .join(', ');
  const none = { en: 'none', fr: 'aucun', de: 'keine', es: 'ninguno' };
  const rest = (lang) => list || none[lang];
  return {
    en: `Connected to openHAB ${version}: ${devices} devices offered (${items} items). Not imported: ${rest('en')}.`,
    fr: `Connecté à openHAB ${version} : ${devices} appareils proposés (${items} items). Non importés : ${rest('fr')}.`,
    de: `Mit openHAB ${version} verbunden: ${devices} Geräte angeboten (${items} Items). Nicht importiert: ${rest('de')}.`,
    es: `Conectado a openHAB ${version}: ${devices} dispositivos ofrecidos (${items} items). No importados: ${rest('es')}.`,
  };
}

/** An Error whose message is in the configured language, with the four kept for tests. */
export function localizedError(text, language, detail = '') {
  const err = new Error(`${text[language] ?? text.en}${detail}`);
  err.texts = text;
  return err;
}
