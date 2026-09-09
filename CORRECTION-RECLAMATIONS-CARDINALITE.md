# Correction du nombre de réclamations — 2026-09-08

## Cause principale identifiée

L'adaptateur Octopia récupérait désormais jusqu'à 20 pages de discussions, puis attendait l'enrichissement de toutes les commandes (client, produit, EAN, suivi) avant de rendre le fournisseur. Lorsque cette phase dépassait le timeout fournisseur, l'ensemble du résultat Octopia/Cdiscount était rejeté, même si les discussions avaient déjà été récupérées.

## Corrections

- Cdiscount/Octopia conserve toujours la liste des discussions récupérées même si l'enrichissement commandes est lent ou échoue.
- L'enrichissement commandes est limité par défaut aux 40 discussions les plus récentes à enrichir.
- Timeout individuel d'enrichissement : 6 s par commande par défaut.
- Budget global d'enrichissement Octopia : 20 s par défaut ; au-delà, les discussions restent affichées sans attendre les champs secondaires.
- Les discussions Octopia ouvertes sans LastMessage exploitable ne sont plus supprimées comme faux négatifs.
- La fenêtre par défaut du mode « à répondre » passe de 45 à 90 jours.

## Variables configurables

- `OCTOPIA_ORDER_ENRICH_MAX` (défaut 40)
- `OCTOPIA_ORDER_ENRICH_TIMEOUT_MS` (défaut 6000)
- `OCTOPIA_ORDER_ENRICH_BUDGET_MS` (défaut 20000)
- `RECLAMATIONS_MAX_AGE_DAYS` (défaut 90 en mode à répondre)

## Important

Les champs d'enrichissement (EAN, produit, suivi) sont secondaires : leur indisponibilité ne doit plus masquer une réclamation Cdiscount.
