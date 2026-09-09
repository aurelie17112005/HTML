# Correction du statut `Received` — Fnac / Darty

Date : 2026-09-08

## Problème
Certaines commandes Fnac/Darty disposaient d'un numéro de suivi et remontaient le statut brut `Received`, mais l'interface affichait ce statut comme non reconnu au lieu de `Livré`.

## Cause
La normalisation générale refusait volontairement d'assimiler le mot anglais `Received` à une livraison, car chez certains transporteurs il peut signifier que le colis a simplement été reçu par le réseau logistique.

Pour Fnac/Darty (flux BOMP), `Received` correspond toutefois à l'état de réception de la commande côté marketplace.

## Correction
- Le backend BOMP reconnaît maintenant `Received` comme une réception confirmée et normalise le suivi en `livre`.
- Le statut conserve la provenance `marketplace` : il n'est pas présenté comme un statut vérifié directement auprès du transporteur.
- Le frontend possède le même garde-fou afin qu'une ancienne réponse serveur contenant `statusRaw: Received` soit également affichée correctement.
- La règle est strictement limitée aux marketplaces `fnac` et `darty`.
- Pour les autres marketplaces/transporteurs, `Received` n'est pas automatiquement considéré comme une livraison.

## Validation
- 85 tests automatisés passent.
- `npm run check` passe.
- Le JavaScript inline des deux pages HTML passe `node --check`.
- `index.html` et `reclamations-marketplaces.html` sont synchronisés.
