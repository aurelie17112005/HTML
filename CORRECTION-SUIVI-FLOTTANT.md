# Suivi flottant dans les conversations

Cette version repart de `HTML-main-suivi-chronopost-cchezvous-corrige.zip` et conserve les corrections Chronopost / C Chez Vous, ainsi que les autres corrections précédentes. Aucun adaptateur, endpoint, modèle de données, paramètre de récupération ou algorithme de statut n'a été modifié.

## Modifications

- Le suivi est déplacé hors de `#dBody` vers `#dTracking`, une zone ancrée entre l'en-tête de la conversation et les messages. Il reste visible quand les messages défilent.
- Le résumé affiche le transporteur, le numéro copiable, le statut, sa provenance, la date de vérification et le lien vers le transporteur lorsqu'il existe.
- L'historique et les détails techniques sont repliables. Ouverts, ils défilent dans la zone de suivi, dont la hauteur est limitée afin de préserver l'accès aux messages et au formulaire de réponse.
- Le bouton de rafraîchissement actualise seulement le suivi de la conversation ouverte, sans effacer le texte saisi, les pièces jointes préparées ni la position des messages.
- Le chargement du détail distant conserve le brouillon, l'état déplié du suivi et le scroll vers le dernier message. Une réponse tardive d'une ancienne conversation ne remplace plus la conversation courante.
- L'ouverture d'une autre conversation remet l'historique en mode compact. Une conversation sans suivi affiche une indication dans le même emplacement.
- La mise en page est adaptée aux fenêtres de faible hauteur et aux écrans mobiles.

Fichiers modifiés : `index.html` et `reclamations-marketplaces.html` (identiques). Aucune nouvelle dépendance n'est nécessaire.

## Vérifications

`npm run check` et les 99 tests existants passent. Le JavaScript des deux pages est valide. Un essai navigateur isolé, avec données fictives et sans connexion à des API réelles, a validé les résolutions 1280×900, 960×600, 390×844 et 390×600. Les scénarios vérifiés couvrent le scroll au dernier message, le suivi ancré, l'historique dépliable, le rafraîchissement, la conservation d'un brouillon pendant le chargement distant, le changement de conversation et l'absence de suivi. Un problème de timing de l'ouverture de l'historique a été détecté et corrigé pendant ces essais.

Ces tests portent sur l'interface. Ils ne constituent pas une validation des statuts réels des transporteurs.

## Installation

Remplacez les fichiers du projet avec le contenu de l'archive, en conservant vos variables d'environnement et vos données persistantes. Pour une installation propre : `npm ci`, puis `npm start`. Pour un déploiement Render connecté à GitHub, publiez les fichiers modifiés sur le dépôt et laissez Render effectuer son déploiement habituel. Aucun changement de base de données n'est requis.
