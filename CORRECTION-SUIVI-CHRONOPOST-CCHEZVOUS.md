# Suivi Chronopost et C Chez Vous — 8 septembre 2026

## Objet

Cette version reprend HTML-main-received-livre-corrige-2026-09-08.zip. Elle conserve les corrections précédentes, notamment la récupération des réclamations Cdiscount, le scroll automatique, le suivi par pages publiques et la règle Received propre à Fnac/Darty. Elle ne modifie ni les identifiants ni les données persistantes.

Le problème traité est l'absence de statut exploitable pour Chronopost et C Chez Vous. Les deux transporteurs nécessitent des chemins différents : Chronopost dispose d'un webservice public documenté, tandis que C Chez Vous utilise une référence de commande qui peut différer du numéro de colis.

## Chronopost

- L'API officielle La Poste Suivi v2 reste prioritaire si LAPOSTE_OKAPI_KEY est configurée.
- La normalisation La Poste lit le schéma shipment.event, shipment.timeline, deliveryDate et isFinal. Elle ne suppose plus l'existence d'un champ shipment.status.
- Un repli vers le webservice public Chronopost trackSkybillV2 est ajouté. Il utilise uniquement le numéro de colis, sans compte expéditeur, cookie ou clé marketplace. Il est indépendant du scraping HTML.
- Le parseur prend en charge les événements SOAP directement sous listEvents et sous listEvents/events, trie les événements datés et contrôle les identifiants disponibles.
- Le lecteur XML refuse les DTD, entités personnalisées, documents malformés et réponses excessives. Aucun contenu XML n'est évalué comme code.
- Un retour ou incident plus récent ne devient pas une livraison confirmée. Une réponse vide ou non reconnue ne fabrique pas de statut.

Configuration facultative :

```env
LAPOSTE_OKAPI_KEY=...          # Clé officielle, si votre entreprise en possède une
CHRONOPOST_PUBLIC_TRACKING=1   # Activé par défaut ; mettre 0 pour désactiver ce repli
```

La clé La Poste est facultative pour le repli public Chronopost, mais elle reste nécessaire pour utiliser l'API La Poste. Ne jamais inscrire une vraie clé dans un fichier HTML, un dépôt public ou une demande de diagnostic.

Documentation :
- https://developer.laposte.fr/catalog-apis/suivi@2
- https://www.chronopost.fr/fr/suivi-colis
- https://ws.chronopost.fr/tracking-cxf/TrackingServiceWS?wsdl

Le contrat public trackSkybillV2 est documenté dans les spécifications techniques Chronopost version 2.5.11, section 2.9.2. Le service peut néanmoins évoluer, limiter les appels ou refuser certains numéros. Aucun accès live n'a été validé depuis l'environnement de développement.

## C Chez Vous

- Les références de commande alphanumériques sont acceptées, y compris celles ne contenant aucun chiffre.
- La référence présente dans un lien officiel /suivi-colis/REFERENCE est conservée séparément du numéro de colis et transmise au backend.
- Le cache distingue les couples numéro de colis / référence de commande afin de ne pas mélanger deux dossiers.
- L'extracteur recherche des statuts de livraison explicites rattachés à la bonne commande, dans les données structurées ou dans un panneau de suivi identifiable.
- Les FAQ, états de paiement/commande, étapes décoratives, prévisions et événements d'autres commandes ne prouvent jamais une livraison.
- Une page vide, protégée ou uniquement chargée en JavaScript conserve le statut marketplace ou le dernier statut fiable et renvoie une erreur de diagnostic. Elle n'est pas déclarée livrée par défaut.

Configuration :

```env
TRACKING_PAGE_ENABLED=1
TRACKING_PAGE_INTERVAL_MS=2000
TRACKING_PAGE_BROWSER=0
```

Le mode HTML est activé par défaut. Le mode Chromium reste facultatif, désactivé et expérimental. Il nécessite un navigateur compatible installé sur le serveur et ne contourne ni CAPTCHA, ni authentification, ni restrictions robots. Son rendu n'a pas été validé sur les pages réelles C Chez Vous. L'activation ne garantit donc pas la récupération du statut.

Pages officielles :
- https://www.cchezvous.fr/suivi-colis
- https://www.cchezvous.fr/suivi-colis/BBC_269148 (exemple de forme de référence)

## Installation et contrôle

Déployer sur une copie de l'application, sauvegarder les données persistantes et conserver les variables d'environnement. Depuis le dossier contenant package.json :

```bash
npm ci
npm run check
npm test
npm start
```

Le package-lock.json est inchangé. Aucun node_modules, fichier .env ou donnée de production n'est inclus. Ne pas recopier d'anciennes dépendances embarquées.

Le contrôle syntaxique et 99 tests automatisés ont réussi dans l'environnement de développement. Les tests couvrent la structure SOAP, la normalisation La Poste v2, les retours, les erreurs XML, les références C Chez Vous, les mauvais numéros, les faux positifs FAQ/progression et la préservation du numéro de colis. Les deux pages HTML sont identiques et le JavaScript principal passe son contrôle syntaxique.

Les réponses transporteurs utilisées dans ces tests sont simulées. L'installation npm complète, le démarrage Express avec les dépendances et les appels réels aux transporteurs n'ont pas été validés dans cet environnement isolé. Ce résultat ne garantit donc pas que tous les suivis réels fonctionneront immédiatement.

## Diagnostic après déploiement

Tester d'abord un numéro Chronopost connu et une commande C Chez Vous dont le lien fonctionne manuellement. L'interface doit conserver le statut marketplace pendant l'interrogation et afficher une provenance explicite lorsqu'un résultat transporteur est exploitable.

La route authentifiée /api/reclamations/tracking-config indique si l'API, le webservice public, la page HTML ou le navigateur sont configurés. La route /api/reclamations/tracking accepte carrier, number et, pour C Chez Vous, reference et url. Exemple de forme :

/api/reclamations/tracking?carrier=chezvous&number=NUMERO_COLIS&reference=REFERENCE_COMMANDE

Une erreur TRACKING_PAGE_UNSUPPORTED signifie qu'aucun statut fiable n'a été extrait ; TRACKING_NUMBER_MISMATCH signale une référence différente ; TRACKING_ACCESS_REQUIRED, TRACKING_RATE_LIMITED et TRACKING_TIMEOUT indiquent respectivement un refus, une limitation ou un délai dépassé. Ne pas convertir ces erreurs en « Livré ».

Si C Chez Vous ne fournit toujours aucun statut, il faudra examiner un exemple réel anonymisé de la page ou de la réponse réseau qui alimente son panneau de suivi. Le numéro de commande peut être remplacé par une valeur fictive cohérente ; masquer noms, adresses, téléphones, cookies, jetons et autres données personnelles. Ne pas transmettre de mot de passe ou clé API. Une adaptation ciblée au vrai format est préférable à une nouvelle règle générale basée sur le mot « livré ».
