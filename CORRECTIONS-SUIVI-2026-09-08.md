# Fiabilisation des statuts de livraison — 8 septembre 2026

Cette version reprend l’archive HTML-main-statut-suivi-corrige.zip. Les corrections précédentes (chargement, sécurité, statistiques, scroll automatique) sont conservées. Aucune donnée de production, aucun identifiant et aucun fichier de session ne sont inclus.

## Problème corrigé

Le précédent système mélangeait statut de commande, texte d’historique et statut transporteur. Certains adaptateurs lisaient le premier événement sans vérifier l’ordre chronologique ; des codes réellement utilisés par les transporteurs n’étaient pas reconnus. Un rechargement des réclamations pouvait également remplacer un résultat transporteur par un ancien statut marketplace.

Les nouvelles règles communes au serveur et à l’interface se trouvent dans `lib/tracking-status.js`. Elles privilégient un statut courant explicite, puis le dernier événement daté. Elles reconnaissent les confirmations de livraison, tout en distinguant préparation, transit, relais, incident et retour. Une absence de date reste une absence de date. Une réponse inconnue ne devient jamais « livré » par défaut.

La fusion des résultats préserve le statut transporteur vérifié contre les anciens instantanés marketplace. Un résultat plus récent peut toutefois corriger un état précédent, notamment en cas de retour. Les événements de numéros de suivi différents ne sont pas fusionnés.

## Connexions transporteurs

`lib/carrier-tracking.js` contient les adaptateurs des API documentées suivantes :

| Transporteur | Configuration serveur | API |
|---|---|---|
| Colissimo, Chronopost | `LAPOSTE_OKAPI_KEY` | La Poste Suivi v2 |
| UPS | `UPS_CLIENT_ID`, `UPS_CLIENT_SECRET` | UPS Tracking + OAuth |
| DHL | `DHL_API_KEY` | DHL Shipment Tracking Unified |
| FedEx, TNT | `FEDEX_CLIENT_ID`, `FEDEX_CLIENT_SECRET` | FedEx Track + OAuth |

Les clés doivent être placées dans les variables d’environnement du serveur (Render, par exemple), jamais dans le HTML ni dans Git. Les identifiants de marketplaces ne remplacent pas les accès aux API transporteurs. La disponibilité de chaque API et les droits du compte doivent être vérifiés auprès du fournisseur.

Les anciens connecteurs DPD, GLS et ChezVous comportaient des endpoints ou méthodes d’authentification non confirmés. Ils ne sont plus présentés comme des connexions réelles. Tant que les contrats API et identifiants correspondants ne sont pas fournis, leurs statuts restent ceux transmis par la marketplace, avec une provenance explicite. Les autres transporteurs non branchés sont traités de la même manière. Aucun contournement par scraping non documenté n’a été ajouté.

L’API refuse désormais une réponse contenant un autre numéro de colis, y compris dans les réponses multi-colis. Les erreurs ne reproduisent pas les réponses brutes contenant potentiellement des secrets. Les requêtes sont bornées à 15 secondes, sans redirection automatique. Les jetons OAuth sont mis en cache.

## Tableau et détail

- Le tableau affiche le libellé du statut, pas uniquement la barre colorée.
- Le titre de la barre et le détail indiquent la provenance et, lorsqu’elle existe, la date de vérification.
- Le suivi des lignes visibles est actualisé silencieusement auprès des transporteurs configurés : quatre appels simultanés au maximum, cache de cinq minutes et déduplication des demandes identiques.
- Le bouton « Rafraîchir » force une nouvelle vérification ; les erreurs de configuration sont explicites.
- Un nouveau chargement de la liste ou du détail ne doit plus effacer un statut transporteur fiable conservé en cache.
- La reconnaissance d’un transporteur depuis le numéro ou l’URL reste disponible lorsque la marketplace ne fournit que « transporteur ».
- Les événements sans date n’affichent plus artificiellement le 01/01/1970.
- Le scroll automatique vers le dernier message est conservé.

## Installation et vérification

Sur une copie de travail, après avoir conservé vos variables d’environnement et sauvegardé les données persistantes :

```bash
npm ci
npm run check
npm test
npm start
```

Le fichier `package-lock.json` est conservé. `node_modules` est volontairement exclu de l’archive ; il doit être reconstruit avec `npm ci`. Les scripts `check` et `test` incluent les nouveaux modules et les tests de suivi.

Validation réalisée : 47 tests automatisés réussis, contrôles syntaxiques du serveur et du JavaScript principal, et six contrôles HTTP isolés (démarrage, script partagé, authentification, CSRF, configuration, erreur de transporteur non configuré). Les tests transporteurs utilisent des réponses simulées et de faux identifiants. Aucune connexion aux comptes transporteurs réels de l’entreprise n’a été effectuée. Les statuts réels ne peuvent donc pas être garantis pour tous les transporteurs à ce stade.

## Après déploiement

Vérifier une commande connue comme livrée, puis cliquer sur « Rafraîchir » dans son détail. Contrôler le numéro, le transporteur, le statut brut, la provenance et la date. En cas d’écart, relever la réponse de l’API transporteur ou ses champs de statut/événements en masquant les informations personnelles et les clés. Cela permettra d’adapter précisément les codes propres au contrat utilisé. Ne pas confondre livraison au point relais, remise au destinataire, retour à l’expéditeur et clôture de réclamation.

La centralisation des remboursements et autres données `localStorage`, ainsi que la migration de la persistance des sessions et brouillons vers un stockage durable, restent des chantiers distincts ; ils n’ont pas été modifiés dans cette correction.
