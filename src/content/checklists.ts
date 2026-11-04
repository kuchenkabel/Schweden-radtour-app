export interface CheckItem { id: string; title: string; note?: string; dueDaysBefore?: number }
export interface CheckGroup { id: string; title: string; items: CheckItem[] }

export const PACKLISTE: CheckGroup[] = [
  {
    id: 'fahrrad',
    title: 'Fahrräder & Ersatzteile',
    items: [
      { id: 'multitool', title: 'Multitool' },
      { id: 'reifenheber', title: 'Reifenheber' },
      { id: 'flickzeug', title: 'Flickzeug' },
      { id: 'kettennieter', title: 'Kettennieter' },
      { id: 'kettenschloss', title: 'Kettenschloss', note: 'Zum Abschließen der Räder unterwegs.' },
      { id: 'ersatzschlaeuche', title: 'Ersatzschläuche je Reifengröße', note: 'Für alle Reifengrößen der Familie, auch 20 Zoll für den Anhänger.' },
      { id: 'luftpumpe', title: 'Gute Luftpumpe' },
    ],
  },
  {
    id: 'sicherheit',
    title: 'Sicherheit',
    items: [
      { id: 'warnwesten-kinder', title: 'Warnwesten für die Kinder', note: 'Schwedische Autofahrer sind rücksichtsvoll, erwarten aber Sichtbarkeit.' },
      { id: 'helme', title: 'Helme für alle', note: 'Auch für das Kleinkind.' },
      { id: 'licht', title: 'Front- und Rücklicht', note: 'Für Dämmerung, Tunnel und Wald.' },
    ],
  },
  {
    id: 'schlafen',
    title: 'Schlafen',
    items: [
      { id: 'schlafsaecke', title: 'Warme Schlafsäcke', note: 'Schwedische Nächte im August können auf 8 °C fallen.' },
      { id: 'isomatten', title: 'Gut isolierende Isomatten' },
      { id: 'zelte', title: 'Zelte mit Heringen und Gestänge', note: 'Familien-Tunnelzelt oder 3-Personen- plus 2-Personen-Zelt. Der 13-Jährige schläft vielleicht lieber separat.' },
    ],
  },
  {
    id: 'kochen-feuer',
    title: 'Kochen & Feuer',
    items: [
      { id: 'gaskocher', title: 'Gaskocher', note: 'Brennstoff-Backup, falls Feuerverbot (Eldningsförbud) herrscht. Dies kommt im Hochsommer oft vor.' },
      { id: 'gaskartuschen', title: 'Ausreichend Gaskartuschen', note: 'Schraubkartuschen gibt es im Baumarkt oder Sportgeschäft, selten im Supermarkt.' },
      { id: 'dutch-oven', title: 'Dutch Oven oder gusseiserne Pfanne' },
      { id: 'hitzehandschuhe', title: 'Hitzebeständige Handschuhe', note: 'Für das Kochen am Windschutz.' },
      { id: 'zuendstahl', title: 'Zündstahl oder Feuerzeug' },
      { id: 'kochgeschirr', title: 'Kochgeschirr und Besteck' },
    ],
  },
  {
    id: 'wasser',
    title: 'Wasser',
    items: [
      { id: 'wasserfilter', title: 'Wasserfilter', note: 'Z.B. Katadyn oder Sawyer, für Seen und Bäche.' },
      { id: 'wasserbeutel', title: 'Wasserbeutel mit 10 bis 15 Litern Kapazität', note: 'Für 5 Personen: Abendessen, Trinken und Frühstück. Z.B. Ortlieb.' },
    ],
  },
  {
    id: 'hygiene',
    title: 'Hygiene',
    items: [
      { id: 'klappspaten', title: 'Klappspaten', note: 'Für Geschäfte beim Wildcamping.' },
      { id: 'bioseife', title: 'Biologisch abbaubare Seife und Spülmittel' },
      { id: 'toilettenpapier', title: 'Toilettenpapier in Zip-Beuteln' },
      { id: 'muellsaecke', title: 'Müllsäcke', note: 'Müll wird mitgenommen.' },
    ],
  },
  {
    id: 'gesundheit-erste-hilfe',
    title: 'Gesundheit & Erste Hilfe',
    items: [
      { id: 'erste-hilfe-set', title: 'Großes Familien-Erste-Hilfe-Set', note: 'Pflaster, Desinfektion, Verbandszeug, Pinzette.' },
      { id: 'schmerzmittel', title: 'Schmerzmittel für Erwachsene und Kinder', note: 'Kindgerechte Dosierung mitnehmen.' },
      { id: 'fieberthermometer', title: 'Fieberthermometer' },
      { id: 'zeckenzange', title: 'Zeckenzange' },
      { id: 'mueckenspray', title: 'Mückenspray', note: 'Myggmedel am besten lokal in Schweden kaufen, z.B. Mygga.' },
      { id: 'eigene-medikamente', title: 'Eigene Medikamente', note: 'Viele Medikamente gibt es in Schweden nicht im Supermarkt.' },
    ],
  },
  {
    id: 'kleidung',
    title: 'Kleidung',
    items: [
      { id: 'regenjacke', title: 'Regenjacke für alle', note: 'Absolut wind- und wasserdicht.' },
      { id: 'regenhose', title: 'Regenhose für alle', note: 'Absolut wind- und wasserdicht.' },
      { id: 'fleecejacke', title: 'Fleecejacke für alle' },
      { id: 'merino-shirts', title: 'Merino-Shirts' },
    ],
  },
  {
    id: 'camp',
    title: 'Fürs Camp',
    items: [
      { id: 'camp-schuhe', title: 'Leichte Camp-Schuhe', note: 'Crocs oder Sandalen.' },
      { id: 'badesachen', title: 'Badesachen' },
      { id: 'mikrofaser-handtuecher', title: 'Schnelltrocknende Mikrofaser-Handtücher' },
      { id: 'waescheleine', title: 'Wäscheleine und Klammern' },
    ],
  },
  {
    id: 'kinder',
    title: 'Kinder & Kleinkind',
    items: [
      { id: 'windeln', title: 'Windeln und Feuchttücher', note: 'Für das Kleinkind im Anhänger.' },
      { id: 'kuscheltier', title: 'Kuscheltier oder Lieblingsdecke' },
      { id: 'spiele', title: 'Spiele und Kartenspiel', note: 'Für lange Mittagspausen am See.' },
      { id: 'sonnenhut', title: 'Sonnenhut für alle Kinder' },
      { id: 'sonnencreme', title: 'Sonnencreme', note: 'Auch für die Kinder, mit hohem Lichtschutz.' },
      { id: 'anhaenger-regenverdeck', title: 'Anhänger-Regenverdeck', note: 'Schützt das Kleinkind vor Regen und Mücken.' },
      { id: 'schwimmweste-kleinkind', title: 'Schwimmweste für das Kleinkind', note: 'Auch am Badeplatz.' },
    ],
  },
  {
    id: 'technik',
    title: 'Technik',
    items: [
      { id: 'powerbank', title: 'Powerbank' },
      { id: 'ladekabel', title: 'Ladekabel und Netzadapter', note: 'In Schweden gibt es Steckdosen Typ C und F.' },
      { id: 'handyhalterung', title: 'Handyhalterungen für alle Räder' },
      { id: 'stirnlampen', title: 'Stirnlampen' },
    ],
  },
];

