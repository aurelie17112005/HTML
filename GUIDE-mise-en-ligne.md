# Mettre le tableau de bord en ligne (FTP / OVH) + modifications futures

Le tableau de bord est un **fichier unique** : `index.html`. Il suffit de le déposer sur votre
hébergement. Voici la marche à suivre, la protection par mot de passe, et le circuit pour
continuer à le faire évoluer.

---

## 1. Déposer le site par FTP

**Ce qu'il vous faut** : vos identifiants FTP (fournis par OVH dans l'espace client →
Hébergements → FTP-SSH), et un logiciel FTP gratuit comme **FileZilla**.

1. Ouvrez FileZilla et connectez-vous :
   - Hôte : `ftp.cluster0XX.hosting.ovh.net` (ou l'hôte indiqué par OVH)
   - Identifiant / Mot de passe : ceux de votre compte FTP
   - Port : 21
2. À droite (serveur), entrez dans le dossier **`www`** (c'est la racine publique du site).
3. (Optionnel mais conseillé) créez un sous-dossier, par ex. `sav`, pour avoir l'URL
   `https://votre-domaine.fr/sav/`.
4. Glissez-déposez les fichiers suivants depuis votre dossier vers ce dossier :
   - `index.html`  (le tableau de bord)
   - `.htaccess`   (protection par mot de passe — voir étape 2)
   - `.htpasswd`   (à créer — voir étape 2)
5. Ouvrez `https://votre-domaine.fr/` (ou `/sav/`) : le tableau de bord s'affiche.

> Astuce : si les fichiers commençant par un point (`.htaccess`) n'apparaissent pas dans
> FileZilla, activez « Forcer l'affichage des fichiers cachés » (menu Serveur).

---

## 2. Protéger l'accès par mot de passe (important : données clients)

La page affiche des données clients : protégez-la. Deux façons :

**A. Via l'espace OVH (le plus simple)** — OVH propose un outil « Répertoires protégés » /
« .htaccess & .htpasswd » dans la gestion de l'hébergement : indiquez le dossier (`www/sav`),
créez un utilisateur + mot de passe, OVH génère tout. Dans ce cas, pas besoin des fichiers ci-dessous.

**B. Manuellement** avec les fichiers fournis :
1. Ouvrez `.htaccess` et remplacez `VOTRE_LOGIN` par votre login d'hébergement
   (le chemin doit pointer vers le `.htpasswd`, ex. `/home/monlogin/www/sav/.htpasswd`).
2. Créez le fichier **`.htpasswd`** contenant `utilisateur:motdepasse_chiffré`.
   Générez la ligne avec un outil en ligne « htpasswd generator » (chiffrement bcrypt ou APR1),
   ou en local : `htpasswd -c .htpasswd sandy` puis `htpasswd .htpasswd guillaume`.
   Exemple de contenu (mot de passe à régénérer, ne pas réutiliser celui-ci) :
   ```
   sandy:$apr1$xxxxxxxx$xxxxxxxxxxxxxxxxxxxxxx
   ```
3. Déposez `.htaccess` et `.htpasswd` dans le même dossier que `index.html`.

---

## 3. Faire des modifications ensuite (avec moi)

Le circuit ne change pas :
1. Vous me demandez une modification.
2. Je modifie le fichier ici et je vous le represente.
3. Vous **re-déposez `index.html`** par FTP (il écrase l'ancien) → c'est en ligne.
4. Videz le cache du navigateur (Ctrl/Cmd+Shift+R) pour voir la nouvelle version.

C'est tout : on peut itérer autant de fois que nécessaire.

---

## 4. À savoir (limites de la version en ligne actuelle)

- **Données = démonstration.** Les réclamations affichées sont des exemples. Pour les vraies
  données, il faudra brancher le proxy (`proxy-exemple.js`) sur un hébergement Node — voir
  `GUIDE-branchement-marketplaces.md`.
- **États non partagés entre postes.** Les actions cochées (Note OK, retraits EAN, remboursements,
  niveaux ajustés, validations Claude…) sont enregistrées **dans le navigateur** de chaque poste.
  Sandy et Guillaume ne verront pas les mêmes coches sur des ordinateurs différents. Pour un suivi
  partagé en temps réel, il faudra une base de données côté serveur (à prévoir avec le proxy).
- **HTTPS** : assurez-vous que votre domaine est en https (OVH propose un certificat SSL gratuit
  Let's Encrypt à activer dans l'espace client).
