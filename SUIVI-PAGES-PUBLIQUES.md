# Lecture des pages publiques de suivi — 8 septembre 2026

## Objet et périmètre

Cette évolution permet au backend de lire les informations de livraison accessibles publiquement sur les sites officiels DPD, GLS et C Chez Vous. Elle ne nécessite pas d'abonnement à un agrégateur de tracking. Les API officielles déjà configurées pour La Poste/Colissimo/Chronopost, UPS, DHL et FedEx restent prioritaires et inchangées.

IMPORTANT : cette archive a été validée avec des réponses HTML/API simulées. Les pages des trois transporteurs n'ont pas pu être interrogées en direct depuis l'environnement de développement. Il ne s'agit donc pas d'une garantie de compatibilité avec leurs gabarits actuels ni d'une preuve que tous les colis seront détectés. Tester sur une copie de l'application et comparer quelques suivis réels avant généralisation. Les pages peuvent changer, être protégées ou être soumises à des conditions interdisant leur lecture automatisée.

## Fonctionnement

- Le serveur reçoit le transporteur, le numéro et, lorsqu'il est disponible et autorisé, le lien de suivi marketplace.
- Seules les URL HTTPS des domaines officiels et des chemins de suivi explicitement autorisés sont ouvertes. Le numéro inclus dans le lien doit correspondre au numéro demandé. Les URL inconnues ne sont pas utilisées comme cibles de scraping.
- DPD : lecture des tableaux d'événements datés rattachés au colis. Les étapes décoratives, FAQ, prévisions de livraison et notifications ne constituent pas une preuve de livraison. Les retours à l'expéditeur restent des incidents. Une page multi-colis dont l'historique ne peut pas être attribué sans ambiguïté est refusée.
- GLS et C Chez Vous : lecture de données structurées ou d'un panneau de statut explicite lié au numéro demandé, lorsqu'ils sont présents. Aucun statut n'est déduit d'un simple écran de recherche ou d'un état de paiement/commande. Les pages nécessitant un code de sécurité ou un compte ne sont pas contournées.
- Si le HTML ne contient aucun statut exploitable, un navigateur Chromium facultatif peut tenter le rendu JavaScript. Ce mode est expérimental et n'a pas été validé en production. Il est désactivé par défaut.
- Le résultat comprend le statut normalisé, le libellé brut, les événements disponibles, la date d'événement, la date de vérification et la provenance `statusMethod: "page"`. Un résultat inconnu n'est pas une livraison confirmée.
- Le tableau charge initialement les données marketplace, puis rafraîchit les suivis visibles en arrière-plan. Le cache serveur dure cinq minutes, limite les appels concurrents et conserve le dernier statut connu lorsqu'un nouvel appel échoue. Le bouton de rafraîchissement manuel conserve un délai de protection de trente secondes.

## Configuration

Aucun nouvel abonnement ni aucune nouvelle clé API ne sont nécessaires pour la lecture HTML. Conserver les variables d'environnement et données persistantes existantes.

```env
TRACKING_PAGE_ENABLED=1
TRACKING_PAGE_INTERVAL_MS=2000
TRACKING_PAGE_BROWSER=0
```

`TRACKING_PAGE_ENABLED=0` désactive entièrement la lecture des pages. Les API officielles déjà configurées continuent de fonctionner. La lecture HTML est activée par défaut dans cette version. Le délai entre les travaux d'un même transporteur est au minimum d'une seconde ; deux lectures sont exécutées au maximum simultanément et la file est limitée.

Le mode navigateur n'est pas nécessaire pour démarrer. Pour l'expérimenter sur un serveur disposant de Chromium avec sandbox fonctionnelle et de ressources suffisantes :

```env
TRACKING_PAGE_BROWSER=1
TRACKING_CHROME_PATH=/chemin/absolu/vers/chromium
TRACKING_PAGE_BROWSER_TIMEOUT_MS=18000
```

Le chemin est un exemple et doit correspondre à l'installation réelle. L'application ne télécharge pas Chromium, ne modifie pas automatiquement Render et ne désactive pas sa sandbox. Le navigateur démarre avec un profil temporaire vierge, sans compte ni cookies marketplace. Il limite les requêtes aux domaines officiels, aux méthodes GET/HEAD et aux règles robots applicables ; il ne contourne pas CAPTCHA, authentification ou restrictions d'accès. Le mode peut échouer sur un hébergement qui ne permet pas de lancer Chromium ou dont le réseau est restreint. Ne pas l'activer simplement pour masquer une erreur HTML.

## Installation et déploiement

Depuis le dossier contenant `package.json` :

```bash
npm ci
npm run check
npm test
npm start
```

Le fichier de verrouillage et les dépendances applicatives existants n'ont pas été modifiés. `node_modules` n'est pas inclus dans l'archive. Pour Render, conserver la commande de construction `npm ci` et la commande de démarrage `npm start`, ainsi que le disque persistant s'il est déjà utilisé. Ne pas remplacer les secrets par les exemples de ce document.

## Diagnostic d'un suivi incorrect

Ouvrir la réclamation et vérifier le numéro, le transporteur, l'URL, le libellé brut, la provenance et la date du dernier contrôle. Le endpoint authentifié `/api/reclamations/tracking-config` indique les connecteurs disponibles et distingue API, page et navigateur. Le endpoint `/api/reclamations/tracking?carrier=dpd&number=NUMERO` renvoie le statut normalisé ou un code d'erreur explicite. Un lien officiel peut être transmis dans le paramètre `url`. L'accès exige la session et les protections habituelles de l'application.

Un refus d'accès, une règle robots, un code de sécurité, un numéro non reconnu ou une page sans données exploitables ne doivent pas être interprétés comme « En transit » ou « Livré ». Le site conserve la donnée marketplace ou le dernier statut vérifié et signale l'échec. Si une page fonctionne manuellement mais pas dans l'application, comparer son URL exacte et son HTML anonymisé avec l'extracteur concerné ; ne pas ajouter de règle générale « contient livré ».

La lecture n'est pas prise en charge pour tous les transporteurs. Mondial Relay, Relais Colis, Colis Privé, Geodis et d'autres nécessitent leurs propres connecteurs. Pour GLS et C Chez Vous, une page entièrement dynamique ou exigeant une vérification supplémentaire peut rester inexploitable en mode HTML. Aucune compatibilité universelle n'est annoncée.

## Tests et limites

Les tests automatisés couvrent la correspondance des numéros, les événements chronologiques, les retours, les pages multi-colis, les données structurées, les URL autorisées, les adresses réseau privées, les refus robots, les quotas, le cache et la conservation des statuts précédents. Les fixtures sont synthétiques : elles ne sont pas des captures de production. Le rendu Chromium et les réponses live DPD/GLS/C Chez Vous restent à valider sur le serveur cible. Les identifiants, données bancaires et informations personnelles des clients ne sont pas nécessaires pour ces tests et ne doivent pas être envoyés dans un rapport de bug.