export const VOR_DER_TOUR: CheckGroup[] = [
  {
    id: 'vdt-dokumente',
    title: 'Dokumente',
    items: [
      { id: 'reisepaesse', title: 'Reisepässe und Ausweise prüfen', note: 'Gültige Dokumente für alle 5 Personen, auch für das Kleinkind im Anhänger.', dueDaysBefore: 120 },
    ],
  },
  {
    id: 'vdt-gesundheit',
    title: 'Gesundheit & Versicherung',
    items: [
      { id: 'ehic', title: 'EHIC und Auslandskrankenversicherung prüfen', note: 'Europäische Krankenversicherungskarte im Gepäck.', dueDaysBefore: 60 },
      { id: 'fsme', title: 'FSME-Impfung', note: 'Die Grundimmunisierung braucht mehrere Monate. Südschweden und die Schären sind Risikogebiete.', dueDaysBefore: 180 },
    ],
  },
  {
    id: 'vdt-buchungen',
    title: 'Buchungen & Route',
    items: [
      { id: 'stf-mitgliedschaft', title: 'STF-Mitgliedschaft abschließen', note: 'Spart deutlich Geld bei Hostels und vielen Campingplätzen.', dueDaysBefore: 30 },
      { id: 'faehre-zug-buchen', title: 'Fähre oder Zug mit Anhänger-Stellplatz buchen', note: 'Z.B. Vogelfluglinie oder Kiel-Göteborg. Stellplätze früh reservieren.', dueDaysBefore: 120 },
      { id: 'region-route', title: 'Region und Route festlegen', note: 'Tagesetappen von 30 bis max. 50 km, angepasst an den 8-Jährigen.', dueDaysBefore: 90 },
    ],
  },
  {
    id: 'vdt-raeder',
    title: 'Räder & Anhänger',
    items: [
      { id: 'anhaenger-check', title: 'Anhänger-Check', note: 'Kupplung am Zugrad fest, Reifenprofil, Ersatzschlauch (meist 20 Zoll) dabei, Mückennetz intakt.', dueDaysBefore: 14 },
      { id: 'bremsbelaege', title: 'Bremsbeläge bei allen Rädern erneuern', note: 'Der Anhänger schiebt beim Bremsen stark.', dueDaysBefore: 21 },
      { id: 'gaskartuschen-typ', title: 'Gaskartuschen-Typ klären', note: 'Passt der Anschluss zum Gaskocher?', dueDaysBefore: 14 },
    ],
  },
  {
    id: 'vdt-app',
    title: 'App & Handys',
    items: [
      { id: 'offline-karte', title: 'Offline-Karte in der App laden', dueDaysBefore: 3 },
      { id: 'notfallkarte', title: 'Notfallkarte in der App ausfüllen', note: 'Allergien, Medikamente und Notfallkontakte für alle 5 Personen.', dueDaysBefore: 7 },
      { id: 'xiaomi-akku', title: 'Xiaomi-Akku-Einstellungen auf allen Handys setzen', note: 'Anleitung in der App. Gilt für Redmi-Handys mit MIUI oder HyperOS.', dueDaysBefore: 3 },
    ],
  },
];
