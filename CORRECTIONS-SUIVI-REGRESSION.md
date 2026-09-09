# Correction de la régression « statut non vérifié »

Cette archive reprend `HTML-main-suivi-fiabilise-2026-09-08.zip` et conserve les corrections précédentes (chargement, scroll, authentification, sécurité, etc.). Elle corrige le fait que des informations de livraison déjà présentes étaient remplacées par un état inconnu. Aucun identifiant, fichier de session ni donnée de production n'est inclus.

## Modifications

- `lib/tracking-status.js` : lecture des codes et libellés de statut, y compris les objets API et les champs `statusRaw`. Un code inconnu n'empêche plus d'utiliser un libellé reconnu. Les événements sont triés par date, et un statut inconnu ne remplace pas automatiquement un statut connu du même colis.
- `proxy-exemple.js` : priorité aux champs de livraison (`tracking_status`, `delivery_status`, `shipment_status`, `shipping_status` et variantes camelCase). Les statuts génériques de commande ou de réclamation ne sont plus confondus avec une confirmation de livraison. Les enrichissements Octopia, Mirakl et BOMP conservent leurs informations de suivi.
- `index.html` et `reclamations-marketplaces.html` : affichage du statut marketplace disponible même sans API transporteur. Le statut brut est conservé et visible dans le détail et dans l'infobulle du tableau. Un libellé inconnu utile reste affiché au lieu d'être systématiquement remplacé par « non vérifié ». Les statuts connus sont conservés pendant les rechargements de la liste lorsque le numéro de colis est identique.
- La provenance distingue désormais le transporteur, la marketplace et le simple état de commande. « Expédié (commande) » ne constitue pas une preuve de remise au destinataire. Les statuts de paiement ou de clôture de réclamation ne sont pas des statuts de livraison.
- `tests/tracking-regression.test.js` : 14 nouveaux tests couvrant les régressions observées, l'extraction des commandes, le rendu et la conservation du suivi au rechargement.

## Limites importantes

Cette correction restaure et fiabilise les données disponibles, mais ne crée pas de connexion transporteur. Les identifiants Octopia, Mirakl ou BOMP ne donnent pas automatiquement accès aux API DPD, GLS, ChezVous, etc. Les connexions disponibles et leurs variables sont décrites dans `CORRECTIONS-SUIVI-2026-09-08.md`.

Si une marketplace ne fournit que le numéro de suivi et un statut de commande, le site ne peut pas connaître une livraison réalisée plus tard chez le transporteur. Il affiche alors l'information dont il dispose avec sa provenance. Aucun scraping de pages transporteurs ni statut fictif n'a été ajouté. Une commande comportant plusieurs colis ne doit pas être considérée comme entièrement livrée sur la seule base d'un autre numéro de colis.

## Installation et vérification

Sauvegarder le projet et conserver les variables d'environnement Render ainsi que les données persistantes. Remplacer uniquement le code source ; ne pas supprimer un volume de données, les sessions ou les brouillons existants.

```bash
npm ci
npm run check
npm test
npm start
```

`node_modules` n'est pas inclus : `npm ci` reconstruit les dépendances à partir de `package-lock.json`. Après déploiement, recharger la page puis demander un rafraîchissement des réclamations. Les caches serveur étant en mémoire, un redémarrage peut nécessiter un nouveau chargement.

Validation effectuée : 61 tests automatisés réussis, contrôles syntaxiques du backend et des deux blocs JavaScript frontend, pages HTML synchronisées. Les tests utilisent des données fictives et des réponses API simulées ; aucune connexion aux comptes réels de l'entreprise n'a été effectuée.

Si un statut reste incorrect, comparer pour une commande concernée le numéro de suivi, le statut brut et la provenance dans le détail du site, puis la réponse réelle de l'API marketplace/transporteur. Une réponse anonymisée, sans clé, jeton, nom, adresse, téléphone ni autre donnée personnelle, permettra d'adapter précisément les champs ou codes manquants. Un simple lien de suivi ne suffit pas à confirmer la livraison.
